// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DesignCatalog,
  DesignConnection,
  PageDetail,
  PageDocument,
  PageSummary,
  PageVersionDetail,
  PageVersionSummary,
  Query,
  Section,
} from '@stashley/shared'
import { describe, expect, it, vi } from 'vitest'
import { TargetError } from '../../target/errors.ts'
import { describeRetryMs } from '../queries/service.ts'
import type { TestClient } from '../../test/client.ts'
import { setupDemo, type Demo } from '../../test/demo.ts'
import { createUser, problem, setupServer, type TestSetup } from '../../test/setup.ts'

/**
 * Versions, restore, navigation order, the design catalog and block settings issues (M5).
 * The target host is refused, so describing a query's result columns fails here; the tests
 * store result columns directly where they need them.
 */

const refused = () => Promise.reject(new TargetError('host_not_allowed'))

interface World {
  s: TestSetup
  demo: Demo
  manager: TestClient
  query: Query
}

async function world(): Promise<World> {
  const s = await setupServer({ resolveTargetHost: refused })
  const demo = await setupDemo(s)
  const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
  const query = (
    await manager.send('POST', '/internal/design/queries', {
      connectionId: demo.connectionId,
      name: 'Teilnehmer nach Land',
      description: '',
      sql: 'SELECT land, COUNT(*) AS anzahl FROM person GROUP BY land',
      parameters: [],
      cacheTtlSeconds: 300,
    })
  ).json<Query>()
  return { s, demo, manager, query }
}

async function createPage(w: World, slug: string, sectionId: string | null = null) {
  const response = await w.manager.send('POST', '/internal/design/pages', {
    sectionId,
    kind: 'dashboard',
    slug,
    title: slug,
  })
  expect(response.statusCode, response.body).toBe(201)
  return response.json<PageDetail>()
}

function chartPage(w: World, settings: Record<string, unknown> | undefined, title = 'Übersicht') {
  const document: PageDocument = {
    schemaVersion: 1,
    kind: 'dashboard',
    title,
    filters: [],
    parameters: [],
    rows: [
      {
        id: 'r1',
        layout: '12',
        blocks: [
          {
            id: 'laender',
            type: 'chart',
            title: 'Teilnehmer nach Land',
            restrictions: [],
            source: { kind: 'query', queryId: w.query.id },
            bindings: [],
            ...(settings !== undefined && { settings }),
          },
        ],
      },
    ],
    table: null,
    access: { view: ['authenticated'], grants: [] },
    mcp: { available: false },
  }
  return document
}

const save = (client: TestClient, id: string, revision: number, document: PageDocument) =>
  client.request('PUT', `/internal/design/pages/${id}/draft`, document, {
    'if-match': `"${revision}"`,
  })

const bar = { chart: 'bar', height: 'M', x: 'land', measures: ['anzahl'] }

async function storeColumns(w: World) {
  await w.s.server.store.db
    .updateTable('query_versions')
    .set({
      result_columns: JSON.stringify([
        { name: 'land', type: 'VARCHAR', kind: 'string', nullable: true, role: 'category' },
        { name: 'anzahl', type: 'BIGINT', kind: 'bigint', nullable: false, role: 'measure' },
      ]),
    })
    .where('query_id', '=', w.query.id)
    .execute()
}

describe('page versions', () => {
  it('lists versions, restores one into the draft and keeps the last 20', async () => {
    const w = await world()
    let page = await createPage(w, 'uebersicht')
    const versions = async () =>
      (await w.manager.request('GET', `/internal/design/pages/${page.id}/versions`)).json<{
        data: PageVersionSummary[]
      }>().data
    expect(await versions()).toEqual([])

    for (const title of ['Eins', 'Zwei']) {
      const saved = await save(w.manager, page.id, page.draftRevision, chartPage(w, bar, title))
      expect(saved.statusCode, saved.body).toBe(200)
      const published = await w.manager.send('POST', `/internal/design/pages/${page.id}/publish`)
      expect(published.statusCode, published.body).toBe(200)
      page = published.json<PageDetail>()
    }
    const list = await versions()
    expect(list.map((entry) => [entry.version, entry.current, entry.publishedBy])).toEqual([
      [2, true, 'mia@example.com'],
      [1, false, 'mia@example.com'],
    ])

    const first = (
      await w.manager.request('GET', `/internal/design/pages/${page.id}/versions/1`)
    ).json<PageVersionDetail>()
    expect(first.document.title).toBe('Eins')
    // Published documents pin query versions.
    const block = first.document.rows[0]?.blocks[0]
    expect(block?.type === 'chart' && block.source.version).toBe(1)
    expect(
      (await w.manager.request('GET', `/internal/design/pages/${page.id}/versions/9`)).statusCode,
    ).toBe(404)

    // Restore needs the current draft revision and copies the version without pins.
    const restoreUrl = `/internal/design/pages/${page.id}/versions/1/restore`
    expect(problem(await w.manager.send('POST', restoreUrl)).code).toBe('bad_request')
    const stale = await w.manager.request('POST', restoreUrl, undefined, {
      'if-match': `"${page.draftRevision - 1}"`,
    })
    expect(stale.statusCode).toBe(409)
    const restored = await w.manager.request('POST', restoreUrl, undefined, {
      'if-match': `"${page.draftRevision}"`,
    })
    expect(restored.statusCode, restored.body).toBe(200)
    const detail = restored.json<PageDetail>()
    expect(detail.draft.title).toBe('Eins')
    expect(detail.draftRevision).toBe(page.draftRevision + 1)
    const draftBlock = detail.draft.rows[0]?.blocks[0]
    expect(draftBlock?.type === 'chart' && draftBlock.source.version).toBeUndefined()
    // The published state is unchanged until the next publish.
    expect(detail.publishedVersion).toBe(2)

    const audit = await w.s.server.store.db
      .selectFrom('audit_events')
      .select('action')
      .where('action', '=', 'page.restored')
      .execute()
    expect(audit).toHaveLength(1)

    // Users have no access to the design routes.
    const { client: user } = await createUser(w.s, 'lea@example.com', 'user')
    expect(
      (await user.request('GET', `/internal/design/pages/${page.id}/versions`)).statusCode,
    ).toBe(403)
  })
})

describe('navigation order', () => {
  it('sets the order of sections and pages at once', async () => {
    const w = await world()
    const section = async (name: string) =>
      (await w.manager.send('POST', '/internal/design/sections', { name })).json<Section>()
    const event = await section('Event')
    const stationen = await section('Stationen')
    const a = await createPage(w, 'a', event.id)
    const b = await createPage(w, 'b', event.id)
    const c = await createPage(w, 'c')

    const order = {
      sections: [stationen.id, event.id],
      pages: [
        { id: c.id, sectionId: stationen.id },
        { id: b.id, sectionId: event.id },
        { id: a.id, sectionId: null },
      ],
    }
    const response = await w.manager.send('PUT', '/internal/design/navigation', order)
    expect(response.statusCode, response.body).toBe(204)
    const sections = (await w.manager.request('GET', '/internal/design/sections')).json<{
      data: Section[]
    }>().data
    expect(sections.map((entry) => entry.name)).toEqual(['Stationen', 'Event'])
    const pages = (await w.manager.request('GET', '/internal/design/pages')).json<{
      data: PageSummary[]
    }>().data
    expect(pages.map((entry) => [entry.slug, entry.sectionId])).toEqual([
      ['c', stationen.id],
      ['b', event.id],
      ['a', null],
    ])

    // Incomplete, duplicate or unknown entries change nothing.
    const bad = [
      { ...order, sections: [event.id] },
      { ...order, pages: order.pages.slice(1) },
      { ...order, pages: [...order.pages.slice(1), order.pages[1]] },
      { ...order, pages: [{ id: c.id, sectionId: crypto.randomUUID() }, ...order.pages.slice(1)] },
    ]
    for (const body of bad) {
      expect(problem(await w.manager.send('PUT', '/internal/design/navigation', body)).code).toBe(
        'validation_failed',
      )
    }
  })
})

describe('design catalog', () => {
  it('lists readable objects without excluded columns, with their relations', async () => {
    const w = await world()
    const connections = (await w.manager.request('GET', '/internal/design/connections')).json<{
      data: DesignConnection[]
    }>().data
    expect(connections.map((entry) => entry.id)).toEqual([w.demo.connectionId])
    expect(Object.keys(connections[0] ?? {})).toEqual(['id', 'name', 'engine'])

    const catalog = (
      await w.manager.request('GET', `/internal/design/catalog/${w.demo.connectionId}`)
    ).json<DesignCatalog>()
    const names = catalog.objects.map((object) => object.name)
    expect(names).toContain('person')
    expect(names).toContain('v_zahlungsstatus')
    const hotel = catalog.objects.find((object) => object.name === 'hotel')
    expect(hotel?.columns.map((column) => column.name)).not.toContain('kontakt_email')
    expect(hotel?.columns.find((column) => column.name === 'id')?.key).toBe(true)
    // The ceiling comes along, so the editor offers only rights it allows (views read only).
    expect(catalog.objects.find((object) => object.name === 'v_zahlungsstatus')?.ceiling).toEqual([
      'read',
    ])
    expect(catalog.relations).toContainEqual(
      expect.objectContaining({ sourceObject: 'anmeldung', targetObject: 'person' }),
    )
    for (const relation of catalog.relations) {
      expect(names).toContain(relation.sourceObject)
      expect(names).toContain(relation.targetObject)
    }

    expect(
      (await w.manager.request('GET', `/internal/design/catalog/${crypto.randomUUID()}`))
        .statusCode,
    ).toBe(404)
    const { client: user } = await createUser(w.s, 'lea@example.com', 'user')
    expect(
      (await user.request('GET', `/internal/design/catalog/${w.demo.connectionId}`)).statusCode,
    ).toBe(403)
  })
})

describe('block settings issues', () => {
  it('warn about missing settings and reject invalid or broken mappings', async () => {
    const w = await world()
    const page = await createPage(w, 'uebersicht')
    const codes = (detail: PageDetail) => detail.issues.map((issue) => [issue.code, issue.severity])

    const unset = await save(w.manager, page.id, page.draftRevision, chartPage(w, undefined))
    expect(unset.statusCode, unset.body).toBe(200)
    expect(codes(unset.json<PageDetail>())).toContainEqual(['settings_missing', 'warning'])

    const invalid = await save(
      w.manager,
      page.id,
      page.draftRevision + 1,
      chartPage(w, { ...bar, chart: 'pie' }),
    )
    expect(problem(invalid).errors).toContainEqual({
      field: 'rows.0.blocks.0.settings',
      code: 'settings_invalid',
      params: { field: 'chart' },
    })

    // Without known result columns only the settings themselves are checked.
    const unknown = await save(
      w.manager,
      page.id,
      page.draftRevision + 1,
      chartPage(w, { ...bar, x: 'country' }),
    )
    expect(unknown.statusCode, unknown.body).toBe(200)

    await storeColumns(w)
    const detail = (
      await w.manager.request('GET', `/internal/design/pages/${page.id}`)
    ).json<PageDetail>()
    expect(detail.issues).toContainEqual({
      path: 'rows.0.blocks.0.settings',
      code: 'mapping_broken',
      severity: 'error',
      params: { column: 'country' },
    })
    const unsuitable = await save(
      w.manager,
      page.id,
      detail.draftRevision,
      chartPage(w, { ...bar, x: 'anzahl', measures: ['land'] }),
    )
    expect(problem(unsuitable).errors).toEqual([
      {
        field: 'rows.0.blocks.0.settings',
        code: 'mapping_unsuitable',
        params: { column: 'anzahl', expected: 'dimension' },
      },
      {
        field: 'rows.0.blocks.0.settings',
        code: 'mapping_unsuitable',
        params: { column: 'land', expected: 'measure' },
      },
    ])
    const fixed = await save(w.manager, page.id, detail.draftRevision, chartPage(w, bar))
    expect(fixed.statusCode, fixed.body).toBe(200)
    expect(
      fixed.json<PageDetail>().issues.filter((issue) => issue.path.includes('settings')),
    ).toEqual([])
  })

  it('leave result columns unknown when the query cannot run, and try again later', async () => {
    const w = await world()
    const queries = w.s.server.services.queries
    const runs = vi.spyOn(queries as unknown as { runDescribe: () => unknown }, 'runDescribe')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Concurrent callers share one run.
      const [first, second] = await Promise.all([
        queries.describe(w.query.id, 1),
        queries.describe(w.query.id, 1),
      ])
      expect([first, second]).toEqual([null, null])
      expect(runs).toHaveBeenCalledTimes(1)
      // A failed version waits before it is tried again.
      expect(await queries.describe(w.query.id, 1)).toBeNull()
      expect(runs).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + describeRetryMs + 1)
      expect(await queries.describe(w.query.id, 1)).toBeNull()
      expect(runs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
    expect(await queries.describe(crypto.randomUUID(), 1)).toBeNull()
    await storeColumns(w)
    expect((await queries.stored(w.query.id))?.resultColumns?.map((column) => column.name)).toEqual(
      ['land', 'anzahl'],
    )
  })
})
