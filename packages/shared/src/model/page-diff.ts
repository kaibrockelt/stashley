// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageDocument } from './page.ts'

/**
 * Structured diff of two page documents (architecture §13.2), per component and per setting.
 * Arrays of objects with an `id` (rows, blocks, filters, table columns) are matched by ID, so a
 * moved block shows as moved, not as removed and added. Other arrays compare as a whole value.
 */

export interface PageChange {
  /** `page`, `filter:<id>`, `row:<id>` or `component:<id>`. */
  scope: string
  /** Setting path inside the scope, e.g. `settings.measures`; empty for the scope itself. */
  path: string
  kind: 'added' | 'removed' | 'changed' | 'moved'
  before?: unknown
  after?: unknown
}

type Plain = Record<string, unknown>

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasIds = (value: unknown): value is { id: string }[] =>
  Array.isArray(value) && value.every((item) => isPlain(item) && typeof item.id === 'string')

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equal(item, b[i]))
  if (isPlain(a) && isPlain(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (!equal(a[key], b[key])) return false
    return true
  }
  return false
}

const join = (base: string, key: string) => (base === '' ? key : `${base}.${key}`)

function diffValue(scope: string, path: string, a: unknown, b: unknown, out: PageChange[]): void {
  if (equal(a, b)) return
  if (a === undefined) {
    out.push({ scope, path, kind: 'added', after: b })
    return
  }
  if (b === undefined) {
    out.push({ scope, path, kind: 'removed', before: a })
    return
  }
  if (isPlain(a) && isPlain(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValue(scope, join(path, key), a[key], b[key], out)
    }
    return
  }
  if (hasIds(a) && hasIds(b) && path !== '') {
    diffList(scope, path, a, b, out)
    return
  }
  out.push({ scope, path, kind: 'changed', before: a, after: b })
}

/** Lists of objects with IDs inside a component, such as table columns. */
function diffList(
  scope: string,
  path: string,
  a: { id: string }[],
  b: { id: string }[],
  out: PageChange[],
): void {
  const before = new Map(a.map((item) => [item.id, { item }]))
  const after = new Map(b.map((item) => [item.id, { item }]))
  for (const [id, { item }] of before) {
    if (!after.has(id)) out.push({ scope, path: `${path}[${id}]`, kind: 'removed', before: item })
  }
  for (const [id, { item }] of after) {
    const old = before.get(id)
    if (old === undefined) {
      out.push({ scope, path: `${path}[${id}]`, kind: 'added', after: item })
      continue
    }
    diffValue(scope, `${path}[${id}]`, old.item, item, out)
  }
  const order = (list: { id: string }[], other: Map<string, unknown>) =>
    list.filter((item) => other.has(item.id)).map((item) => item.id)
  if (!equal(order(a, after), order(b, before))) {
    out.push({
      scope,
      path: `${path}.order`,
      kind: 'moved',
      before: order(a, after),
      after: order(b, before),
    })
  }
}

interface Located {
  value: Plain
  /** Row ID and index within the row, or `table`. */
  at: string
}

function components(page: PageDocument): Map<string, Located> {
  const map = new Map<string, Located>()
  if (page.table !== null) map.set(page.table.id, { value: page.table, at: 'table' })
  page.rows.forEach((row) =>
    row.blocks.forEach((block, i) => map.set(block.id, { value: block, at: `${row.id}:${i}` })),
  )
  return map
}

/**
 * The document without pinned query versions: publishing pins them (§13.2), so a published
 * version and the draft it came from would otherwise always differ.
 */
export function withoutPins(document: PageDocument): PageDocument {
  const copy = JSON.parse(JSON.stringify(document)) as PageDocument
  for (const filter of copy.filters) if (filter.kind === 'select') delete filter.source.version
  const blocks = copy.table === null ? copy.rows.flatMap((row) => row.blocks) : [copy.table]
  for (const block of blocks) {
    if (block.type !== 'text' && block.source.kind === 'query') delete block.source.version
  }
  return copy
}

export function diffPages(a: PageDocument, b: PageDocument): PageChange[] {
  const out: PageChange[] = []
  const pageFields = (page: PageDocument): Plain => {
    const fields: Plain = { ...page }
    delete fields.rows
    delete fields.table
    delete fields.filters
    return fields
  }
  const { rows: rowsA, filters: filtersA } = a
  const { rows: rowsB, filters: filtersB } = b
  diffValue('page', '', pageFields(a), pageFields(b), out)

  const filterMapA = new Map(filtersA.map((filter) => [filter.id, filter]))
  const filterMapB = new Map(filtersB.map((filter) => [filter.id, filter]))
  for (const [id, filter] of filterMapA)
    if (!filterMapB.has(id))
      out.push({ scope: `filter:${id}`, path: '', kind: 'removed', before: filter })
  for (const [id, filter] of filterMapB) {
    const old = filterMapA.get(id)
    if (old === undefined)
      out.push({ scope: `filter:${id}`, path: '', kind: 'added', after: filter })
    else diffValue(`filter:${id}`, '', old, filter, out)
  }

  const rowMapA = new Map(rowsA.map((row) => [row.id, row]))
  const rowMapB = new Map(rowsB.map((row) => [row.id, row]))
  for (const [id, row] of rowMapA)
    if (!rowMapB.has(id))
      out.push({ scope: `row:${id}`, path: '', kind: 'removed', before: { layout: row.layout } })
  for (const [id, row] of rowMapB) {
    const old = rowMapA.get(id)
    if (old === undefined)
      out.push({ scope: `row:${id}`, path: '', kind: 'added', after: { layout: row.layout } })
    else if (old.layout !== row.layout)
      out.push({
        scope: `row:${id}`,
        path: 'layout',
        kind: 'changed',
        before: old.layout,
        after: row.layout,
      })
  }
  const rowOrder = (rows: typeof rowsA, other: Map<string, unknown>) =>
    rows.filter((row) => other.has(row.id)).map((row) => row.id)
  if (!equal(rowOrder(rowsA, rowMapB), rowOrder(rowsB, rowMapA))) {
    out.push({
      scope: 'page',
      path: 'rows.order',
      kind: 'moved',
      before: rowOrder(rowsA, rowMapB),
      after: rowOrder(rowsB, rowMapA),
    })
  }

  const componentsA = components(a)
  const componentsB = components(b)
  for (const [id, { value }] of componentsA)
    if (!componentsB.has(id))
      out.push({ scope: `component:${id}`, path: '', kind: 'removed', before: value })
  for (const [id, located] of componentsB) {
    const old = componentsA.get(id)
    if (old === undefined) {
      out.push({ scope: `component:${id}`, path: '', kind: 'added', after: located.value })
      continue
    }
    if (old.at !== located.at)
      out.push({
        scope: `component:${id}`,
        path: '',
        kind: 'moved',
        before: old.at,
        after: located.at,
      })
    diffValue(`component:${id}`, '', old.value, located.value, out)
  }
  return out
}
