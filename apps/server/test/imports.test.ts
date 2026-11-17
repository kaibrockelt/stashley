// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AuditEvent,
  ImportJob,
  ImportMapping,
  NewTableDefinition,
  NewTableOutcome,
  TableAccess,
} from '@stashley/shared'
import iconv from 'iconv-lite'
import type mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from '../src/app.ts'
import type { TestClient } from '../src/test/client.ts'
import {
  connectDemo,
  prepareDatabase,
  rootConnection,
  seedDemo,
  startServer,
  targets,
} from './support.ts'

/**
 * CSV import against real servers (§17): detection, a dry run that only reads, upserts by a
 * unique key, foreign keys resolved by unique columns and display values, all or nothing,
 * skipping failed rows, and the audit event.
 */
describe.skipIf(targets.length === 0).each(targets)('CSV import on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let access: Map<string, TableAccess>
  let connection: { id: string }

  const table = (name: string) => access.get(name) as TableAccess

  async function upload(content: string | Buffer, name: string): Promise<ImportJob> {
    const response = await admin.upload(`/internal/imports?fileName=${name}`, content)
    expect(response.statusCode, response.body).toBe(201)
    return response.json<ImportJob>()
  }

  async function configure(
    job: ImportJob,
    mapping: Omit<ImportMapping, 'tableAccessId'> & { table: string },
  ) {
    const { table: name, ...rest } = mapping
    const response = await admin.send('PUT', `/internal/imports/${job.id}`, {
      options: job.options,
      mapping: { ...rest, tableAccessId: table(name).id },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json<ImportJob>()
  }

  async function step(job: ImportJob, action: 'dry-run' | 'run'): Promise<ImportJob> {
    const started = await admin.send('POST', `/internal/imports/${job.id}/${action}`)
    expect(started.statusCode, started.body).toBe(200)
    await server.services.imports.settled()
    return (await admin.request('GET', `/internal/imports/${job.id}`)).json<ImportJob>()
  }

  const rows = async <T>(query: string, values: unknown[] = []) =>
    ((await root.query(query, values)) as unknown as [T[]])[0]

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    ;({ server, admin } = await startServer())
    ;({ access, connection } = await connectDemo(admin, url, {
      credentials: {
        read: { username: 'stashley_read', password: 'demo-read-password' },
        write: { username: 'stashley_write', password: 'demo-write-password' },
        schema: { username: 'stashley_schema', password: 'demo-schema-password' },
      },
    }))
  })

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('upserts people by e-mail from Windows-1252 with semicolons; the dry run reports faulty rows', async () => {
    const csv = iconv.encode(
      [
        'Vorname;Nachname;E-Mail;Land;Telefon',
        'Anna;Berg;anna@example.com;AT;',
        'Jürgen;Müller;juergen@example.com;DE;0171 2',
        'Zoë;Straße;zoe@example.com;DEU;',
        'Bernd;Doppelt;juergen@example.com;DE;',
        'Ben;Carstens;ben@example.com;DK;',
        'Anna;Zweite;anna2@example.com;DE;',
        '',
      ].join('\r\n'),
      'windows-1252',
    )
    let job = await upload(csv, 'personen.csv')
    expect(job.options).toMatchObject({ encoding: 'windows-1252', delimiter: ';', header: true })
    const columns = ['vorname', 'nachname', 'email', 'land', 'telefon'].map((target, source) => ({
      source,
      target,
    }))
    job = await configure(job, {
      table: 'person',
      mode: 'upsert',
      upsertKey: ['email'],
      columns,
      skipFailed: false,
    })
    job = await step(job, 'dry-run')
    expect(job.status).toBe('checked')
    expect(job.dryRun?.counts, JSON.stringify(job.dryRun?.errors)).toEqual({
      rows: 6,
      created: 2,
      updated: 1,
      unchanged: 1,
      failed: 2,
      skipped: 0,
    })
    expect(job.dryRun?.errors).toEqual([
      { line: 4, column: 'land', code: 'too_long', params: { max: 2 } },
      { line: 5, column: 'email', code: 'duplicate_in_file' },
    ])
    const list = await admin.request('GET', `/internal/imports/${job.id}/errors`)
    expect(list.headers['content-type']).toContain('text/csv')
    expect(list.body).toContain('4,land,too_long')
    // Nothing was written by the dry run.
    expect(await rows('SELECT land FROM person WHERE id = 1')).toEqual([{ land: 'DE' }])

    const refused = await admin.send('POST', `/internal/imports/${job.id}/run`)
    expect(refused.statusCode).toBe(422)

    // Skipping failed rows is a new setting and needs a new dry run.
    job = await configure(job, {
      table: 'person',
      mode: 'upsert',
      upsertKey: ['email'],
      columns,
      skipFailed: true,
    })
    expect(job.status).toBe('uploaded')
    expect((await admin.send('POST', `/internal/imports/${job.id}/run`)).statusCode).toBe(409)
    job = await step(job, 'dry-run')
    job = await step(job, 'run')
    expect(job.status, JSON.stringify(job.failure)).toBe('completed')
    expect(job.result).toMatchObject({ created: 2, updated: 1, unchanged: 1, skipped: 2 })
    expect(
      await rows('SELECT vorname, nachname FROM person WHERE email = ?', ['juergen@example.com']),
    ).toEqual([{ vorname: 'Jürgen', nachname: 'Müller' }])
    expect(await rows('SELECT land, telefon FROM person WHERE id = 1')).toEqual([
      { land: 'AT', telefon: null },
    ])
    expect(await rows("SELECT COUNT(*) AS n FROM person WHERE email = 'zoe@example.com'")).toEqual([
      { n: 0 },
    ])
    const audit = (
      await admin.request('GET', '/internal/admin/audit?action=import.completed')
    ).json<{ data: AuditEvent[] }>().data
    expect(audit[0]).toMatchObject({
      actorKind: 'user',
      subjectId: job.id,
      details: expect.objectContaining({
        fileSha256: job.sha256,
        mode: 'upsert',
        counts: expect.objectContaining({ created: 2, updated: 1, skipped: 2 }) as unknown,
      }) as unknown,
    })
  })

  it('resolves foreign keys by unique columns and display values', async () => {
    let job = await upload(
      [
        'E-Mail,Jahr,Art,Übergeben',
        'anna@example.com,2026,medaille_10,09.05.2026 15:00',
        'ben@example.com,2030,medaille_10,',
        'nobody@example.com,2026,MEDAILLE_10,',
      ].join('\n'),
      'ehrungen.csv',
    )
    expect(job.options).toMatchObject({ encoding: 'utf-8', delimiter: ',' })
    job = await configure(job, {
      table: 'ehrung',
      mode: 'insert',
      upsertKey: null,
      skipFailed: true,
      columns: [
        { source: 0, target: 'person_id', reference: { via: 'unique', column: 'email' } },
        { source: 1, target: 'event_id', reference: { via: 'unique', column: 'jahr' } },
        { source: 2, target: 'art' },
        { source: 3, target: 'uebergeben_am' },
      ],
    })
    job = await step(job, 'dry-run')
    expect(job.dryRun?.counts).toMatchObject({ rows: 3, created: 1, failed: 2 })
    expect(job.dryRun?.errors).toEqual([
      { line: 3, column: 'event_id', code: 'foreign_key_violation' },
      { line: 4, column: 'person_id', code: 'foreign_key_violation' },
    ])
    job = await step(job, 'run')
    expect(job.status).toBe('completed')
    expect(
      await rows(
        "SELECT person_id, event_id, art, DATE_FORMAT(uebergeben_am, '%Y-%m-%d %H:%i') AS am FROM ehrung",
      ),
      // 15:00 in APP_TIMEZONE (UTC here) is 17:00 in the connection's zone, Europe/Berlin (E25).
    ).toEqual([{ person_id: 1, event_id: 2, art: 'medaille_10', am: '2026-05-09 17:00' }])

    // Two people are called Anna now: the display value is ambiguous.
    let byName = await upload(
      'Person;Jahr;Art\nAnna;2026;medaille_10\nEva;2026;medaille_10\n',
      'namen.csv',
    )
    byName = await configure(byName, {
      table: 'ehrung',
      mode: 'insert',
      upsertKey: null,
      skipFailed: false,
      columns: [
        { source: 0, target: 'person_id', reference: { via: 'display' } },
        { source: 1, target: 'event_id', reference: { via: 'unique', column: 'jahr' } },
        { source: 2, target: 'art' },
      ],
    })
    byName = await step(byName, 'dry-run')
    expect(byName.dryRun?.errors).toEqual([
      { line: 2, column: 'person_id', code: 'ambiguous_reference' },
    ])
    expect(byName.dryRun?.counts).toMatchObject({ created: 1, failed: 1 })
  })

  it('writes all or nothing: a row the database refuses rolls the import back', async () => {
    let job = await upload(
      'vorname,nachname,email,land\nCarla,Neu,carla@example.com,IT\nDora,Neu,dora@example.com,IT\n',
      'neu.csv',
    )
    job = await configure(job, {
      table: 'person',
      mode: 'insert',
      upsertKey: null,
      skipFailed: false,
      columns: ['vorname', 'nachname', 'email', 'land'].map((target, source) => ({
        source,
        target,
      })),
    })
    job = await step(job, 'dry-run')
    expect(job.dryRun?.counts).toMatchObject({ created: 2, failed: 0 })
    // Between dry run and import someone else takes one of the e-mail addresses.
    await root.query(
      "INSERT INTO person (vorname, nachname, email, land) VALUES ('X', 'Y', 'dora@example.com', 'DE')",
    )
    job = await step(job, 'run')
    expect(job.status).toBe('failed')
    expect(job.failure).toMatchObject({
      code: 'import_stopped',
      errors: [expect.objectContaining({ code: 'unique_violation' }) as unknown],
    })
    expect(
      await rows("SELECT COUNT(*) AS n FROM person WHERE email = 'carla@example.com'"),
    ).toEqual([{ n: 0 }])
    const failed = (await admin.request('GET', '/internal/admin/audit?action=import.failed')).json<{
      data: AuditEvent[]
    }>().data
    expect(failed[0]?.subjectId).toBe(job.id)
  })

  it('compares keys as the database does, so the dry run predicts the import', async () => {
    const columns = ['vorname', 'nachname', 'email', 'land'].map((target, source) => ({
      source,
      target,
    }))
    const mapping = {
      table: 'person',
      mode: 'upsert' as const,
      upsertKey: ['email'],
      columns,
      skipFailed: true,
    }
    let job = await upload(
      [
        'vorname;nachname;email;land',
        'Eva;Berg;EVA@example.com;AT',
        'Neu;Eins;neu@example.com;DE',
        'Neu;Zwei;NEU@example.com;DE',
        '',
      ].join('\n'),
      'schreibweisen.csv',
    )
    job = await configure(job, mapping)
    job = await step(job, 'dry-run')
    // The default collations ignore case: EVA@ is Eva, NEU@ the same address twice.
    expect(job.dryRun?.counts).toEqual({
      rows: 3,
      created: 1,
      updated: 1,
      unchanged: 0,
      failed: 1,
      skipped: 0,
    })
    expect(job.dryRun?.errors).toEqual([{ line: 4, column: 'email', code: 'duplicate_in_file' }])
    job = await step(job, 'run')
    expect(job.status, JSON.stringify(job.failure)).toBe('completed')
    expect(await rows("SELECT land FROM person WHERE email = 'eva@example.com'")).toEqual([
      { land: 'AT' },
    ])
    expect(await rows("SELECT COUNT(*) AS n FROM person WHERE email = 'neu@example.com'")).toEqual([
      { n: 1 },
    ])

    // A foreign key by unique column finds the person in another letter case, too.
    let honour = await upload(
      ['email;jahr;art', 'EVA@example.com;2026;medaille_10', ''].join('\n'),
      'ehrung-schreibweise.csv',
    )
    honour = await configure(honour, {
      table: 'ehrung',
      mode: 'insert',
      upsertKey: null,
      skipFailed: false,
      columns: [
        { source: 0, target: 'person_id', reference: { via: 'unique', column: 'email' } },
        { source: 1, target: 'event_id', reference: { via: 'unique', column: 'jahr' } },
        { source: 2, target: 'art' },
      ],
    })
    honour = await step(honour, 'dry-run')
    expect(honour.dryRun?.counts).toMatchObject({ rows: 1, created: 1, failed: 0 })
  })

  it('starts an import once when its owner and an admin start it at the same time', async () => {
    const invited = await admin.send('POST', '/internal/admin/users', {
      email: 'import-manager@example.com',
      displayName: 'Import',
      systemRole: 'manager',
    })
    const { link } = invited.json<{ link: string }>()
    const manager = new (admin.constructor as new (app: Server['app']) => TestClient)(server.app)
    await manager.send('POST', '/internal/invitations/accept', {
      token: link.split('#').at(-1),
      password: 'import-manager long passphrase',
    })
    const uploaded = await manager.upload(
      '/internal/imports?fileName=zahlungen.csv',
      ['anmeldung_id;betrag;eingang_am;verwendungszweck', '1;10;2026-04-01;einmal', ''].join('\n'),
    )
    const job = uploaded.json<ImportJob>()
    await manager.send('PUT', `/internal/imports/${job.id}`, {
      options: job.options,
      mapping: {
        tableAccessId: table('zahlung').id,
        mode: 'insert',
        upsertKey: null,
        skipFailed: false,
        columns: ['anmeldung_id', 'betrag', 'eingang_am', 'verwendungszweck'].map(
          (target, source) => ({ source, target }),
        ),
      },
    })
    await manager.send('POST', `/internal/imports/${job.id}/dry-run`)
    await server.services.imports.settled()
    const started = await Promise.all([
      manager.send('POST', `/internal/imports/${job.id}/run`),
      admin.send('POST', `/internal/imports/${job.id}/run`),
    ])
    await server.services.imports.settled()
    expect(started.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(
      await rows("SELECT COUNT(*) AS n FROM zahlung WHERE verwendungszweck = 'einmal'"),
    ).toEqual([{ n: 1 }])
  })

  it('creates a table from Windows-1252 with semicolons and German dates, adding an id (§ Abnahme)', async () => {
    const csv = iconv.encode(
      [
        'Vorname;Nachname;E-Mail;Geburtstag;Beitrag;Aktiv',
        'Jürgen;Müller;juergen@example.com;31.01.1980;12,50;ja',
        'Zoë;Straße;zoe@example.com;01.02.1990;7,00;nein',
        'Ali;Öztürk;ali@example.com;15.03.2001;8,00;ja',
        '',
      ].join('\r\n'),
      'windows-1252',
    )
    let job = await upload(csv, 'mitglieder.csv')
    const suggested = (
      await admin.request(
        'GET',
        `/internal/imports/${job.id}/new-table?connectionId=${connection.id}`,
      )
    ).json<NewTableDefinition>()
    expect(suggested.name).toBe('mitglieder')
    expect(suggested.columns.map((column) => column.type)).toEqual([
      'varchar',
      'varchar',
      'varchar',
      'date',
      'decimal',
      'boolean',
    ])
    const definition: NewTableDefinition = {
      ...suggested,
      columns: suggested.columns.map((column) =>
        column.name === 'e_mail'
          ? { ...column, name: 'email', length: 254, required: true, unique: true }
          : column,
      ),
    }
    const saved = await admin.send('PUT', `/internal/imports/${job.id}`, {
      options: job.options,
      mapping: null,
      newTable: { definition, skipFailed: false },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    job = await step(job, 'dry-run')
    expect(job.dryRun?.counts).toMatchObject({ rows: 3, created: 3, failed: 0 })
    job = await step(job, 'run')
    expect(job.status, JSON.stringify(job.failure)).toBe('completed')
    expect(job.result).toMatchObject({ created: 3 })
    const outcome = job.newTable?.outcome as NewTableOutcome
    // The read user may read the whole schema, so the table is readable at once.
    expect(outcome).toMatchObject({ readable: true, statements: [] })
    expect(outcome.ddl).toContain('`id` BIGINT NOT NULL AUTO_INCREMENT')
    expect(
      await rows(
        "SELECT id, vorname, email, DATE_FORMAT(geburtstag, '%Y-%m-%d') AS geburtstag, beitrag, aktiv FROM mitglieder ORDER BY id",
      ),
    ).toEqual([
      {
        id: 1,
        vorname: 'Jürgen',
        email: 'juergen@example.com',
        geburtstag: '1980-01-31',
        beitrag: '12.50',
        aktiv: 1,
      },
      {
        id: 2,
        vorname: 'Zoë',
        email: 'zoe@example.com',
        geburtstag: '1990-02-01',
        beitrag: '7.00',
        aktiv: 0,
      },
      {
        id: 3,
        vorname: 'Ali',
        email: 'ali@example.com',
        geburtstag: '2001-03-15',
        beitrag: '8.00',
        aktiv: 1,
      },
    ])
    const created = (
      await admin.request('GET', '/internal/admin/audit?action=table.created')
    ).json<{ data: AuditEvent[] }>().data
    expect(created[0]?.details).toMatchObject({ ddl: outcome.ddl, importId: job.id })

    // Table access with ceiling read, active since the read user sees the table.
    const list = (
      await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
    ).json<{ data: TableAccess[] }>().data
    const table = list.find((entry) => entry.objectName === 'mitglieder') as TableAccess
    expect(table).toMatchObject({ ops: ['read'], state: 'active', keyColumn: 'id' })

    // After the ceiling is raised, a second import upserts by e-mail; its dry run reports the
    // faulty row before anything is written.
    const raised = await admin.send('PUT', `/internal/admin/table-access/${table.id}`, {
      ops: ['read', 'create', 'update'],
      keyColumn: 'id',
      displayTemplate: null,
      apiResource: table.apiResource,
      mcpEnabled: false,
      exclusions: [],
    })
    expect(raised.statusCode, raised.body).toBe(200)
    access.set('mitglieder', raised.json<TableAccess>())
    let second = await upload(
      iconv.encode(
        [
          'E-Mail;Beitrag;Aktiv',
          'juergen@example.com;15,00;ja',
          'zoe@example.com;viel;nein',
          'neu@example.com;5,00;ja',
          '',
        ].join('\r\n'),
        'windows-1252',
      ),
      'beitraege.csv',
    )
    second = await configure(second, {
      table: 'mitglieder',
      mode: 'upsert',
      upsertKey: ['email'],
      skipFailed: true,
      columns: [
        { source: 0, target: 'email' },
        { source: 1, target: 'beitrag' },
        { source: 2, target: 'aktiv' },
      ],
    })
    second = await step(second, 'dry-run')
    expect(second.dryRun?.counts).toMatchObject({ rows: 3, created: 1, updated: 1, failed: 1 })
    expect(second.dryRun?.errors).toEqual([{ line: 3, column: 'beitrag', code: 'invalid' }])
    second = await step(second, 'run')
    expect(second.status, JSON.stringify(second.failure)).toBe('completed')
    expect(await rows('SELECT email, beitrag FROM mitglieder ORDER BY id')).toEqual([
      { email: 'juergen@example.com', beitrag: '15.00' },
      { email: 'zoe@example.com', beitrag: '7.00' },
      { email: 'ali@example.com', beitrag: '8.00' },
      { email: 'neu@example.com', beitrag: '5.00' },
    ])
  })

  it('refuses a name only the database knows', async () => {
    await root.query('CREATE TABLE geheim (id INT PRIMARY KEY)')
    const response = await admin.send('POST', '/internal/admin/tables', {
      connectionId: connection.id,
      name: 'geheim',
      primaryKey: { kind: 'added', name: 'id' },
      columns: [
        {
          name: 'text',
          source: null,
          type: 'varchar',
          length: 40,
          required: false,
          unique: false,
          default: null,
        },
      ],
    })
    expect(response.statusCode).toBe(422)
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { field: 'name', code: 'taken' },
    ])
  })

  it('designs an empty table that waits for the grants of the read user', async () => {
    // Narrow the read user to the tables that exist, so a new table is not readable.
    const tables = await rows<{ name: string }>(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'wanderverein'",
    )
    await root.query("REVOKE SELECT, SHOW VIEW ON wanderverein.* FROM 'stashley_read'@'%'")
    for (const { name } of tables) {
      await root.query(`GRANT SELECT ON wanderverein.\`${name}\` TO 'stashley_read'@'%'`)
    }
    // Pooled sessions keep schema privileges until they reconnect.
    await server.services.pools.closeAll()

    const definition: NewTableDefinition = {
      connectionId: connection.id,
      name: 'notizen',
      primaryKey: { kind: 'added', name: 'id' },
      columns: [
        {
          name: 'titel',
          source: null,
          type: 'varchar',
          length: 120,
          required: true,
          unique: true,
          default: null,
        },
        {
          name: 'erledigt',
          source: null,
          type: 'boolean',
          required: true,
          unique: false,
          default: { kind: 'value', value: 'false' },
        },
        {
          name: 'betrag',
          source: null,
          type: 'decimal',
          precision: 8,
          scale: 2,
          required: false,
          unique: false,
          default: { kind: 'value', value: '0.00' },
        },
        {
          name: 'angelegt',
          source: null,
          type: 'datetime',
          required: true,
          unique: false,
          default: { kind: 'now' },
        },
        {
          name: 'notiz',
          source: null,
          type: 'varchar',
          length: 40,
          required: false,
          unique: false,
          default: { kind: 'value', value: "it's new" },
        },
      ],
    }
    const created = await admin.send('POST', '/internal/admin/tables', definition)
    expect(created.statusCode, created.body).toBe(201)
    const outcome = created.json<NewTableOutcome>()
    expect(outcome.readable).toBe(false)
    expect(outcome.statements).toEqual([
      {
        purpose: 'read',
        statement: "GRANT SELECT ON `wanderverein`.`notizen` TO 'stashley_read'@'%';",
      },
    ])
    const pending = (
      await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
    )
      .json<{ data: TableAccess[] }>()
      .data.find((entry) => entry.objectName === 'notizen')
    expect(pending).toMatchObject({ state: 'pending_grants', ops: ['read'] })

    // The defaults work: a row with only the title.
    await root.query("INSERT INTO wanderverein.notizen (titel) VALUES ('Erste')")
    expect(await rows('SELECT titel, erledigt, betrag, notiz FROM wanderverein.notizen')).toEqual([
      { titel: 'Erste', erledigt: 0, betrag: '0.00', notiz: "it's new" },
    ])

    await root.query(outcome.statements[0]?.statement as string)
    const checked = await admin.send(
      'POST',
      `/internal/admin/tables/${outcome.tableAccessId}/check`,
    )
    expect(checked.statusCode, checked.body).toBe(200)
    expect(checked.json()).toEqual({ readable: true, statements: [] })
    const active = (
      await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
    )
      .json<{ data: TableAccess[] }>()
      .data.find((entry) => entry.objectName === 'notizen')
    expect(active?.state).toBe('active')
  })
})
