// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Navigation,
  PageDetail,
  PageDocumentInput,
  PermissionEntry,
  Query,
  RenderPage,
  Role,
  TableAccess,
} from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { TargetError } from '../../target/errors.ts'
import type { TestClient } from '../../test/client.ts'
import { setupDemo, type Demo } from '../../test/demo.ts'
import { createUser, problem, setupServer, type TestSetup } from '../../test/setup.ts'

/**
 * Page and component rights through the internal API (§8, criteria on manager limits and
 * manipulated API calls). Reads that pass authorization reach no database here: the target
 * host is refused, so they end with `target_unavailable`. Real reads are integration tests.
 */

const refused = () => Promise.reject(new TargetError('host_not_allowed'))

interface World {
  s: TestSetup
  demo: Demo
  manager: TestClient
  roles: Record<'kasse' | 'orga' | 'lindenhof' | 'adler', Role>
  users: Record<'kasse' | 'orga' | 'lindenhof' | 'adler' | 'nobody', TestClient>
  queries: { offen: Query; summe: Query }
}

async function world(): Promise<World> {
  const s = await setupServer({ resolveTargetHost: refused })
  const demo = await setupDemo(s)
  const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
  const role = async (name: string) =>
    (
      await manager.send('POST', '/internal/design/roles', {
        name,
        description: '',
        homePageId: null,
      })
    ).json<Role>()
  const roles = {
    kasse: await role('Kasse'),
    orga: await role('Orga'),
    lindenhof: await role('Hotel Lindenhof'),
    adler: await role('Berggasthof Adler'),
  }
  const user = async (email: string, roleIds: string[]) =>
    (await createUser(s, email, 'user', roleIds)).client
  const users = {
    kasse: await user('jonas@example.com', [roles.kasse.id]),
    orga: await user('petra@example.com', [roles.orga.id]),
    lindenhof: await user('rezeption@lindenhof.example', [roles.lindenhof.id]),
    adler: await user('rezeption@adler.example', [roles.adler.id]),
    nobody: await user('niemand@example.com', []),
  }
  await manager.send('POST', '/internal/design/variables', {
    name: 'current_event_id',
    type: 'integer',
    value: 2,
    description: '',
  })
  const query = async (name: string, sql: string) =>
    (
      await manager.send('POST', '/internal/design/queries', {
        connectionId: demo.connectionId,
        name,
        description: '',
        sql,
        parameters: [],
        cacheTtlSeconds: 300,
      })
    ).json<Query>()
  const queries = {
    offen: await query(
      'Offene Posten',
      'SELECT anmeldung_id, offen FROM v_zahlungsstatus WHERE event_id = :current_event_id AND offen > 0',
    ),
    summe: await query(
      'Offen gesamt',
      'SELECT SUM(offen) AS offen FROM v_zahlungsstatus WHERE event_id = :current_event_id',
    ),
  }
  return { s, demo, manager, roles, users, queries }
}

function access(w: World, name: string): TableAccess {
  const entry = w.demo.access.get(name)
  if (entry === undefined) throw new Error(`no access for ${name}`)
  return entry
}

function kassePage(w: World): PageDocumentInput {
  const zahlung = access(w, 'zahlung').id
  return {
    schemaVersion: 1,
    kind: 'dashboard',
    title: 'Kasse',
    filters: [],
    parameters: [],
    rows: [
      {
        id: 'r1',
        layout: '8-4',
        blocks: [
          {
            id: 'offene-posten',
            type: 'table',
            title: 'Offene Posten',
            restrictions: [],
            source: { kind: 'query', queryId: w.queries.offen.id },
            bindings: [],
            table: null,
          },
          {
            id: 'summe',
            type: 'metric',
            title: 'Offen',
            restrictions: [{ principal: w.roles.orga.id, ops: [] }],
            source: { kind: 'query', queryId: w.queries.summe.id },
            bindings: [],
          },
        ],
      },
      {
        id: 'r2',
        layout: '12',
        blocks: [
          {
            id: 'zahlung-erfassen',
            type: 'form',
            title: 'Zahlung erfassen',
            restrictions: [],
            source: { kind: 'table', tableAccessId: zahlung, cacheTtlSeconds: 0 },
            mode: 'create',
          },
        ],
      },
    ],
    table: null,
    access: {
      view: [w.roles.kasse.id, w.roles.orga.id],
      grants: [
        { principal: w.roles.kasse.id, source: `query:${w.queries.offen.id}`, ops: ['read'] },
        { principal: w.roles.kasse.id, source: `query:${w.queries.summe.id}`, ops: ['read'] },
        { principal: w.roles.orga.id, source: `query:${w.queries.offen.id}`, ops: ['read'] },
        { principal: w.roles.orga.id, source: `query:${w.queries.summe.id}`, ops: ['read'] },
        { principal: w.roles.kasse.id, source: `table:${zahlung}`, ops: ['read', 'create'] },
      ],
    },
    mcp: { available: false },
  }
}

/** A hotel's guest page: bookings of its own contingents only (§ Gästeseiten). */
function guestPage(w: World, hotelId: number, roleId: string, title: string): PageDocumentInput {
  const buchung = access(w, 'hotelbuchung').id
  return {
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
      source: { kind: 'table', tableAccessId: buchung, cacheTtlSeconds: 0 },
      bindings: [],
      table: {
        columns: [
          { kind: 'column', id: 'anreise', column: { path: [], column: 'anreise' } },
          { kind: 'display', id: 'gast', path: [{ column: 'anmeldung_id', target: 'anmeldung' }] },
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
      grants: [{ principal: roleId, source: `table:${buchung}`, ops: ['read'] }],
    },
    mcp: { available: false },
  }
}

async function createPage(
  w: World,
  slug: string,
  document: PageDocumentInput,
  publish = true,
): Promise<PageDetail> {
  const created = await w.manager.send('POST', '/internal/design/pages', {
    sectionId: null,
    kind: document.kind,
    slug,
    title: document.title,
  })
  expect(created.statusCode, slug).toBe(201)
  const page = created.json<PageDetail>()
  const saved = await saveDraft(w.manager, page.id, page.draftRevision, document)
  expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200)
  if (!publish) return saved.json<PageDetail>()
  const published = await w.manager.send('POST', `/internal/design/pages/${page.id}/publish`)
  expect(published.statusCode, JSON.stringify(published.json())).toBe(200)
  return published.json<PageDetail>()
}

async function saveDraft(client: TestClient, id: string, revision: number, document: unknown) {
  await client.session()
  return client.request('PUT', `/internal/design/pages/${id}/draft`, document, {
    'if-match': `"${revision}"`,
  })
}

const query = (client: TestClient, page: string, component: string, body: unknown = {}) =>
  client.send('POST', `/internal/pages/${page}/components/${component}/query`, body)

describe('manager limits (§8.6)', () => {
  it('reject grants above the ceiling, wider restrictions and unknown roles or sources', async () => {
    const w = await world()
    const page = (
      await w.manager.send('POST', '/internal/design/pages', {
        sectionId: null,
        kind: 'dashboard',
        slug: 'kasse',
        title: 'Kasse',
      })
    ).json<PageDetail>()
    const base = kassePage(w)
    const zahlung = access(w, 'zahlung').id
    const attempt = async (document: PageDocumentInput) => {
      const response = await saveDraft(w.manager, page.id, page.draftRevision, document)
      expect(response.statusCode).toBe(422)
      return problem(response).errors
    }
    // Delete is not in the ceiling of `zahlung` (R/C/U); a query only ever reads.
    expect(
      await attempt({
        ...base,
        access: {
          ...base.access,
          grants: [
            ...base.access.grants,
            { principal: w.roles.kasse.id, source: `table:${zahlung}`, ops: ['delete'] },
            { principal: w.roles.orga.id, source: `query:${w.queries.offen.id}`, ops: ['create'] },
          ],
        },
      }),
    ).toEqual([
      { field: 'access.grants.5', code: 'exceeds_ceiling', params: { ops: 'delete' } },
      { field: 'access.grants.6', code: 'exceeds_ceiling', params: { ops: 'create' } },
    ])
    const restricted = structuredClone(base)
    const form = restricted.rows[1]?.blocks[0]
    if (form?.type !== 'form') throw new Error('fixture')
    form.restrictions = [{ principal: w.roles.orga.id, ops: ['create'] }]
    expect(await attempt(restricted)).toEqual([
      {
        field: 'rows.1.blocks.0.restrictions.0',
        code: 'restriction_widens',
        params: { ops: 'create' },
      },
    ])
    expect(
      await attempt({
        ...base,
        access: {
          view: [...base.access.view, '01890000-0000-7000-8000-00000000beef'],
          grants: [
            ...base.access.grants,
            {
              principal: w.roles.kasse.id,
              source: `table:${access(w, 'person').id}`,
              ops: ['read'],
            },
          ],
        },
      }),
    ).toEqual([{ field: 'access.grants.5', code: 'unknown_source', params: { ops: 'read' } }])
    // A component reading an object without table access, or an excluded column.
    const hidden = structuredClone(base)
    hidden.rows = [
      {
        id: 'r1',
        layout: '12',
        blocks: [
          {
            id: 'hotels',
            type: 'table',
            title: 'Hotels',
            restrictions: [],
            source: { kind: 'table', tableAccessId: access(w, 'hotel').id, cacheTtlSeconds: 60 },
            bindings: [],
            table: {
              columns: [
                { kind: 'column', id: 'mail', column: { path: [], column: 'kontakt_email' } },
              ],
              sort: null,
              searchColumns: [],
              baseFilter: [],
              bindings: [],
              pageSize: 50,
            },
          },
        ],
      },
    ]
    hidden.access = { view: [w.roles.orga.id], grants: [] }
    expect(await attempt(hidden)).toEqual([
      { field: 'rows.0.blocks.0.table.columns.0.column', code: 'excluded_column' },
    ])
    // Nothing above was saved.
    const stored = (
      await w.manager.request('GET', `/internal/design/pages/${page.id}`)
    ).json<PageDetail>()
    expect(stored.draftRevision).toBe(1)
    expect(stored.draft.access.grants).toEqual([])
    // D15: a deleted role is a warning, so the draft stays editable and the role removable.
    const gone = '01890000-0000-7000-8000-00000000beef'
    const saved = await saveDraft(w.manager, page.id, page.draftRevision, {
      ...base,
      access: {
        view: [...base.access.view, gone],
        grants: [
          ...base.access.grants,
          { principal: gone, source: `table:${zahlung}`, ops: ['read'] },
        ],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json<PageDetail>().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'access.view.2',
          code: 'unknown_role',
          severity: 'warning',
        }),
        expect.objectContaining({ path: 'access.grants.5.principal', severity: 'warning' }),
      ]),
    )
    const published = await w.manager.send('POST', `/internal/design/pages/${page.id}/publish`)
    expect(published.statusCode, published.body).toBe(200)
  })

  it('detect conflicting drafts and keep design routes from users', async () => {
    const w = await world()
    const page = await createPage(w, 'kasse', kassePage(w), false)
    const stale = await saveDraft(w.manager, page.id, page.draftRevision - 1, kassePage(w))
    expect(stale.statusCode).toBe(409)
    expect(stale.json<{ code: string; current: PageDetail }>()).toMatchObject({
      code: 'conflict',
      current: { id: page.id, draftRevision: page.draftRevision },
    })
    const missing = await w.manager.request(
      'PUT',
      `/internal/design/pages/${page.id}/draft`,
      kassePage(w),
    )
    expect(problem(missing).errors).toEqual([{ field: 'if-match', code: 'required' }])
    for (const client of [w.users.kasse, w.users.nobody]) {
      expect(problem(await client.request('GET', '/internal/design/pages')).code).toBe('forbidden')
      expect(problem(await saveDraft(client, page.id, page.draftRevision, kassePage(w))).code).toBe(
        'forbidden',
      )
      expect(
        problem(await client.send('POST', `/internal/design/pages/${page.id}/publish`)).code,
      ).toBe('forbidden')
    }
    // An unpublished page does not exist for users.
    expect(problem(await w.users.kasse.request('GET', '/internal/pages/kasse')).code).toBe(
      'not_found',
    )
  })
})

describe('page and component rights', () => {
  it('show every user exactly the pages and components of their roles', async () => {
    const w = await world()
    const kasse = await createPage(w, 'kasse', kassePage(w))
    await createPage(w, 'lindenhof', guestPage(w, 1, w.roles.lindenhof.id, 'Lindenhof'))
    await createPage(w, 'adler', guestPage(w, 2, w.roles.adler.id, 'Adler'))
    const nav = async (client: TestClient) =>
      (await client.request('GET', '/internal/navigation')).json<Navigation>()
    expect((await nav(w.users.kasse)).pages.map((page) => page.slug)).toEqual(['kasse'])
    expect((await nav(w.users.lindenhof)).pages.map((page) => page.slug)).toEqual(['lindenhof'])
    expect(await nav(w.users.nobody)).toEqual({ sections: [], pages: [], home: null })
    // Managers see every published page in navigation.
    expect((await nav(w.manager)).pages.map((page) => page.slug)).toEqual([
      'kasse',
      'lindenhof',
      'adler',
    ])

    const render = async (client: TestClient) =>
      (await client.request('GET', '/internal/pages/kasse')).json<RenderPage>()
    const cashier = await render(w.users.kasse)
    expect(
      cashier.rows.map((row) => [row.layout, row.components.map((c) => [c.id, c.ops])]),
    ).toEqual([
      [
        '8-4',
        [
          ['offene-posten', ['read']],
          ['summe', ['read']],
        ],
      ],
      ['12', [['zahlung-erfassen', ['create']]]],
    ])
    // Orga reads the open items, but the metric is restricted and the form needs create.
    const orga = await render(w.users.orga)
    expect(orga.rows.map((row) => [row.layout, row.components.map((c) => c.id)])).toEqual([
      ['12', ['offene-posten']],
    ])
    // Server-only configuration never reaches the client (§8.4).
    const guests = (
      await w.users.lindenhof.request('GET', '/internal/pages/lindenhof')
    ).json<RenderPage>()
    const text = JSON.stringify([cashier, orga, guests])
    for (const secret of [
      'SELECT',
      'v_zahlungsstatus',
      'baseFilter',
      'hotel_id',
      'queryId',
      'tableAccessId',
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(guests.table?.table?.columns.map((column) => column.id)).toEqual([
      'anreise',
      'gast',
      'eingecheckt',
    ])
    expect(problem(await w.users.lindenhof.request('GET', '/internal/pages/adler')).code).toBe(
      'not_found',
    )
    expect(problem(await w.users.lindenhof.request('GET', '/internal/pages/kasse')).code).toBe(
      'not_found',
    )

    // Authorized reads pass on to the database, which this test cannot reach.
    const read = await query(w.users.kasse, kasse.id, 'offene-posten')
    expect(problem(read).code).toBe('target_unavailable')
  })

  it('reject foreign components, extra fields, manipulated parameters and cursors', async () => {
    const w = await world()
    const kasse = await createPage(w, 'kasse', kassePage(w))
    const lindenhof = await createPage(
      w,
      'lindenhof',
      guestPage(w, 1, w.roles.lindenhof.id, 'Lindenhof'),
    )
    const adler = await createPage(w, 'adler', guestPage(w, 2, w.roles.adler.id, 'Adler'))
    const code = async (response: Promise<{ json: () => unknown }>) => problem(await response).code

    // Another hotel's page, its component, or an unknown component: not found.
    expect(await code(query(w.users.lindenhof, adler.id, 'gaeste'))).toBe('not_found')
    expect(await code(query(w.users.lindenhof, lindenhof.id, 'offene-posten'))).toBe('not_found')
    expect(await code(query(w.users.lindenhof, kasse.id, 'offene-posten'))).toBe('not_found')
    expect(
      await code(
        w.users.lindenhof.request('GET', `/internal/pages/${adler.id}/components/gaeste/rows/1`),
      ),
    ).toBe('not_found')
    expect(await code(query(w.users.nobody, kasse.id, 'offene-posten'))).toBe('not_found')
    // Orga does not get the restricted metric or the form at all.
    expect(await code(query(w.users.orga, kasse.id, 'summe'))).toBe('not_found')
    expect(await code(query(w.users.orga, kasse.id, 'zahlung-erfassen'))).toBe('not_found')
    // The cashier sees the form, but reading through it is another operation.
    expect(await code(query(w.users.kasse, kasse.id, 'zahlung-erfassen'))).toBe('forbidden')

    // Extra fields, unknown filters and URL parameters, server-set parameters.
    const extra = await query(w.users.kasse, kasse.id, 'offene-posten', { limit: 100000 })
    expect(problem(extra).errors).toEqual([{ field: 'limit', code: 'not_allowed' }])
    const filters = await query(w.users.kasse, kasse.id, 'offene-posten', {
      filters: { status: 'offen' },
      params: { current_event_id: 1, current_user_id: 'x' },
    })
    expect(problem(filters).errors).toEqual([
      { field: 'filters.status', code: 'not_allowed' },
      { field: 'params.current_event_id', code: 'not_allowed' },
      { field: 'params.current_user_id', code: 'not_allowed' },
    ])
    // A forged or foreign cursor.
    const forged = await query(w.users.lindenhof, lindenhof.id, 'gaeste', {
      cursor: 'eyJ4IjoxfQ.abc',
    })
    expect(problem(forged).code).toBe('cursor_invalid')
    // Edit and preview mode are for designers.
    for (const mode of ['edit', 'preview']) {
      expect(await code(query(w.users.kasse, kasse.id, 'offene-posten', { mode }))).toBe(
        'forbidden',
      )
      expect(await code(w.users.kasse.request('GET', `/internal/pages/kasse?mode=${mode}`))).toBe(
        'forbidden',
      )
    }
    // Malformed IDs never reach access control.
    expect(await code(query(w.users.kasse, 'not-a-page', 'offene-posten'))).toBe(
      'validation_failed',
    )
    expect(await code(query(w.users.kasse, kasse.id, '../x'))).toBe('not_found')
  })

  it('preview and edit the draft with the rights of chosen roles', async () => {
    const w = await world()
    const page = await createPage(
      w,
      'lindenhof',
      guestPage(w, 1, w.roles.lindenhof.id, 'Lindenhof'),
    )
    const preview = (roles: string[]) =>
      w.manager.request('GET', `/internal/pages/lindenhof?mode=preview&roles=${roles.join(',')}`)
    expect((await preview([w.roles.lindenhof.id])).json<RenderPage>()).toMatchObject({
      table: { id: 'gaeste' },
      viewable: true,
    })
    // Adler does not see the page: the preview says so instead of only showing nothing.
    expect((await preview([w.roles.adler.id])).json<RenderPage>()).toMatchObject({
      table: null,
      viewable: false,
    })
    const edit = (
      await w.manager.request('GET', '/internal/pages/lindenhof?mode=edit')
    ).json<RenderPage>()
    expect(edit).toMatchObject({
      mode: 'edit',
      version: null,
      table: { readable: true, issues: [] },
    })
    // Preview reads with the chosen roles only.
    expect(
      problem(
        await query(w.manager, page.id, 'gaeste', { mode: 'preview', roles: [w.roles.adler.id] }),
      ).code,
    ).toBe('not_found')
    expect(
      problem(
        await query(w.manager, page.id, 'gaeste', {
          mode: 'preview',
          roles: [w.roles.lindenhof.id],
        }),
      ).code,
    ).toBe('target_unavailable')
    // In runtime mode the manager's own (missing) roles decide.
    expect(problem(await query(w.manager, page.id, 'gaeste')).code).toBe('not_found')
  })

  it('narrow rights at once when ceilings, exclusions or roles change', async () => {
    const w = await world()
    const kasse = await createPage(w, 'kasse', kassePage(w))
    const zahlung = access(w, 'zahlung')
    // The admin lowers the ceiling of `zahlung` to read: the form is gone immediately.
    const lowered = await w.s.admin.send('PUT', `/internal/admin/table-access/${zahlung.id}`, {
      ops: ['read'],
      keyColumn: 'id',
      displayTemplate: null,
      apiResource: zahlung.apiResource,
      mcpEnabled: false,
      exclusions: [],
    })
    expect(lowered.statusCode).toBe(200)
    const cashier = (await w.users.kasse.request('GET', '/internal/pages/kasse')).json<RenderPage>()
    expect(cashier.rows.flatMap((row) => row.components.map((c) => c.id))).toEqual([
      'offene-posten',
      'summe',
    ])
    const issues = (await w.manager.request('GET', '/internal/design/issues')).json<{
      data: { pageId: string; published: { path: string; code: string }[] }[]
    }>()
    expect(issues.data.find((entry) => entry.pageId === kasse.id)?.published).toContainEqual(
      expect.objectContaining({ path: 'access.grants.4', code: 'exceeds_ceiling' }),
    )

    // Excluding a column the query reads takes it off the page too.
    const view = access(w, 'v_zahlungsstatus')
    await w.s.admin.send('PUT', `/internal/admin/table-access/${view.id}`, {
      ops: ['read'],
      keyColumn: 'anmeldung_id',
      displayTemplate: null,
      apiResource: view.apiResource,
      mcpEnabled: false,
      exclusions: [{ column: 'offen', scope: 'all' }],
    })
    expect(problem(await query(w.users.kasse, kasse.id, 'offene-posten')).code).toBe('not_found')

    // D15: a deleted role no longer has rights; the page shows an issue.
    await w.s.admin.send('DELETE', `/internal/design/roles/${w.roles.kasse.id}`)
    expect(problem(await w.users.kasse.request('GET', '/internal/pages/kasse')).code).toBe(
      'not_found',
    )
    const after = (await w.manager.request('GET', '/internal/design/issues')).json<{
      data: { pageId: string; published: { code: string }[] }[]
    }>()
    expect(after.data.find((entry) => entry.pageId === kasse.id)?.published).toContainEqual(
      expect.objectContaining({ code: 'unknown_role' }),
    )

    // Losing a role takes effect on the next request.
    const lindenhof = await createPage(
      w,
      'lindenhof',
      guestPage(w, 1, w.roles.lindenhof.id, 'Lindenhof'),
    )
    const id = (await w.users.lindenhof.request('GET', '/internal/session')).json<{
      user: { id: string }
    }>().user.id
    await w.s.admin.send('PUT', `/internal/admin/users/${id}/roles`, { roleIds: [] })
    expect(problem(await query(w.users.lindenhof, lindenhof.id, 'gaeste')).code).toBe('not_found')
  })

  it('derive the permission overview and keep used queries and variables', async () => {
    const w = await world()
    const page = await createPage(
      w,
      'lindenhof',
      guestPage(w, 1, w.roles.lindenhof.id, 'Lindenhof'),
    )
    await createPage(w, 'kasse', kassePage(w))
    const overview = await w.s.admin.request(
      'GET',
      '/internal/admin/permissions?object=hotel_kontingent',
    )
    expect(overview.json<{ data: PermissionEntry[] }>().data).toEqual([
      {
        connectionId: w.demo.connectionId,
        object: 'hotel_kontingent',
        principal: w.roles.lindenhof.id,
        pageId: page.id,
        pageTitle: 'Lindenhof',
        componentId: 'gaeste',
        ops: ['read'],
      },
    ])
    expect(problem(await w.manager.request('GET', '/internal/admin/permissions')).code).toBe(
      'forbidden',
    )
    // A schema change lists the published components it affects (§9.3).
    const impact = await (
      w.s.server.services.catalog as unknown as {
        impact(
          connectionId: string,
          diff: unknown,
        ): Promise<{ kind: string; id: string; reason: string }[]>
      }
    ).impact(w.demo.connectionId, {
      addedObjects: [],
      removedObjects: [],
      changedObjects: [
        {
          object: 'hotelbuchung',
          addedColumns: [],
          removedColumns: ['anreise'],
          changedColumns: [],
          keysChanged: false,
        },
        {
          object: 'v_zahlungsstatus',
          addedColumns: [],
          removedColumns: [],
          changedColumns: [{ column: 'offen', fields: ['dataType'] }],
          keysChanged: false,
        },
      ],
    })
    const components = impact.filter((item) => item.kind === 'component')
    expect(components.map((item) => [item.id.split(':')[1], item.reason])).toEqual([
      ['gaeste', 'column_removed'],
      ['offene-posten', 'column_changed'],
      ['summe', 'column_changed'],
    ])
    expect(components[0]?.id).toBe(`${page.id}:gaeste`)
    const used = (
      await w.manager.request('GET', `/internal/design/queries/${w.queries.offen.id}`)
    ).json<Query>()
    expect(used.usedBy.map((entry) => entry.title)).toEqual(['Kasse'])
    expect(
      problem(await w.manager.send('DELETE', `/internal/design/queries/${w.queries.offen.id}`))
        .code,
    ).toBe('in_use')
    const variables = (await w.manager.request('GET', '/internal/design/variables')).json<{
      data: { id: string }[]
    }>()
    expect(
      problem(
        await w.manager.send('DELETE', `/internal/design/variables/${variables.data[0]?.id ?? ''}`),
      ).code,
    ).toBe('in_use')
  })
})
