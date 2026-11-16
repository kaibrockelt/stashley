// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Connection,
  FieldOptions,
  PageDetail,
  PageDocumentInput,
  ProblemDocument,
  Role,
  RowWriteResult,
  TableAccess,
  TableResult,
  UserScope,
} from '@stashley/shared'
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
 * The write path against real servers (§11): forms and editable tables write through the
 * write user in one transaction, inside their base filter, with version tokens, upserts,
 * translated errors, audit entries and cache invalidation; edit and preview only simulate.
 */
function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

describe.skipIf(targets.length === 0).each(targets)('writes on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection
  let access: Map<string, TableAccess>
  const roles: Record<string, Role> = {}
  const users: Record<string, TestClient> = {}
  const pages: Record<string, PageDetail> = {}

  const table = (name: string) => {
    const entry = access.get(name)
    if (entry === undefined) throw new Error(name)
    return entry
  }
  const source = (name: string) => ({
    kind: 'table' as const,
    tableAccessId: table(name).id,
    cacheTtlSeconds: 0,
  })
  const key = (name: string) => `table:${table(name).id}` as const
  const role = (name: string) => (roles[name] as Role).id

  async function user(email: string, roleIds: string[]): Promise<TestClient> {
    const invited = await admin.send('POST', '/internal/admin/users', {
      email,
      displayName: email,
      systemRole: 'user',
    })
    const { user: account, link } = invited.json<{ user: { id: string }; link: string }>()
    const client = new (admin.constructor as new (app: Server['app']) => TestClient)(server.app)
    await client.send('POST', '/internal/invitations/accept', {
      token: link.split('#').at(-1),
      password: `${email} long passphrase`,
    })
    await admin.send('PUT', `/internal/admin/users/${account.id}/roles`, { roleIds })
    return client
  }

  async function page(slug: string, document: PageDocumentInput): Promise<PageDetail> {
    const created = (
      await admin.send('POST', '/internal/design/pages', {
        sectionId: null,
        kind: document.kind,
        slug,
        title: document.title,
      })
    ).json<PageDetail>()
    await admin.session()
    const saved = await admin.request(
      'PUT',
      `/internal/design/pages/${created.id}/draft`,
      document,
      { 'if-match': `"${created.draftRevision}"` },
    )
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200)
    const published = await admin.send('POST', `/internal/design/pages/${created.id}/publish`)
    expect(published.statusCode, JSON.stringify(published.json())).toBe(200)
    return published.json<PageDetail>()
  }

  const dashboard = (title: string, blocks: unknown[], grants: unknown[], view: string[]) =>
    ({
      schemaVersion: 1,
      kind: 'dashboard',
      title,
      filters: [],
      parameters: [],
      rows: blocks.map((block, index) => ({ id: `r${index}`, layout: '12', blocks: [block] })),
      table: null,
      access: { view, grants },
      mcp: { available: false },
    }) as PageDocumentInput

  const rows = (pageId: string, component: string) =>
    `/internal/pages/${pageId}/components/${component}/rows`

  const auditOf = async (action: string) =>
    (
      await admin.request('GET', `/internal/admin/audit?action=${encodeURIComponent(action)}`)
    ).json<{
      data: { action: string; subjectId: string | null; changes: Record<string, unknown> | null }[]
    }>().data

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    ;({ server, admin } = await startServer())
    ;({ connection, access } = await connectDemo(admin, url))
    const anmeldung = table('anmeldung')
    await admin.send('PUT', `/internal/admin/table-access/${anmeldung.id}`, {
      ops: anmeldung.ops,
      keyColumn: 'id',
      displayTemplate: '{startnummer} – {person.nachname}',
      apiResource: anmeldung.apiResource,
      mcpEnabled: false,
      exclusions: [],
    })
    await admin.send('POST', '/internal/design/variables', {
      name: 'current_event_id',
      type: 'integer',
      value: 2,
      description: '',
    })
    for (const name of ['Kasse', 'Lindenhof', 'Orga', 'Checkin']) {
      roles[name] = (
        await admin.send('POST', '/internal/design/roles', {
          name,
          description: '',
          homePageId: null,
        })
      ).json<Role>()
    }
    users.kasse = await user('jonas@example.com', [role('Kasse')])
    users.lindenhof = await user('rezeption@lindenhof.example', [role('Lindenhof')])
    users.orga = await user('petra@example.com', [role('Orga')])
    users.checkin = await user('aylin@example.com', [role('Checkin')])

    pages.kasse = await page(
      'kasse',
      dashboard(
        'Kasse',
        [
          {
            id: 'zahlung',
            type: 'form',
            title: 'Zahlung erfassen',
            restrictions: [],
            source: source('zahlung'),
            mode: 'create',
            fields: [
              {
                kind: 'input',
                id: 'anmeldung',
                column: 'anmeldung_id',
                reference: {
                  target: 'anmeldung',
                  searchColumns: ['startnummer'],
                  extras: [
                    { path: [{ column: 'person_id', target: 'person' }], column: 'nachname' },
                  ],
                },
              },
              { kind: 'input', id: 'betrag', column: 'betrag' },
              {
                kind: 'generated',
                id: 'eingang',
                column: 'eingang_am',
                generator: { kind: 'date', expression: 'today', editable: true },
              },
              {
                kind: 'input',
                id: 'kommentar',
                column: 'kommentar',
                default: { kind: 'constant', value: 'Kasse' },
                hidden: true,
              },
            ],
          },
          {
            id: 'status',
            type: 'table',
            title: 'Zahlungsstatus',
            restrictions: [],
            source: source('v_zahlungsstatus'),
            bindings: [],
            table: {
              columns: [
                { kind: 'column', id: 'anmeldung', column: { path: [], column: 'anmeldung_id' } },
                { kind: 'column', id: 'offen', column: { path: [], column: 'offen' } },
              ],
              sort: null,
              searchColumns: [],
              baseFilter: [],
              bindings: [],
              pageSize: 50,
            },
          },
        ],
        [
          { principal: role('Kasse'), source: key('zahlung'), ops: ['read', 'create'] },
          { principal: role('Kasse'), source: key('v_zahlungsstatus'), ops: ['read'] },
        ],
        [role('Kasse')],
      ),
    )

    const hotelPage = (hotelId: number, roleId: string, editable: string[], orgaOps: string[]) =>
      ({
        schemaVersion: 1,
        kind: 'table',
        title: `Hotel ${hotelId}`,
        filters: [],
        parameters: [],
        rows: [],
        table: {
          id: 'gaeste',
          type: 'table',
          title: 'Gäste',
          restrictions: [],
          source: source('hotelbuchung'),
          bindings: [],
          table: {
            columns: [
              { kind: 'column', id: 'anreise', column: { path: [], column: 'anreise' } },
              {
                kind: 'column',
                id: 'eingecheckt',
                column: { path: [], column: 'eingecheckt_am' },
              },
            ],
            sort: { columnId: 'anreise', direction: 'asc' },
            searchColumns: [],
            baseFilter: [
              {
                column: {
                  path: [{ column: 'hotel_kontingent_id', target: 'hotel_kontingent' }],
                  column: 'hotel_id',
                },
                operator: 'eq',
                value: { kind: 'constant', value: hotelId },
              },
              {
                column: {
                  path: [{ column: 'hotel_kontingent_id', target: 'hotel_kontingent' }],
                  column: 'event_id',
                },
                operator: 'eq',
                value: { kind: 'variable', name: 'current_event_id' },
              },
            ],
            bindings: [],
            pageSize: 50,
            editing: {
              ops: ['update', 'delete'],
              fields: editable.map((column) => ({ kind: 'input', id: column, column })),
              inline: true,
              dialog: true,
            },
          },
        },
        access: {
          view: [roleId, role('Orga')],
          grants: [
            { principal: roleId, source: key('hotelbuchung'), ops: ['read', 'update'] },
            { principal: role('Orga'), source: key('hotelbuchung'), ops: orgaOps },
          ],
        },
        mcp: { available: false },
      }) as PageDocumentInput
    pages.lindenhof = await page(
      'lindenhof',
      hotelPage(1, role('Lindenhof'), ['eingecheckt_am'], ['read', 'delete']),
    )
    pages.umbuchen = await page(
      'umbuchen',
      hotelPage(
        1,
        role('Lindenhof'),
        ['hotel_kontingent_id', 'eingecheckt_am'],
        ['read', 'update'],
      ),
    )

    pages.personen = await page(
      'personen',
      dashboard(
        'Personen',
        [
          {
            id: 'person',
            type: 'form',
            title: 'Person anlegen oder ändern',
            restrictions: [],
            source: source('person'),
            mode: 'upsert',
            upsertKey: ['email'],
            fields: ['email', 'vorname', 'nachname', 'land'].map((column) => ({
              kind: 'input',
              id: column,
              column,
            })),
          },
        ],
        [{ principal: role('Orga'), source: key('person'), ops: ['read', 'create', 'update'] }],
        [role('Orga')],
      ),
    )

    pages.checkin = await page(
      'checkin',
      dashboard(
        'Check-in',
        [
          {
            id: 'checkin',
            type: 'form',
            title: 'Check-in',
            restrictions: [],
            source: source('checkin'),
            mode: 'create',
            fields: [
              // A plain number instead of a selection, so the database checks the reference.
              { kind: 'input', id: 'anmeldung', column: 'anmeldung_id', widget: 'number' },
              { kind: 'input', id: 'karte', column: 'stempelkarte_nr' },
              {
                kind: 'generated',
                id: 'zeit',
                column: 'eingecheckt_am',
                generator: { kind: 'date', expression: 'now', editable: false },
              },
            ],
          },
        ],
        [{ principal: role('Checkin'), source: key('checkin'), ops: ['read', 'create'] }],
        [role('Checkin')],
      ),
    )
  }, 240_000)

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('records a payment with server values and updates the payment status at once', async () => {
    const status = async () =>
      (
        await users.kasse?.send(
          'POST',
          `/internal/pages/${pages.kasse?.id}/components/status/query`,
          {},
        )
      )?.json<TableResult>()
    const before = (await status())?.rows.find((row) => row.values.anmeldung === '4')
    expect(before?.values.offen).toBe('50.00')

    const kasse = users.kasse as TestClient
    const created = await kasse.send('POST', rows(pages.kasse?.id as string, 'zahlung'), {
      values: { anmeldung_id: '4', betrag: '50' },
    })
    expect(created.statusCode, created.body).toBe(201)
    const written = created.json<RowWriteResult>()
    // A create form reads nothing (§8.2): the answer carries the key only.
    expect(Object.keys(written).sort()).toEqual(['created', 'key'])
    expect(typeof written.key).toBe('string')
    const [stored] = (await root.query(
      "SELECT betrag, kommentar, DATE_FORMAT(eingang_am, '%Y-%m-%d') AS eingang FROM zahlung WHERE id = ?",
      [written.key],
    )) as unknown as [{ betrag: string; kommentar: string; eingang: string }[]]
    const today = Temporal.Now.plainDateISO('Europe/Berlin').toString()
    expect(stored[0]).toEqual({ betrag: '50.00', kommentar: 'Kasse', eingang: today })

    // The view over the payments shows the change without waiting for the cache (§12).
    const after = (await status())?.rows.find((row) => row.values.anmeldung === '4')
    expect(after?.values.offen).toBe('0.00')
    const audit = await auditOf('row.created')
    expect(audit.find((entry) => entry.subjectId === String(written.key))?.changes).toMatchObject({
      anmeldung_id: [null, '4'],
      betrag: [null, '50'],
      kommentar: [null, 'Kasse'],
    })
  })

  it('rejects fields that are not writable, hidden defaults and keys outside the option list', async () => {
    const kasse = users.kasse as TestClient
    const url = rows(pages.kasse?.id as string, 'zahlung')
    const extra = await kasse.send('POST', url, {
      values: { anmeldung_id: '4', betrag: '1', verwendungszweck: 'x', kommentar: 'selbst' },
    })
    expect(extra.statusCode).toBe(422)
    expect(problem(extra).errors).toEqual([
      { field: 'verwendungszweck', code: 'field_not_writable' },
      { field: 'kommentar', code: 'field_not_writable' },
    ])
    const foreign = await kasse.send('POST', url, { values: { anmeldung_id: '999', betrag: '1' } })
    expect(problem(foreign)).toMatchObject({
      code: 'value_not_allowed',
      errors: [{ field: 'anmeldung_id', code: 'value_not_allowed' }],
    })
    // Only the component's own operations: no updates through a create form.
    expect(
      (await kasse.send('PATCH', `${url}/1`, { values: { betrag: '1' }, version: 'x' })).statusCode,
    ).toBe(403)
    // A component of a page the user cannot see does not exist for them (D5).
    expect(
      (await kasse.send('POST', rows(pages.personen?.id as string, 'person'), { values: {} }))
        .statusCode,
    ).toBe(404)
  })

  it('finds foreign key options by display value and takes an exact start number', async () => {
    const kasse = users.kasse as TestClient
    const options = (search: string) =>
      kasse
        .send(
          'POST',
          `/internal/pages/${pages.kasse?.id}/components/zahlung/fields/anmeldung/options`,
          {
            search,
          },
        )
        .then((response) => response.json<FieldOptions>())
    const exact = await options('202')
    expect(exact.exact).toBe('4')
    expect(exact.options).toEqual([
      { value: '4', label: '202 – Carstens', extras: { x0: 'Carstens' } },
    ])
    const byName = await options('Berg')
    expect(byName.options.map((option) => option.label)).toEqual([
      '101 – Berg',
      '201 – Berg',
      '204 – Berg',
    ])
    expect(byName.exact).toBeUndefined()
  })

  it('updates within the base filter with a version token and keeps hotels apart', async () => {
    const reception = users.lindenhof as TestClient
    const base = rows(pages.lindenhof?.id as string, 'gaeste')
    const loaded = (await reception.request('GET', `${base}/1/edit`)).json<RowWriteResult>()
    expect(loaded).toMatchObject({ key: '1', values: { eingecheckt_am: null } })
    const saved = await reception.send('PATCH', `${base}/1`, {
      values: { eingecheckt_am: '2026-05-08T16:45:00Z' },
      version: loaded.version,
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const after = saved.json<RowWriteResult>()
    expect(after.values?.eingecheckt_am).toBe('2026-05-08T16:45:00Z')
    expect(after.version).not.toBe(loaded.version)
    // The wall time of the connection (Europe/Berlin) is stored.
    const [stored] = (await root.query(
      "SELECT DATE_FORMAT(eingecheckt_am, '%Y-%m-%d %H:%i') AS t FROM hotelbuchung WHERE id = 1",
    )) as unknown as [{ t: string }[]]
    expect(stored[0]?.t).toBe('2026-05-08 18:45')

    // The old token is stale now: 409 with the current row.
    const stale = await reception.send('PATCH', `${base}/1`, {
      values: { eingecheckt_am: null },
      version: loaded.version,
    })
    expect(stale.statusCode).toBe(409)
    expect(problem(stale)).toMatchObject({
      code: 'version_conflict',
      current: {
        key: '1',
        values: { eingecheckt_am: '2026-05-08T16:45:00Z' },
        version: after.version,
      },
    })
    // Repeating the same values writes nothing and audits nothing (§11.1).
    const audited = (await auditOf('row.updated')).length
    const same = await reception.send('PATCH', `${base}/1`, {
      values: { eingecheckt_am: '2026-05-08T16:45:00Z' },
      version: after.version,
    })
    expect(same.json<RowWriteResult>()).toMatchObject({ unchanged: true })
    expect((await auditOf('row.updated')).length).toBe(audited)

    // Booking 2 belongs to the other hotel: a manipulated key finds nothing.
    const foreign = await reception.send('PATCH', `${base}/2`, {
      values: { eingecheckt_am: '2026-05-08T17:00:00Z' },
      version: after.version,
    })
    expect(foreign.statusCode).toBe(404)
    expect((await reception.request('GET', `${base}/2/edit`)).statusCode).toBe(404)
    // A version token is required.
    expect((await reception.send('PATCH', `${base}/1`, { values: {} })).statusCode).toBe(422)
  })

  it('refuses changes that move a row out of the base filter', async () => {
    const reception = users.lindenhof as TestClient
    const base = rows(pages.umbuchen?.id as string, 'gaeste')
    const loaded = (await reception.request('GET', `${base}/1/edit`)).json<RowWriteResult>()
    const moved = await reception.send('PATCH', `${base}/1`, {
      values: { hotel_kontingent_id: '2' },
      version: loaded.version,
    })
    expect(problem(moved).code).toBe('base_filter_violation')
    const [stored] = (await root.query(
      'SELECT hotel_kontingent_id AS k FROM hotelbuchung WHERE id = 1',
    )) as unknown as [{ k: number }[]]
    expect(String(stored[0]?.k)).toBe('1')
  })

  it('creates or updates by the upsert key and translates duplicate keys', async () => {
    const orga = users.orga as TestClient
    const url = rows(pages.personen?.id as string, 'person')
    const first = await orga.send('POST', url, {
      values: { email: 'neu@example.com', vorname: 'Neu', nachname: 'Person', land: 'AT' },
    })
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json<RowWriteResult>()).toMatchObject({ created: true })
    const again = await orga.send('POST', url, {
      values: { email: 'neu@example.com', vorname: 'Neu', nachname: 'Geändert', land: 'AT' },
    })
    expect(again.statusCode).toBe(200)
    // Upsert forms create or update; without read they answer with the key only.
    expect(again.json<RowWriteResult>()).toEqual({
      created: false,
      key: first.json<RowWriteResult>().key,
    })
    const [person] = (await root.query(
      "SELECT nachname FROM person WHERE email = 'neu@example.com'",
    )) as unknown as [{ nachname: string }[]]
    expect(person[0]?.nachname).toBe('Geändert')

    const checkin = users.checkin as TestClient
    const checkins = rows(pages.checkin?.id as string, 'checkin')
    const ok = await checkin.send('POST', checkins, {
      values: { anmeldung_id: '3', stempelkarte_nr: 'K-1' },
    })
    expect(ok.statusCode, ok.body).toBe(201)
    const twice = await checkin.send('POST', checkins, {
      values: { anmeldung_id: '3', stempelkarte_nr: 'K-2' },
    })
    expect(twice.statusCode).toBe(409)
    expect(problem(twice)).toMatchObject({
      code: 'unique_violation',
      errors: [{ field: 'anmeldung_id', code: 'unique_violation' }],
    })
    const missing = await checkin.send('POST', checkins, {
      values: { anmeldung_id: '999', stempelkarte_nr: 'K-3' },
    })
    expect(problem(missing), missing.body).toMatchObject({
      code: 'foreign_key_violation',
      errors: [{ field: 'anmeldung_id', code: 'foreign_key_violation' }],
    })
  })

  it('simulates writes in preview without changing data (§11.2)', async () => {
    const url = rows(pages.checkin?.id as string, 'checkin')
    const count = async () =>
      (
        (await root.query('SELECT COUNT(*) AS n FROM checkin')) as unknown as [{ n: number }[]]
      )[0][0]?.n
    const before = await count()
    const simulated = await admin.send('POST', url, {
      mode: 'preview',
      roles: [role('Checkin')],
      values: { anmeldung_id: '5', stempelkarte_nr: 'K-9' },
    })
    expect(simulated.statusCode, simulated.body).toBe(201)
    expect(simulated.json<RowWriteResult>()).toMatchObject({ simulated: true })
    const duplicate = await admin.send('POST', url, {
      mode: 'preview',
      roles: [role('Checkin')],
      values: { anmeldung_id: '3', stempelkarte_nr: 'K-9' },
    })
    expect(problem(duplicate).code, duplicate.body).toBe('unique_violation')
    expect(await count()).toBe(before)
  })

  it('deletes within the base filter and audits the old values', async () => {
    const orga = users.orga as TestClient
    const base = rows(pages.lindenhof?.id as string, 'gaeste')
    expect((await orga.send('DELETE', `${base}/2`, {})).statusCode).toBe(404)
    const removed = await orga.send('DELETE', `${base}/3`, {})
    expect(removed.statusCode, removed.body).toBe(200)
    const [left] = (await root.query(
      'SELECT COUNT(*) AS n FROM hotelbuchung WHERE id = 3',
    )) as unknown as [{ n: number }[]]
    expect(Number(left[0]?.n)).toBe(0)
    const audit = await auditOf('row.deleted')
    expect(audit.find((entry) => entry.subjectId === '3')?.changes).toMatchObject({
      anreise: ['2026-05-08', null],
    })
    // The reception may change but not delete.
    expect((await users.lindenhof?.send('DELETE', `${base}/1`, {}))?.statusCode).toBe(403)
  })

  // Runs last: it narrows the write user to column grants (E6).
  it('keeps writing after the write user is narrowed to column grants', async () => {
    const hotels = await page('hotels', {
      schemaVersion: 1,
      kind: 'table',
      title: 'Hotels',
      filters: [],
      parameters: [],
      rows: [],
      table: {
        id: 'hotels',
        type: 'table',
        title: 'Hotels',
        restrictions: [],
        source: source('hotel'),
        bindings: [],
        table: {
          columns: [{ kind: 'column', id: 'name', column: { path: [], column: 'name' } }],
          sort: null,
          searchColumns: [],
          baseFilter: [],
          bindings: [],
          pageSize: 50,
          editing: {
            ops: ['update'],
            fields: [{ kind: 'input', id: 'name', column: 'name' }],
            inline: true,
            dialog: false,
          },
        },
      },
      access: {
        view: [role('Orga')],
        grants: [{ principal: role('Orga'), source: key('hotel'), ops: ['read', 'update'] }],
      },
      mcp: { available: false },
    })
    const scope = (
      await admin.request('GET', `/internal/admin/connections/${connection.id}/write-scope`)
    ).json<UserScope>()
    for (const statement of scope.statements) await root.query(statement)
    await server.services.pools.invalidate(connection.id)
    expect(
      (await admin.send('POST', `/internal/admin/connections/${connection.id}/grants`)).statusCode,
    ).toBe(200)
    const orga = users.orga as TestClient
    const updated = await orga.send('POST', rows(pages.personen?.id as string, 'person'), {
      values: { email: 'neu@example.com', vorname: 'Neu', nachname: 'Wieder', land: 'AT' },
    })
    expect(updated.statusCode, updated.body).toBe(200)
    const reception = users.lindenhof as TestClient
    const base = rows(pages.lindenhof?.id as string, 'gaeste')
    const loaded = (await reception.request('GET', `${base}/1/edit`)).json<RowWriteResult>()
    const saved = await reception.send('PATCH', `${base}/1`, {
      values: { eingecheckt_am: null },
      version: loaded.version,
    })
    expect(saved.statusCode, saved.body).toBe(200)
    // `hotel` has an excluded column, so the write user holds UPDATE on columns only.
    expect(
      scope.statements.some((statement) => statement.includes('UPDATE (`id`, `name`, `ort`)')),
    ).toBe(true)
    const hotel = rows(hotels.id, 'hotels')
    const current = (await orga.request('GET', `${hotel}/1/edit`)).json<RowWriteResult>()
    const renamed = await orga.send('PATCH', `${hotel}/1`, {
      values: { name: 'Lindenhof am See' },
      version: current.version,
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
  })
})
