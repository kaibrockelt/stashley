// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { emptyPage, type Block, type PageDocument } from './page.ts'
import { diffPages, withoutPins } from './page-diff.ts'

const text = (id: string, markdown = 'x'): Block => ({
  id,
  type: 'text',
  title: id,
  restrictions: [],
  markdown,
})

function page(rows: PageDocument['rows']): PageDocument {
  return { ...emptyPage('dashboard', 'Overview'), rows }
}

describe('diffPages', () => {
  it('finds nothing in equal documents', () => {
    const doc = page([{ id: 'r1', layout: '6-6', blocks: [text('a'), text('b')] }])
    expect(diffPages(doc, structuredClone(doc))).toEqual([])
  })

  it('reports page settings, filters and rows', () => {
    const a = page([{ id: 'r1', layout: '12', blocks: [text('a')] }])
    const b: PageDocument = {
      ...page([
        { id: 'r2', layout: '12', blocks: [text('c')] },
        { id: 'r1', layout: '12', blocks: [text('a')] },
      ]),
      title: 'Start',
      filters: [{ kind: 'text', id: 'q', label: 'Search', required: false }],
    }
    expect(diffPages(a, b)).toEqual([
      { scope: 'page', path: 'title', kind: 'changed', before: 'Overview', after: 'Start' },
      { scope: 'filter:q', path: '', kind: 'added', after: b.filters[0] },
      { scope: 'row:r2', path: '', kind: 'added', after: { layout: '12' } },
      { scope: 'component:c', path: '', kind: 'added', after: text('c') },
    ])
    expect(diffPages(b, a).map((change) => [change.scope, change.kind])).toEqual([
      ['page', 'changed'],
      ['filter:q', 'removed'],
      ['row:r2', 'removed'],
      ['component:c', 'removed'],
    ])
  })

  it('reports moved blocks and rows, layouts and settings', () => {
    const a = page([
      { id: 'r1', layout: '6-6', blocks: [text('a'), text('b')] },
      { id: 'r2', layout: '12', blocks: [text('c')] },
    ])
    const b = page([
      { id: 'r2', layout: '12', blocks: [text('c', 'new')] },
      { id: 'r1', layout: '8-4', blocks: [text('b'), text('a')] },
    ])
    expect(diffPages(a, b)).toEqual([
      { scope: 'row:r1', path: 'layout', kind: 'changed', before: '6-6', after: '8-4' },
      {
        scope: 'page',
        path: 'rows.order',
        kind: 'moved',
        before: ['r1', 'r2'],
        after: ['r2', 'r1'],
      },
      { scope: 'component:c', path: 'markdown', kind: 'changed', before: 'x', after: 'new' },
      { scope: 'component:b', path: '', kind: 'moved', before: 'r1:1', after: 'r1:0' },
      { scope: 'component:a', path: '', kind: 'moved', before: 'r1:0', after: 'r1:1' },
    ])
    const c = page([{ id: 'r1', layout: '12', blocks: [text('a')] }])
    const d = page([
      { id: 'r1', layout: '12', blocks: [text('a')] },
      { id: 'r9', layout: '12', blocks: [text('z')] },
    ])
    expect(diffPages(c, d).some((change) => change.path === 'rows.order')).toBe(false)
  })

  it('matches table columns by ID and diffs nested settings', () => {
    const table = (columns: string[], settings: Record<string, unknown>): PageDocument => ({
      ...emptyPage('table', 'People'),
      rows: [],
      table: {
        id: 't',
        type: 'table',
        title: 'People',
        restrictions: [],
        source: {
          kind: 'table',
          tableAccessId: '0f7d2c1e-6a43-4ac0-9a43-1d1c6a4f1f10',
          cacheTtlSeconds: 0,
        },
        bindings: [],
        table: {
          columns: columns.map((id) => ({ kind: 'column', id, column: { path: [], column: id } })),
          sort: null,
          searchColumns: [],
          baseFilter: [],
          bindings: [],
          pageSize: 50,
        },
        settings,
      },
    })
    const changes = diffPages(
      table(['a', 'b'], { formats: { a: { kind: 'integer' } } }),
      table(['b', 'c'], {}),
    )
    expect(changes).toEqual([
      {
        scope: 'component:t',
        path: 'table.columns[a]',
        kind: 'removed',
        before: expect.objectContaining({ id: 'a' }) as unknown,
      },
      {
        scope: 'component:t',
        path: 'table.columns[c]',
        kind: 'added',
        after: expect.objectContaining({ id: 'c' }) as unknown,
      },
      {
        scope: 'component:t',
        path: 'settings.formats',
        kind: 'removed',
        before: { a: { kind: 'integer' } },
      },
    ])
    const reordered = diffPages(table(['a', 'b'], {}), table(['b', 'a'], {}))
    expect(reordered).toEqual([
      {
        scope: 'component:t',
        path: 'table.columns.order',
        kind: 'moved',
        before: ['a', 'b'],
        after: ['b', 'a'],
      },
    ])
  })

  it('compares other arrays as whole values', () => {
    const a = { ...page([]), access: { view: ['authenticated'], grants: [] } } as PageDocument
    const b = { ...page([]), access: { view: [], grants: [] } } as PageDocument
    expect(diffPages(a, b)).toEqual([
      { scope: 'page', path: 'access.view', kind: 'changed', before: ['authenticated'], after: [] },
    ])
  })

  it('ignores pinned query versions when asked', () => {
    const queryId = '0196f3a4-1111-7000-8000-000000000001'
    const chart = (version?: number): Block => ({
      id: 'c',
      type: 'chart',
      title: 'c',
      restrictions: [],
      source: { kind: 'query', queryId, ...(version !== undefined && { version }) },
      bindings: [],
    })
    const filter = (version?: number): PageDocument['filters'][number] => ({
      kind: 'select',
      id: 'f',
      label: 'f',
      source: { kind: 'query', queryId, ...(version !== undefined && { version }) },
      valueColumn: 'id',
      labelColumn: 'name',
      multiple: false,
      required: false,
    })
    const published = {
      ...page([{ id: 'r1', layout: '12', blocks: [chart(3)] }]),
      filters: [filter(3)],
    }
    const draft = { ...page([{ id: 'r1', layout: '12', blocks: [chart()] }]), filters: [filter()] }
    expect(diffPages(published, draft)).toHaveLength(2)
    expect(diffPages(withoutPins(published), withoutPins(draft))).toEqual([])
    expect(
      withoutPins({
        ...emptyPage('table', 'x'),
        table: { ...chart(2), type: 'table', table: null } as never,
      }).table,
    ).toMatchObject({
      source: { kind: 'query', queryId },
    })
  })
})
