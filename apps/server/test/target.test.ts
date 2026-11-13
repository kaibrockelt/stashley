// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  CatalogSnapshot,
  Connection,
  ConnectionTestResult,
  ProblemDocument,
  Relation,
  SchemaDrift,
  TableAccess,
  TableOp,
} from '@stashley/shared'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/app.ts'
import { systemActor } from '../src/modules/audit/audit-log.ts'
import { encodeValue } from '../src/target/encoding.ts'
import { TestClient } from '../src/test/client.ts'
import { testConfig } from '../src/test/helpers.ts'

/**
 * Integration tests against real MariaDB and MySQL servers (architecture §26). Each target is
 * `name=mysql://root:password@host:port`, comma-separated in STASHLEY_TEST_TARGETS. CI runs
 * them in a job container, so the self-connection guard stays on. On a developer machine
 * with published ports, STASHLEY_TEST_ALLOW_LOOPBACK=1 relaxes it for the test server only.
 */
const targets = (process.env.STASHLEY_TEST_TARGETS ?? '')
  .split(',')
  .filter((entry) => entry.trim() !== '')
  .map((entry) => {
    const [name = '', url = ''] = entry.split('=')
    return { name, url: new URL(url) }
  })
const allowLoopback = process.env.STASHLEY_TEST_ALLOW_LOOPBACK === '1'
const fixtures = path.join(import.meta.dirname, 'fixtures', 'wanderverein')
const adminEmail = 'admin@example.com'
const adminPassword = 'correct horse battery staple'

const ceilings: Record<string, TableOp[]> = {
  person: ['read', 'create', 'update'],
  event: ['read', 'create', 'update'],
  hotel: ['read', 'create', 'update'],
  hotel_kontingent: ['read', 'create', 'update'],
  station: ['read', 'create', 'update'],
  anmeldung: ['read', 'create', 'update'],
  hotelbuchung: ['read', 'create', 'update', 'delete'],
  zahlung: ['read', 'create', 'update'],
  checkin: ['read', 'create', 'delete'],
  stempel: ['read', 'create', 'delete'],
  ehrung: ['read', 'create'],
}
const viewKeys: Record<string, string | null> = {
  v_teilnahmen: 'person_id',
  v_zahlungsstatus: 'anmeldung_id',
  v_streckenlage: 'anmeldung_id',
  v_medaille: null,
}
const mcpObjects = new Set([
  'v_zahlungsstatus',
  'v_streckenlage',
  'event',
  'station',
  'anmeldung',
  'person',
])

async function rootConnection(url: URL) {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      return await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        multipleStatements: true,
      })
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

describe.skipIf(targets.length === 0).each(targets)('target database $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection
  const host = url.hostname
  const port = Number(url.port || 3306)

  const input = (overrides: Record<string, unknown> = {}) => ({
    name: 'Wanderverein',
    host,
    port,
    databaseName: 'wanderverein',
    tls: { mode: 'disabled', caPem: null, serverName: null },
    timezone: 'Europe/Berlin',
    queryTimeoutSeconds: 30,
    credentials: {
      read: { username: 'stashley_read', password: 'demo-read-password' },
      write: { username: 'stashley_write', password: 'demo-write-password' },
      schema: { username: 'stashley_schema', password: 'demo-schema-password' },
    },
    ...overrides,
  })

  beforeAll(async () => {
    root = await rootConnection(url)
    await root.query('DROP DATABASE IF EXISTS wanderverein')
    await root.query('CREATE DATABASE wanderverein CHARACTER SET utf8mb4')
    await root.query('USE wanderverein')
    await root.query(readFileSync(path.join(fixtures, 'schema.sql'), 'utf8'))
    await root.query(readFileSync(path.join(fixtures, 'users.sql'), 'utf8'))
    server = await createServer(
      testConfig({ INITIAL_ADMIN_EMAIL: adminEmail, INITIAL_ADMIN_PASSWORD: adminPassword }),
      {
        quiet: true,
        listen: false,
        ...(allowLoopback && {
          overrides: { resolveTargetHost: (name: string) => Promise.resolve(name) },
        }),
      },
    )
    await server.start()
    admin = new TestClient(server.app)
    expect((await admin.login(adminEmail, adminPassword)).statusCode).toBe(200)
  }, 120_000)

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('rejects wrong passwords with a reason per database user', async () => {
    const response = await admin.send(
      'POST',
      '/internal/admin/connections/test',
      input({
        credentials: {
          read: { username: 'stashley_read', password: 'wrong' },
          write: null,
          schema: { username: 'stashley_schema', password: 'demo-schema-password' },
        },
      }),
    )
    expect(response.statusCode).toBe(422)
    expect(problem(response)).toMatchObject({
      code: 'connection_failed',
      errors: [{ field: 'credentials.read', code: 'access_denied' }],
    })
  })

  it.skipIf(allowLoopback)('refuses connections to Stashley itself', async () => {
    for (const host of ['localhost', '::ffff:7f00:1']) {
      const response = await admin.send('POST', '/internal/admin/connections/test', input({ host }))
      expect(problem(response).errors, host).toEqual(
        expect.arrayContaining([{ field: 'credentials.read', code: 'host_not_allowed' }]),
      )
    }
  })

  it('warns about the over-privileged user', async () => {
    const response = await admin.send(
      'POST',
      '/internal/admin/connections/test',
      input({
        credentials: {
          read: { username: 'stashley_zuviel', password: 'demo-zuviel-password' },
          write: null,
          schema: null,
        },
      }),
    )
    expect(response.statusCode).toBe(200)
    const [report] = response.json<ConnectionTestResult>().grants
    const warnings = (report?.warnings ?? []).map((w) => `${w.code}:${w.privilege ?? ''}`)
    expect(warnings).toEqual(
      expect.arrayContaining([
        'global_privilege:FILE',
        'global_privilege:PROCESS',
        'excess_privilege:INSERT',
        'excess_privilege:DELETE',
        'excess_privilege:DROP',
        'excess_privilege:ALTER',
        'other_schema:SELECT',
      ]),
    )
    expect(report?.missing).toEqual([])
  })

  it('saves a connection with minimal grants and reads its schema', async () => {
    const response = await admin.send('POST', '/internal/admin/connections', input())
    expect(response.statusCode).toBe(201)
    connection = response.json<Connection>()
    expect(connection.versionSupported).toBe(true)
    expect(connection.schemaCapturedAt).not.toBeNull()
    for (const credential of connection.credentials) {
      expect(credential.grants?.missing, credential.purpose).toEqual([])
      expect(credential.grants?.warnings, credential.purpose).toEqual([])
    }
    // Passwords never leave the server.
    expect(JSON.stringify(connection)).not.toContain('demo-read-password')

    const schema = (
      await admin.request('GET', `/internal/admin/connections/${connection.id}/schema`)
    ).json<CatalogSnapshot>()
    const objects = new Map(schema.objects.map((object) => [object.name, object]))
    expect([...objects.keys()].sort()).toEqual(
      [...Object.keys(ceilings), ...Object.keys(viewKeys)].sort(),
    )
    const anmeldung = objects.get('anmeldung')
    expect(anmeldung?.primaryKey).toEqual(['id'])
    expect(anmeldung?.uniqueKeys).toEqual(
      expect.arrayContaining([
        ['event_id', 'person_id'],
        ['event_id', 'startnummer'],
      ]),
    )
    expect(
      anmeldung?.foreignKeys.map((fk) => `${fk.columns[0]}→${fk.targetObject}`).sort(),
    ).toEqual(['event_id→event', 'person_id→person'])
    expect(anmeldung?.columns.find((c) => c.name === 'ticket_typ')).toMatchObject({
      kind: 'enum',
      enumValues: ['standard', 'ermaessigt', 'helfer'],
    })
    expect(objects.get('station')?.columns.find((c) => c.name === 'ist_ziel')?.kind).toBe('boolean')
    expect(objects.get('person')?.columns.find((c) => c.name === 'id')).toMatchObject({
      kind: 'bigint',
      autoIncrement: true,
    })
    const status = objects.get('v_zahlungsstatus')
    expect(status?.type).toBe('view')
    expect(status?.baseTables).toEqual(['anmeldung', 'hotelbuchung', 'zahlung'])
    expect(status?.keyCandidates).toContain('anmeldung_id')
    expect(objects.get('v_medaille')?.baseTables).toEqual([
      'anmeldung',
      'checkin',
      'ehrung',
      'event',
    ])
  })

  it('uses stored passwords only for the server they were saved for', async () => {
    const keep = {
      read: { username: 'stashley_read' },
      write: { username: 'stashley_write' },
      schema: { username: 'stashley_schema' },
    }
    const same = await admin.send('POST', '/internal/admin/connections/test', {
      ...input({ credentials: keep }),
      connectionId: connection.id,
    })
    expect(same.statusCode).toBe(200)
    const moved = await admin.send('POST', '/internal/admin/connections/test', {
      ...input({ port: port + 1, credentials: keep }),
      connectionId: connection.id,
    })
    expect(problem(moved).errors).toEqual([
      { field: 'credentials.read.password', code: 'required' },
      { field: 'credentials.write.password', code: 'required' },
      { field: 'credentials.schema.password', code: 'required' },
    ])
  })

  it('reads privileges of roles, whether active at sign-in or not', async () => {
    const mariadb = connection.engine === 'mariadb'
    const account = "'stashley_rollen'@'%'"
    const roles = ['stashley_r_def', 'stashley_r_nest', 'stashley_r_other']
    await root.query(`DROP USER IF EXISTS ${account}`)
    for (const role of roles) {
      await root.query(`DROP ROLE IF EXISTS ${role}`)
      await root.query(`CREATE ROLE ${role}`)
    }
    try {
      // The default role carries the read privileges and, through a nested role, DROP.
      // The other role is granted but not active at sign-in.
      await root.query('GRANT SELECT, SHOW VIEW ON wanderverein.* TO stashley_r_def')
      await root.query('GRANT DROP ON wanderverein.* TO stashley_r_nest')
      await root.query('GRANT stashley_r_nest TO stashley_r_def')
      await root.query('GRANT DELETE ON wanderverein.* TO stashley_r_other')
      await root.query(`CREATE USER ${account} IDENTIFIED BY 'demo-rollen-password'`)
      await root.query(`GRANT stashley_r_def TO ${account}`)
      await root.query(`GRANT stashley_r_other TO ${account}`)
      await root.query(`SET DEFAULT ROLE stashley_r_def ${mariadb ? 'FOR' : 'TO'} ${account}`)
      const response = await admin.send(
        'POST',
        '/internal/admin/connections/test',
        input({
          credentials: {
            read: { username: 'stashley_rollen', password: 'demo-rollen-password' },
            write: null,
            schema: null,
          },
        }),
      )
      expect(response.statusCode).toBe(200)
      const [report] = response.json<ConnectionTestResult>().grants
      const other = mariadb ? 'stashley_r_other' : 'stashley_r_other@%'
      expect(report?.missing).toEqual([])
      // In effect: the default role and its nested role, not the inactive one.
      expect(report?.schemaPrivileges).toEqual(['DROP', 'SELECT', 'SHOW VIEW'])
      const warnings = (report?.warnings ?? []).map(
        (w) => `${w.code}:${w.privilege ?? ''}:${w.scope}`,
      )
      expect(warnings).toEqual(
        expect.arrayContaining([
          'excess_privilege:DROP:wanderverein.*',
          'excess_privilege:DELETE:wanderverein.*',
          `inactive_role::${other}`,
        ]),
      )
      expect(warnings.filter((w) => w.startsWith('role_unreadable'))).toEqual([])
    } finally {
      await root.query(`DROP USER IF EXISTS ${account}`)
      for (const role of roles) await root.query(`DROP ROLE IF EXISTS ${role}`)
    }
  })

  it('warns about a global grant option behind the authentication clause', async () => {
    const account = "'stashley_weitergabe'@'%'"
    await root.query(`DROP USER IF EXISTS ${account}`)
    await root.query(`CREATE USER ${account} IDENTIFIED BY 'demo-weitergabe-password'`)
    try {
      await root.query(`GRANT SELECT, SHOW VIEW ON wanderverein.* TO ${account}`)
      await root.query(`GRANT USAGE ON *.* TO ${account} WITH GRANT OPTION`)
      const response = await admin.send(
        'POST',
        '/internal/admin/connections/test',
        input({
          credentials: {
            read: { username: 'stashley_weitergabe', password: 'demo-weitergabe-password' },
            write: null,
            schema: null,
          },
        }),
      )
      const [report] = response.json<ConnectionTestResult>().grants
      expect(report?.warnings).toEqual([{ code: 'grant_option', scope: '*.*' }])
    } finally {
      await root.query(`DROP USER IF EXISTS ${account}`)
    }
  })

  it('counts privileges granted to PUBLIC (MariaDB 11.1 and later)', async () => {
    const [major = 0, minor = 0] = (connection.serverVersion ?? '').split('.').map(Number)
    if (connection.engine !== 'mariadb' || major * 100 + minor < 1101) return
    await root.query('GRANT SELECT ON mysql.* TO PUBLIC')
    try {
      const response = await admin.send(
        'POST',
        '/internal/admin/connections/test',
        input({
          credentials: {
            read: { username: 'stashley_read', password: 'demo-read-password' },
            write: null,
            schema: null,
          },
        }),
      )
      const [report] = response.json<ConnectionTestResult>().grants
      expect(report?.warnings).toEqual(
        expect.arrayContaining([{ code: 'other_schema', privilege: 'SELECT', scope: 'mysql.*' }]),
      )
    } finally {
      await root.query('REVOKE SELECT ON mysql.* FROM PUBLIC')
    }
  })

  it('connects over TLS and verifies certificates when asked', async () => {
    // The MySQL images ship a self-signed certificate; the MariaDB images have none.
    if (connection.engine !== 'mysql') return
    const tls = (mode: string) =>
      admin.send(
        'POST',
        '/internal/admin/connections/test',
        input({ tls: { mode, caPem: null, serverName: null } }),
      )
    expect((await tls('required')).statusCode).toBe(200)
    expect(problem(await tls('verify-full')).errors).toEqual(
      expect.arrayContaining([{ field: 'credentials.read', code: 'tls_failed' }]),
    )
  })

  it('exposes the whole scenario with its ceilings', async () => {
    const order = [
      'person',
      'event',
      ...Object.keys(ceilings).filter((name) => name !== 'person' && name !== 'event'),
    ]
    for (const objectName of [...order, ...Object.keys(viewKeys)]) {
      const response = await admin.send('POST', '/internal/admin/table-access', {
        connectionId: connection.id,
        objectName,
        ops: ceilings[objectName] ?? ['read'],
        keyColumn: viewKeys[objectName] ?? null,
        displayTemplate:
          objectName === 'anmeldung' ? '{startnummer} – {person.vorname} {person.nachname}' : null,
        apiResource: null,
        mcpEnabled: mcpObjects.has(objectName),
        exclusions:
          objectName === 'person'
            ? [
                { column: 'email', scope: 'mcp' },
                { column: 'telefon', scope: 'mcp' },
              ]
            : [],
      })
      expect(response.statusCode, `${objectName}: ${response.body}`).toBe(201)
    }
    const list = (
      await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
    ).json<{ data: TableAccess[] }>().data
    expect(list).toHaveLength(15)
    for (const access of list) {
      // The demo users' grants cover every ceiling.
      expect(
        access.ops.filter((op) => !access.grantedOps.includes(op)),
        access.objectName,
      ).toEqual([])
      const codes = access.warnings.map((warning) => warning.code)
      expect(codes, access.objectName).toEqual(
        access.objectName === 'v_medaille' ? ['view_without_key'] : [],
      )
    }
    expect(list.find((access) => access.objectName === 'person')?.effectiveTemplate).toBe(
      '{vorname}',
    )

    const view = await admin.send('POST', '/internal/admin/table-access', {
      connectionId: connection.id,
      objectName: 'v_teilnahmen',
      ops: ['read'],
      keyColumn: null,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: [],
    })
    expect(problem(view).errors).toEqual([{ field: 'objectName', code: 'taken' }])
  })

  it('adds a one-to-one relation into a view', async () => {
    const response = await admin.send('POST', '/internal/admin/relations', {
      connectionId: connection.id,
      sourceObject: 'anmeldung',
      sourceColumn: 'id',
      targetObject: 'v_zahlungsstatus',
      targetColumn: 'anmeldung_id',
      kind: 'one_to_one',
    })
    expect(response.statusCode).toBe(201)
    const relations = (
      await admin.request('GET', `/internal/admin/relations?connectionId=${connection.id}`)
    ).json<{ data: Relation[] }>().data
    expect(relations.filter((relation) => relation.origin === 'constraint')).toHaveLength(13)
    expect(relations.filter((relation) => relation.origin === 'virtual')).toHaveLength(1)
  })

  it('records schema drift with its impact', async () => {
    await root.query('ALTER TABLE wanderverein.person ADD COLUMN spitzname VARCHAR(40) NULL')
    await root.query('ALTER TABLE wanderverein.person DROP COLUMN telefon')
    await server.services.catalog.checkAll()
    const drifts = (
      await admin.request('GET', `/internal/admin/connections/${connection.id}/schema/drifts`)
    ).json<{ data: SchemaDrift[] }>().data
    expect(drifts).toHaveLength(1)
    const [drift] = drifts
    expect(drift?.diff.changedObjects).toEqual([
      expect.objectContaining({
        object: 'person',
        addedColumns: ['spitzname'],
        removedColumns: ['telefon'],
      }),
    ])
    expect(drift?.impact.map(({ kind, label, reason }) => ({ kind, label, reason }))).toEqual([
      { kind: 'column_exclusion', label: 'person.telefon', reason: 'column_removed' },
    ])
    expect(
      (
        await admin.request('GET', `/internal/admin/connections/${connection.id}`)
      ).json<Connection>().openDrifts,
    ).toBe(1)
    const ack = await admin.send(
      'POST',
      `/internal/admin/connections/${connection.id}/schema/drifts/${drift?.id ?? ''}/acknowledge`,
    )
    expect(ack.statusCode).toBe(204)
  })

  it('marks access whose object the read user can no longer see', async () => {
    await root.query('CREATE TABLE wanderverein.notiz (id BIGINT PRIMARY KEY, text VARCHAR(80))')
    await admin.send('POST', `/internal/admin/connections/${connection.id}/schema/refresh`)
    const exposed = await admin.send('POST', '/internal/admin/table-access', {
      connectionId: connection.id,
      objectName: 'notiz',
      ops: ['read'],
      keyColumn: null,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: [],
    })
    expect(exposed.statusCode).toBe(201)
    await root.query('DROP TABLE wanderverein.notiz')
    const refresh = await admin.send(
      'POST',
      `/internal/admin/connections/${connection.id}/schema/refresh`,
    )
    expect(refresh.json<{ diff: { removedObjects: string[] } }>().diff.removedObjects).toEqual([
      'notiz',
    ])
    const list = (
      await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
    ).json<{ data: TableAccess[] }>().data
    const notiz = list.find((access) => access.objectName === 'notiz')
    expect(notiz?.state).toBe('pending_grants')
    expect(notiz?.warnings.map((warning) => warning.code)).toContain('not_in_schema')
  })

  it('marks generated columns and ON UPDATE alike on both engines', async () => {
    await root.query(
      'ALTER TABLE wanderverein.event ADD COLUMN jahr_folge INT GENERATED ALWAYS AS (jahr + 1) VIRTUAL',
    )
    try {
      const schema = (
        await admin.send('POST', `/internal/admin/connections/${connection.id}/schema/refresh`)
      ).statusCode
      expect(schema).toBe(200)
      const objects = (
        await admin.request('GET', `/internal/admin/connections/${connection.id}/schema`)
      ).json<CatalogSnapshot>().objects
      const columnOf = (object: string, name: string) =>
        objects.find((entry) => entry.name === object)?.columns.find((c) => c.name === name)
      // MySQL reports `DEFAULT CURRENT_TIMESTAMP` as DEFAULT_GENERATED; it stays writable.
      expect(columnOf('person', 'created_at')).toMatchObject({ generated: false, onUpdate: null })
      const updatedAt = columnOf('person', 'updated_at')
      expect(updatedAt?.generated).toBe(false)
      expect(updatedAt?.onUpdate).toMatch(/^current_timestamp/i)
      expect(columnOf('event', 'jahr_folge')).toMatchObject({ generated: true, onUpdate: null })
    } finally {
      await root.query('ALTER TABLE wanderverein.event DROP COLUMN jahr_folge')
    }
  })

  it('returns JSON values as their raw text', async () => {
    await root.query('CREATE TABLE wanderverein.notiz_json (id BIGINT PRIMARY KEY, daten JSON)')
    try {
      await root.query(
        `INSERT INTO wanderverein.notiz_json VALUES (1, '{"a": 1, "b": [1, 2], "c": "x"}')`,
      )
      const rows = await server.services.connections.withReader(connection.id, (session) =>
        session.query<{ daten: string }>('SELECT daten FROM notiz_json'),
      )
      const raw = rows[0]?.daten
      expect(typeof raw).toBe('string')
      const { value } = encodeValue('json', raw, 'UTC')
      expect(typeof value).toBe('string')
      expect(JSON.parse(String(value))).toEqual({ a: 1, b: [1, 2], c: 'x' })
    } finally {
      await root.query('DROP TABLE wanderverein.notiz_json')
    }
  })

  it('follows a table that became a view and drops its write ceiling', async () => {
    await root.query('CREATE TABLE wanderverein.tausch (id BIGINT PRIMARY KEY, x VARCHAR(10))')
    try {
      await admin.send('POST', `/internal/admin/connections/${connection.id}/schema/refresh`)
      const exposed = await admin.send('POST', '/internal/admin/table-access', {
        connectionId: connection.id,
        objectName: 'tausch',
        ops: ['read', 'create', 'update', 'delete'],
        keyColumn: null,
        displayTemplate: null,
        apiResource: null,
        mcpEnabled: false,
        exclusions: [],
      })
      expect(exposed.statusCode).toBe(201)
      await root.query('DROP TABLE wanderverein.tausch')
      await root.query(
        'CREATE VIEW wanderverein.tausch AS SELECT id, CAST(startnummer AS CHAR) AS x FROM wanderverein.anmeldung',
      )
      const refresh = await admin.send(
        'POST',
        `/internal/admin/connections/${connection.id}/schema/refresh`,
      )
      expect(refresh.json<{ impact: { label: string; reason: string }[] }>().impact).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'tausch', reason: 'type_changed' }),
        ]),
      )
      const list = (
        await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
      ).json<{ data: TableAccess[] }>().data
      expect(list.find((access) => access.objectName === 'tausch')).toMatchObject({
        objectType: 'view',
        ops: ['read'],
        grantedOps: ['read'],
        state: 'active',
      })
      const audited = await server.store.db
        .selectFrom('audit_events')
        .select('changes')
        .where('action', '=', 'table_access.type_changed')
        .execute()
      expect(audited.map((row) => JSON.parse(row.changes ?? '{}') as unknown)).toEqual([
        {
          objectType: ['table', 'view'],
          ops: [['read', 'create', 'update', 'delete'], ['read']],
        },
      ])
    } finally {
      await root.query('DROP VIEW IF EXISTS wanderverein.tausch')
      await root.query('DROP TABLE IF EXISTS wanderverein.tausch')
    }
  })

  it('keeps an unacknowledged drift while old snapshots are pruned', async () => {
    await root.query('ALTER TABLE wanderverein.hotel ADD COLUMN drift_0 INT NULL')
    await server.services.catalog.checkAll()
    const open = () =>
      admin
        .request('GET', `/internal/admin/connections/${connection.id}/schema/drifts`)
        .then((response) =>
          response.json<{ data: SchemaDrift[] }>().data.filter((d) => d.acknowledgedAt === null),
        )
    const [drift] = await open()
    expect(
      drift?.diff.changedObjects.find((change) => change.object === 'hotel')?.addedColumns,
    ).toEqual(['drift_0'])
    // More structural changes than snapshots are kept (20).
    for (let index = 1; index <= 21; index += 1) {
      await root.query(`ALTER TABLE wanderverein.hotel ADD COLUMN drift_${index} INT NULL`)
      await server.services.catalog.refresh(systemActor, connection.id, 'manual')
    }
    expect((await open()).map((entry) => entry.id)).toEqual([drift?.id])
  })

  it('ignores prefix indexes and CTE names when reading keys and view tables', async () => {
    await root.query('ALTER TABLE wanderverein.hotel ADD UNIQUE KEY hotel_name_prefix (name(10))')
    await root.query(
      `CREATE VIEW wanderverein.v_cte AS
         WITH x AS (SELECT id, person_id FROM wanderverein.anmeldung)
         SELECT x.id, x.person_id FROM x`,
    )
    try {
      await server.services.catalog.refresh(systemActor, connection.id, 'manual')
      const objects = new Map(
        (await admin.request('GET', `/internal/admin/connections/${connection.id}/schema`))
          .json<CatalogSnapshot>()
          .objects.map((object) => [object.name, object]),
      )
      // A unique prefix does not make the whole column unique.
      expect(objects.get('hotel')?.uniqueKeys).toEqual([])
      expect(objects.get('v_cte')).toMatchObject({
        baseTables: ['anmeldung'],
        dependenciesKnown: true,
      })
      expect(objects.get('v_zahlungsstatus')?.dependenciesKnown).toBe(true)
    } finally {
      await root.query('DROP VIEW IF EXISTS wanderverein.v_cte')
      await root.query('ALTER TABLE wanderverein.hotel DROP INDEX hotel_name_prefix')
    }
  })

  it('keeps a connection that is still in use', async () => {
    const response = await admin.send('DELETE', `/internal/admin/connections/${connection.id}`)
    expect(problem(response).code).toBe('in_use')
  })
})
