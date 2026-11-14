// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ComponentResult,
  Connection,
  CountResult,
  FilterOptions,
  PageDetail,
  PageDocument,
  ProblemDocument,
  Query,
  Role,
  TableAccess,
  TableResult,
  TableRow,
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
 * Page components against real servers (M4): base filters that keep hotels apart, keyset
 * pages, counts, filter options and cache invalidation through views and variables.
 */
function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

describe.skipIf(targets.length === 0).each(targets)('page components on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection
  let access: Map<string, TableAccess>
  const roles: Record<string, Role> = {}
  const users: Record<string, TestClient> = {}
  const pages: Record<string, PageDetail> = {}
  let offen: Query

  const table = (name: string) => {
    const entry = access.get(name)
    if (entry === undefined) throw new Error(name)
    return entry
  }

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

  async function page(slug: string, document: PageDocument): Promise<PageDetail> {
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
      {
        'if-match': `"${created.draftRevision}"`,
      },
    )
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200)
    const published = await admin.send('POST', `/internal/design/pages/${created.id}/publish`)
    expect(published.statusCode, JSON.stringify(published.json())).toBe(200)
    return published.json<PageDetail>()
  }

  const guests = (hotelId: number, roleId: string, title: string): PageDocument => ({
    schemaVersion: 1,
    kind: 'table',
    title,
    filters: [],
    parameters: [],
    rows: [],
    table: {
      id: 'gaeste',
      type: 'table',
      title: 'Gäste',
      restrictions: [],
      source: { kind: 'table', tableAccessId: table('hotelbuchung').id, cacheTtlSeconds: 0 },
      bindings: [],
      table: {
        columns: [
          { kind: 'column', id: 'anreise', column: { path: [], column: 'anreise' } },
          { kind: 'display', id: 'gast', path: [{ column: 'anmeldung_id', target: 'anmeldung' }] },
          {
            kind: 'column',
            id: 'land',
            column: {
              path: [
                { column: 'anmeldung_id', target: 'anmeldung' },
                { column: 'person_id', target: 'person' },
              ],
              column: 'land',
            },
          },
          { kind: 'column', id: 'eingecheckt', column: { path: [], column: 'eingecheckt_am' } },
        ],
        sort: { columnId: 'anreise', direction: 'asc' },
        searchColumns: ['gast'],
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
      },
    },
    access: {
      view: [roleId],
      grants: [{ principal: roleId, source: `table:${table('hotelbuchung').id}`, ops: ['read'] }],
    },
    mcp: { available: false },
  })

  const read = <T>(client: TestClient, pageId: string, component: string, body: unknown = {}) =>
    client
      .send('POST', `/internal/pages/${pageId}/components/${component}/query`, body)
      .then((response) => {
        expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
        return response.json<T>()
      })

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    // People for paging: telefon has NULLs and repeated values.
    const people = Array.from({ length: 23 }, (_, index) => {
      const id = 100 + index
      const phone = index % 4 === 0 ? 'NULL' : `'0170 ${String(index % 5)}'`
      return `(${id}, 'P${id}', 'Nachname${id % 3}', 'p${id}@example.com', 'DE', ${phone})`
    })
    await root.query(
      `INSERT INTO person (id, vorname, nachname, email, land, telefon) VALUES ${people.join(', ')}`,
    )
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
    for (const name of ['Kasse', 'Lindenhof', 'Adler', 'Orga']) {
      roles[name] = (
        await admin.send('POST', '/internal/design/roles', {
          name,
          description: '',
          homePageId: null,
        })
      ).json<Role>()
    }
    const role = (name: string) => (roles[name] as Role).id
    users.kasse = await user('jonas@example.com', [role('Kasse')])
    users.lindenhof = await user('rezeption@lindenhof.example', [role('Lindenhof')])
    users.adler = await user('rezeption@adler.example', [role('Adler')])
    users.orga = await user('petra@example.com', [role('Orga')])

    offen = (
      await admin.send('POST', '/internal/design/queries', {
        connectionId: connection.id,
        name: 'Offene Posten',
        description: '',
        sql: `SELECT v.anmeldung_id, a.startnummer, v.offen
                FROM v_zahlungsstatus v JOIN anmeldung a ON a.id = v.anmeldung_id
               WHERE v.event_id = :current_event_id AND v.offen > 0
               ORDER BY a.startnummer`,
        parameters: [],
        cacheTtlSeconds: 300,
      })
    ).json<Query>()
    const events = (
      await admin.send('POST', '/internal/design/queries', {
        connectionId: connection.id,
        name: 'Events',
        description: '',
        sql: 'SELECT id, name FROM event ORDER BY jahr DESC',
        parameters: [],
        cacheTtlSeconds: 3600,
      })
    ).json<Query>()

    pages.kasse = await page('kasse', {
      schemaVersion: 1,
      kind: 'dashboard',
      title: 'Kasse',
      filters: [
        {
          kind: 'select',
          id: 'event',
          label: 'Event',
          source: { kind: 'query', queryId: events.id },
          valueColumn: 'id',
          labelColumn: 'name',
          multiple: false,
          required: false,
        },
      ],
      parameters: [],
      rows: [
        {
          id: 'r1',
          layout: '6-6',
          blocks: [
            {
              id: 'offen',
              type: 'table',
              title: 'Offene Posten',
              restrictions: [],
              source: { kind: 'query', queryId: offen.id },
              bindings: [],
              table: null,
            },
            {
              id: 'personen',
              type: 'table',
              title: 'Personen',
              restrictions: [],
              source: { kind: 'table', tableAccessId: table('person').id, cacheTtlSeconds: 60 },
              bindings: [],
              table: {
                columns: [
                  { kind: 'column', id: 'telefon', column: { path: [], column: 'telefon' } },
                  { kind: 'column', id: 'nachname', column: { path: [], column: 'nachname' } },
                ],
                sort: { columnId: 'telefon', direction: 'asc' },
                searchColumns: ['nachname'],
                baseFilter: [],
                bindings: [],
                pageSize: 4,
              },
            },
          ],
        },
      ],
      table: null,
      access: {
        view: [role('Kasse'), role('Orga')],
        grants: [
          { principal: role('Kasse'), source: `query:${offen.id}`, ops: ['read'] },
          { principal: role('Kasse'), source: `table:${table('person').id}`, ops: ['read'] },
        ],
      },
      mcp: { available: false },
    })
    pages.lindenhof = await page('lindenhof', guests(1, role('Lindenhof'), 'Lindenhof'))
    pages.adler = await page('adler', guests(2, role('Adler'), 'Adler'))
  }, 180_000)

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('keeps each hotel to its own guests, also with manipulated keys', async () => {
    const lindenhof = await read<TableResult>(
      users.lindenhof as TestClient,
      pages.lindenhof?.id ?? '',
      'gaeste',
    )
    expect(lindenhof.rows).toEqual([
      {
        key: '1',
        values: { anreise: '2026-05-08', gast: '201 – Berg', land: 'DE', eingecheckt: null },
      },
      {
        key: '3',
        values: {
          anreise: '2026-05-08',
          gast: '203 – Dubois',
          land: 'FR',
          eingecheckt: '2026-05-08T16:00:00Z',
        },
      },
    ])
    const adler = await read<TableResult>(
      users.adler as TestClient,
      pages.adler?.id ?? '',
      'gaeste',
    )
    expect(adler.rows.map((row) => row.key)).toEqual(['2'])

    const row = (client: TestClient, pageId: string, key: string) =>
      client.request('GET', `/internal/pages/${pageId}/components/gaeste/rows/${key}`)
    const own = await row(users.lindenhof as TestClient, pages.lindenhof?.id ?? '', '3')
    expect(own.json<TableRow>().values.gast).toBe('203 – Dubois')
    // Adler's booking, last year's booking, a key that is no number: not found.
    for (const key of ['2', '4', 'x', '1 OR 1=1']) {
      expect(
        problem(await row(users.lindenhof as TestClient, pages.lindenhof?.id ?? '', key)).code,
        key,
      ).toBe('not_found')
    }
    // Through the other hotel's page: invisible.
    expect(problem(await row(users.lindenhof as TestClient, pages.adler?.id ?? '', '2')).code).toBe(
      'not_found',
    )

    const searched = await read<TableResult>(
      users.lindenhof as TestClient,
      pages.lindenhof?.id ?? '',
      'gaeste',
      {
        search: 'dub',
      },
    )
    expect(searched.rows.map((entry) => entry.key)).toEqual(['3'])
    const counted = await (users.lindenhof as TestClient).send(
      'POST',
      `/internal/pages/${pages.lindenhof?.id ?? ''}/components/gaeste/count`,
      {},
    )
    expect(counted.json<CountResult>()).toMatchObject({ count: 2, approximate: false })
  })

  it('pages forward and backward through NULLs and ties like the full sort', async () => {
    const client = users.kasse as TestClient
    const pageId = pages.kasse?.id ?? ''
    for (const direction of ['asc', 'desc'] as const) {
      const order = direction === 'asc' ? 'ASC' : 'DESC'
      const [expected] = await root.query<mysql.RowDataPacket[]>(
        `SELECT id FROM wanderverein.person ORDER BY telefon ${order}, id ${order}`,
      )
      const ids = expected.map((entry) => String(entry.id))
      const forward: string[] = []
      const cursors: (string | null)[] = []
      let cursor: string | undefined
      for (let guard = 0; guard < 20; guard++) {
        const result: TableResult = await read<TableResult>(client, pageId, 'personen', {
          sort: { columnId: 'telefon', direction },
          ...(cursor !== undefined && { cursor }),
        })
        forward.push(...result.rows.map((row) => String(row.key)))
        cursors.push(result.prevCursor)
        if (result.nextCursor === null) break
        cursor = result.nextCursor
      }
      expect(forward, direction).toEqual(ids)
      // Back from the last page to the first.
      const backward: string[] = []
      let back = cursors.at(-1) ?? null
      while (back !== null) {
        const result: TableResult = await read<TableResult>(client, pageId, 'personen', {
          sort: { columnId: 'telefon', direction },
          cursor: back,
        })
        backward.unshift(...result.rows.map((row) => String(row.key)))
        back = result.prevCursor
      }
      expect(backward, direction).toEqual(ids.slice(0, ids.length - (ids.length % 4 || 4)))
    }
    // A cursor from another sort order does not fit.
    const first = await read<TableResult>(client, pageId, 'personen', {})
    const other = await client.send('POST', `/internal/pages/${pageId}/components/personen/query`, {
      sort: { columnId: 'nachname', direction: 'asc' },
      cursor: first.nextCursor,
    })
    expect(problem(other).code).toBe('cursor_invalid')
  })

  it('shows a new payment at once through the payment-status view', async () => {
    const client = users.kasse as TestClient
    const pageId = pages.kasse?.id ?? ''
    const before = await read<ComponentResult>(client, pageId, 'offen')
    expect(before.rows).toEqual([
      { anmeldung_id: '4', startnummer: 202, offen: '50.00' },
      { anmeldung_id: '5', startnummer: 203, offen: '188.00' },
      { anmeldung_id: '7', startnummer: 204, offen: '28.00' },
    ])
    await root.query(
      "INSERT INTO wanderverein.zahlung (anmeldung_id, betrag, eingang_am) VALUES (4, 50.00, '2026-04-10')",
    )
    // Outside the tool, the change shows only after the cache duration.
    const cached = await read<ComponentResult>(client, pageId, 'offen')
    expect(cached.fetchedAt).toBe(before.fetchedAt)
    // A write through the tool evicts every entry on the payment's tables, views included.
    server.services.events.emit('rows.written', {
      connectionId: connection.id,
      objects: ['zahlung'],
    })
    const after = await read<ComponentResult>(client, pageId, 'offen')
    expect(after.rows.map((row) => row.anmeldung_id)).toEqual(['5', '7'])
  })

  it('pages through query results in memory and lists filter options', async () => {
    const client = users.kasse as TestClient
    const pageId = pages.kasse?.id ?? ''
    const first = await read<ComponentResult>(client, pageId, 'offen', { pageSize: 1 })
    expect(first).toMatchObject({ rows: [{ anmeldung_id: '5' }], total: 2 })
    const second = await read<ComponentResult>(client, pageId, 'offen', {
      pageSize: 1,
      cursor: first.nextCursor,
    })
    expect(second.rows).toEqual([{ anmeldung_id: '7', startnummer: 204, offen: '28.00' }])
    const sorted = await read<ComponentResult>(client, pageId, 'offen', {
      sort: { columnId: 'offen', direction: 'asc' },
      columnFilters: [{ columnId: 'offen', operator: 'gt', value: 10 }],
    })
    expect(sorted.rows.map((row) => row.offen)).toEqual(['28.00', '188.00'])
    const options = await client.send('POST', `/internal/pages/${pageId}/filters/event/options`, {
      search: '2025',
    })
    expect(options.json<FilterOptions>().options).toEqual([{ value: '1', label: 'Wanderung 2025' }])
  })

  it('switches every event-related component when the instance variable changes', async () => {
    const variables = (await admin.request('GET', '/internal/design/variables')).json<{
      data: { id: string; name: string }[]
    }>()
    const variable = variables.data.find((entry) => entry.name === 'current_event_id')
    await admin.send('PATCH', `/internal/design/variables/${variable?.id ?? ''}`, { value: 1 })
    try {
      const lindenhof = await read<TableResult>(
        users.lindenhof as TestClient,
        pages.lindenhof?.id ?? '',
        'gaeste',
      )
      expect(lindenhof.rows.map((row) => row.key)).toEqual(['4'])
      const kasse = await read<ComponentResult>(
        users.kasse as TestClient,
        pages.kasse?.id ?? '',
        'offen',
      )
      expect(kasse.rows.map((row) => row.anmeldung_id)).toEqual(['2'])
    } finally {
      await admin.send('PATCH', `/internal/design/variables/${variable?.id ?? ''}`, { value: 2 })
    }
  })

  it('limits manual refreshes to one per 10 s and component', async () => {
    const client = users.kasse as TestClient
    const refresh = () =>
      client.send('POST', `/internal/pages/${pages.kasse?.id ?? ''}/components/offen/refresh`, {})
    expect((await refresh()).statusCode).toBe(200)
    const limited = await refresh()
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  })
})
