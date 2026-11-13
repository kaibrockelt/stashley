// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, Connection, ProblemDocument, TableAccess } from '@stashley/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../../app.ts'
import { TestClient } from '../../test/client.ts'
import {
  column,
  storeConnection,
  storedConnectionId,
  storeSnapshot,
  table,
} from '../../test/connections.ts'
import { buildGrantReport } from '../connections/grants.ts'
import { testConfig } from '../../test/helpers.ts'
import { checkTemplate, defaultTemplate } from './templates.ts'

const person = table('person', [
  column('vorname', 'string', 2),
  column('email', 'string', 3),
  column('telefon', 'string', 4),
])
const anmeldung = table(
  'anmeldung',
  [column('person_id', 'bigint', 2), column('startnummer', 'integer', 3)],
  [
    {
      name: 'anmeldung_person_fk',
      columns: ['person_id'],
      targetObject: 'person',
      targetColumns: ['id'],
    },
  ],
)
const hotel = table('hotel', [column('name', 'string', 2), column('ort', 'string', 3)])
/** A view the read user cannot inspect (no SHOW VIEW). */
const status: CatalogObject = {
  name: 'v_status',
  type: 'view',
  rowEstimate: null,
  columns: [
    { ...column('anmeldung_id', 'bigint'), nullable: false },
    column('offen', 'decimal', 2),
  ],
  primaryKey: [],
  uniqueKeys: [],
  foreignKeys: [],
  baseTables: [],
  keyCandidates: [],
  dependenciesKnown: false,
}
const objects: CatalogObject[] = [anmeldung, hotel, person, status]

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function setup() {
  const server = await createServer(
    testConfig({
      INITIAL_ADMIN_EMAIL: 'admin@example.com',
      INITIAL_ADMIN_PASSWORD: 'correct horse battery staple',
    }),
    { quiet: true, listen: false },
  )
  servers.push(server)
  await server.start()
  const admin = new TestClient(server.app)
  await admin.login('admin@example.com', 'correct horse battery staple')
  const connectionId = await storeConnection(server, undefined, { objects })
  const expose = (objectName: string, fields: Record<string, unknown> = {}) =>
    admin.send('POST', '/internal/admin/table-access', {
      connectionId,
      objectName,
      ops: ['read'],
      keyColumn: null,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: [],
      ...fields,
    })
  const list = async () =>
    new Map(
      (await admin.request('GET', `/internal/admin/table-access?connectionId=${connectionId}`))
        .json<{ data: TableAccess[] }>()
        .data.map((access) => [access.objectName, access]),
    )
  return { server, admin, expose, list }
}

describe('display templates', () => {
  it('check columns, relations, targets and exclusions', () => {
    const context = {
      object: anmeldung,
      objects: new Map(objects.map((object) => [object.name, object])),
      relations: [{ sourceColumn: 'person_id', targetObject: 'person' }],
      excluded: new Set<string>(),
      target: (name: string) =>
        name === 'person' ? { excluded: new Set(['telefon']) } : undefined,
    }
    expect(checkTemplate('{startnummer} – {person.vorname}', context)).toBeUndefined()
    expect(checkTemplate('{startnummer} {person_id.vorname}', context)).toBeUndefined()
    expect(checkTemplate('no placeholder', context)).toBe('invalid')
    expect(checkTemplate('{missing}', context)).toBe('unknown_column')
    expect(checkTemplate('{hotel.name}', context)).toBe('unknown_relation')
    expect(checkTemplate('{person.telefon}', context)).toBe('excluded_column')
    expect(checkTemplate('{person.vorname}', { ...context, target: () => undefined })).toBe(
      'target_not_exposed',
    )
    expect(checkTemplate('{startnummer}', { ...context, excluded: new Set(['startnummer']) })).toBe(
      'excluded_column',
    )
    // One source column with relations to two targets: only the target name is unambiguous.
    const twoTargets = {
      ...context,
      relations: [...context.relations, { sourceColumn: 'person_id', targetObject: 'hotel' }],
    }
    expect(checkTemplate('{person_id.vorname}', twoTargets)).toBe('unknown_relation')
    expect(checkTemplate('{person.vorname}', twoTargets)).toBeUndefined()
  })

  it('default to the first text column that is not excluded', () => {
    expect(defaultTemplate(hotel, 'id')).toBe('{name}')
    expect(defaultTemplate(hotel, 'id', new Set(['name']))).toBe('{ort}')
    expect(defaultTemplate(hotel, 'id', new Set(['name', 'ort']))).toBe('{id}')
  })
})

describe('table access', () => {
  it('never shows an excluded column through the default template', async () => {
    const s = await setup()
    const created = await s.expose('hotel', { exclusions: [{ column: 'name', scope: 'all' }] })
    expect(created.json<TableAccess>().effectiveTemplate).toBe('{ort}')
    // An exclusion for MCP only keeps the column in the default.
    const person = await s.expose('person', { exclusions: [{ column: 'vorname', scope: 'mcp' }] })
    expect(person.json<TableAccess>().effectiveTemplate).toBe('{vorname}')
  })

  it('stops using a template whose target column is excluded later', async () => {
    const s = await setup()
    const template = '{startnummer} – {person.email}'
    const early = await s.expose('anmeldung', { displayTemplate: template })
    expect(early.json<ProblemDocument>().errors).toEqual([
      { field: 'displayTemplate', code: 'target_not_exposed' },
    ])
    const personId = (await s.expose('person')).json<TableAccess>().id
    expect((await s.expose('anmeldung', { displayTemplate: template })).statusCode).toBe(201)
    expect((await s.list()).get('anmeldung')).toMatchObject({
      effectiveTemplate: template,
      warnings: [],
    })

    const fields = {
      ops: ['read'],
      keyColumn: null,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
    }
    const excluded = await s.admin.send('PUT', `/internal/admin/table-access/${personId}`, {
      ...fields,
      exclusions: [{ column: 'email', scope: 'all' }],
    })
    expect(excluded.statusCode).toBe(200)
    // The stored template stays for the admin to fix, but is no longer used.
    expect((await s.list()).get('anmeldung')).toMatchObject({
      displayTemplate: template,
      effectiveTemplate: '{id}',
      warnings: [{ code: 'template_invalid' }],
    })

    await s.admin.send('PUT', `/internal/admin/table-access/${personId}`, {
      ...fields,
      exclusions: [],
    })
    expect((await s.list()).get('anmeldung')?.effectiveTemplate).toBe(template)
    await s.admin.send('DELETE', `/internal/admin/table-access/${personId}`)
    expect((await s.list()).get('anmeldung')).toMatchObject({
      effectiveTemplate: '{id}',
      warnings: [{ code: 'template_invalid' }],
    })
  })

  it('warns when the primary key no longer matches the key column', async () => {
    const s = await setup()
    await s.expose('person')
    expect((await s.list()).get('person')?.warnings).toEqual([])
    await storeSnapshot(s.server, [{ ...person, primaryKey: ['email'] }], Date.now() + 1000)
    expect((await s.list()).get('person')?.warnings).toEqual([{ code: 'key_mismatch' }])
  })

  it('grants update and delete only with SELECT for the write user', async () => {
    const s = await setup()
    const report = buildGrantReport({
      purpose: 'write',
      database: 'wanderverein',
      lines: ['GRANT INSERT, UPDATE, DELETE ON `wanderverein`.* TO `stashley_write`@`%`'],
    })
    await s.server.store.db
      .updateTable('connection_credentials')
      .set({ grant_report: JSON.stringify(report) })
      .where('purpose', '=', 'write')
      .execute()
    const created = await s.expose('hotel', { ops: ['read', 'create', 'update', 'delete'] })
    expect(created.json<TableAccess>()).toMatchObject({
      grantedOps: ['read', 'create'],
      warnings: [{ code: 'ops_without_grant', ops: ['update', 'delete'] }],
    })
  })

  it('warns about views without known base tables or with a nullable key', async () => {
    const s = await setup()
    const created = await s.expose('v_status', { keyColumn: 'offen' })
    expect(created.json<TableAccess>().warnings.map((warning) => warning.code)).toEqual([
      'view_dependencies_unknown',
      'view_key_nullable',
    ])
  })

  it('keeps relations consistent with column kinds and view keys', async () => {
    const s = await setup()
    const relation = (fields: Record<string, unknown>) =>
      s.admin.send('POST', '/internal/admin/relations', {
        connectionId: storedConnectionId,
        kind: 'many_to_one',
        ...fields,
      })
    const mismatch = await relation({
      sourceObject: 'hotel',
      sourceColumn: 'name',
      targetObject: 'anmeldung',
      targetColumn: 'id',
    })
    expect(mismatch.json<ProblemDocument>().errors).toEqual([
      { field: 'targetColumn', code: 'type_mismatch' },
    ])

    const view = (await s.expose('v_status', { keyColumn: 'anmeldung_id' })).json<TableAccess>()
    const oneToOne = await relation({
      sourceObject: 'anmeldung',
      sourceColumn: 'id',
      targetObject: 'v_status',
      targetColumn: 'anmeldung_id',
      kind: 'one_to_one',
    })
    expect(oneToOne.statusCode).toBe(201)
    const rekeyed = await s.admin.send('PUT', `/internal/admin/table-access/${view.id}`, {
      ops: ['read'],
      keyColumn: 'offen',
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: [],
    })
    expect(rekeyed.json<ProblemDocument>().errors).toEqual([
      { field: 'keyColumn', code: 'used_by_relation' },
    ])
  })
})

describe('schema check status', () => {
  it('keeps the failure of the last schema read on the connection', async () => {
    const s = await setup()
    const refresh = await s.admin.send(
      'POST',
      `/internal/admin/connections/${storedConnectionId}/schema/refresh`,
    )
    expect(refresh.json<ProblemDocument>().code).toBe('connection_failed')
    const connection = (
      await s.admin.request('GET', `/internal/admin/connections/${storedConnectionId}`)
    ).json<Connection>()
    expect(connection.schemaCheck.failure).toBe('host_not_allowed')
    expect(connection.schemaCheck.checkedAt).not.toBeNull()
  })
})
