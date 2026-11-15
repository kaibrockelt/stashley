// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { capabilityOf, componentKindOf, noOps, toMask, toOps } from '@stashley/shared'
import type { Block, DashboardRowInput, PageDocument, TableOp } from './types.ts'
import { layoutsFor } from '../workspace/grid-layout.ts'

/**
 * Pure edits of a page document for the editor. Every function returns a new document; the
 * server validates the result on save (§8.6).
 */

/** A component or row ID that is unique in the document. */
export function newId(document: PageDocument, prefix: string): string {
  const used = new Set<string>([
    ...document.rows.map((row) => row.id),
    ...document.rows.flatMap((row) => row.blocks.map((block) => block.id)),
    ...document.filters.map((filter) => filter.id),
    ...(document.table === null ? [] : [document.table.id]),
  ])
  for (let n = 1; ; n += 1) {
    const id = `${prefix}${n}`
    if (!used.has(id)) return id
  }
}

export function sourceKeyOf(block: Block): string | undefined {
  if (block.type === 'text') return undefined
  return block.source.kind === 'query'
    ? `query:${block.source.queryId}`
    : `table:${block.source.tableAccessId}`
}

/** Sources still used by a component; select filters need no grants. */
function usedSources(document: PageDocument): Set<string> {
  const keys = new Set<string>()
  const blocks =
    document.table === null ? document.rows.flatMap((row) => row.blocks) : [document.table]
  for (const block of blocks) {
    const key = sourceKeyOf(block)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/** Drops grants on sources no component uses any more. */
function pruneGrants(document: PageDocument): PageDocument {
  const used = usedSources(document)
  return {
    ...document,
    access: {
      ...document.access,
      grants: document.access.grants.filter((grant) => used.has(grant.source)),
    },
  }
}

const withRows = (document: PageDocument, rows: DashboardRowInput[]): PageDocument => ({
  ...document,
  rows,
})

export function addRow(document: PageDocument, block: Block): PageDocument {
  return withRows(document, [
    ...document.rows,
    { id: newId(document, 'r'), layout: '12', blocks: [block] },
  ])
}

export function removeRow(document: PageDocument, rowId: string): PageDocument {
  return pruneGrants(
    withRows(
      document,
      document.rows.filter((row) => row.id !== rowId),
    ),
  )
}

export function reorderRows(document: PageDocument, ids: readonly string[]): PageDocument {
  const byId = new Map(document.rows.map((row) => [row.id, row]))
  return withRows(
    document,
    ids.flatMap((id) => byId.get(id) ?? []),
  )
}

export function setRowLayout(
  document: PageDocument,
  rowId: string,
  layout: DashboardRowInput['layout'],
): PageDocument {
  return withRows(
    document,
    document.rows.map((row) =>
      row.id === rowId && row.blocks.length === layout.split('-').length ? { ...row, layout } : row,
    ),
  )
}

/** The first layout for a block count: 12, 6-6, 4-4-4 or 3-3-3-3. */
function layoutFor(count: number): DashboardRowInput['layout'] {
  return layoutsFor(count)[0] ?? '12'
}

export function addBlock(document: PageDocument, rowId: string, block: Block): PageDocument {
  return withRows(
    document,
    document.rows.map((row) =>
      row.id === rowId && row.blocks.length < 4
        ? { ...row, blocks: [...row.blocks, block], layout: layoutFor(row.blocks.length + 1) }
        : row,
    ),
  )
}

export function replaceBlock(
  document: PageDocument,
  block: Block,
  previousId = block.id,
): PageDocument {
  if (document.table !== null && document.table.id === previousId) {
    return pruneGrants({ ...document, table: block as PageDocument['table'] })
  }
  return pruneGrants(
    withRows(
      document,
      document.rows.map((row) => ({
        ...row,
        blocks: row.blocks.map((entry) => (entry.id === previousId ? block : entry)),
      })),
    ),
  )
}

export function removeBlock(document: PageDocument, blockId: string): PageDocument {
  const rows = document.rows.flatMap((row) => {
    if (!row.blocks.some((block) => block.id === blockId)) return [row]
    const blocks = row.blocks.filter((block) => block.id !== blockId)
    return blocks.length === 0 ? [] : [{ ...row, blocks, layout: layoutFor(blocks.length) }]
  })
  return pruneGrants(withRows(document, rows))
}

export function reorderBlocks(
  document: PageDocument,
  rowId: string,
  ids: readonly string[],
): PageDocument {
  return withRows(
    document,
    document.rows.map((row) => {
      if (row.id !== rowId) return row
      const byId = new Map(row.blocks.map((block) => [block.id, block]))
      const blocks = ids.flatMap((id) => byId.get(id) ?? [])
      // Asymmetric layouts follow their blocks: 8-4 becomes 4-8 when the two swap.
      const layout =
        row.layout === '8-4' || row.layout === '4-8'
          ? blocks[0]?.id === row.blocks[0]?.id
            ? row.layout
            : row.layout === '8-4'
              ? '4-8'
              : '8-4'
          : row.layout
      return { ...row, blocks, layout }
    }),
  )
}

/** Moves a block to the end of another row, or into a new row with `target` null. */
export function moveBlock(
  document: PageDocument,
  blockId: string,
  target: string | null,
): PageDocument {
  const block = document.rows.flatMap((row) => row.blocks).find((entry) => entry.id === blockId)
  if (block === undefined) return document
  const targetRow = document.rows.find((row) => row.id === target)
  if (
    targetRow !== undefined &&
    (targetRow.blocks.length >= 4 || targetRow.blocks.some((entry) => entry.id === blockId))
  ) {
    return document
  }
  const removed = withRows(
    document,
    document.rows.flatMap((row) => {
      if (!row.blocks.some((entry) => entry.id === blockId)) return [row]
      const blocks = row.blocks.filter((entry) => entry.id !== blockId)
      return blocks.length === 0 ? [] : [{ ...row, blocks, layout: layoutFor(blocks.length) }]
    }),
  )
  if (target === null) return addRow(removed, block)
  return addBlock(removed, target, block)
}

/** Operations a principal has on a source of the page (§8.2). */
export function grantOf(document: PageDocument, principal: string, source: string): TableOp[] {
  return (
    document.access.grants.find((grant) => grant.principal === principal && grant.source === source)
      ?.ops ?? []
  )
}

/**
 * Operations the rights of `block`'s source can usefully grant (§8.2): what the blocks of the
 * page that use this source can do, within the source's ceiling. `block` is the edited
 * version and replaces its saved one; an unknown ceiling limits nothing.
 */
export function offeredOps(
  document: PageDocument,
  block: Block,
  ceiling: readonly TableOp[] | undefined,
): TableOp[] {
  const source = sourceKeyOf(block)
  if (source === undefined) return []
  const users = [
    ...blocksOf(document).filter((entry) => entry.id !== block.id && sourceKeyOf(entry) === source),
    block,
  ]
  let mask = noOps
  for (const entry of users) mask |= capabilityOf(componentKindOf(entry))
  if (ceiling !== undefined) mask &= toMask(ceiling)
  return toOps(mask)
}

export function setGrant(
  document: PageDocument,
  principal: string,
  source: string,
  ops: TableOp[],
): PageDocument {
  const others = document.access.grants.filter(
    (grant) => !(grant.principal === principal && grant.source === source),
  )
  const grants =
    ops.length === 0
      ? others
      : [...others, { principal: principal as never, source: source as never, ops }]
  return { ...document, access: { ...document.access, grants } }
}

/** Who sees the page; grants of principals that no longer see it are dropped. */
export function setViewers(document: PageDocument, view: string[]): PageDocument {
  const visible = new Set(view)
  return {
    ...document,
    access: {
      view: view,
      grants: document.access.grants.filter((grant) => visible.has(grant.principal)),
    },
  }
}

/** Principals the document names that are neither `authenticated` nor a known role (D15). */
export function unknownPrincipals(document: PageDocument, roleIds: readonly string[]): string[] {
  const known = new Set<string>(['authenticated', ...roleIds])
  const named = [
    ...document.access.view,
    ...document.access.grants.map((grant) => grant.principal),
    ...blocksOf(document).flatMap((block) =>
      block.restrictions.map((restriction) => restriction.principal),
    ),
  ]
  return [...new Set(named.filter((principal) => !known.has(principal)))]
}

function blocksOf(document: PageDocument): Block[] {
  return document.table === null ? document.rows.flatMap((row) => row.blocks) : [document.table]
}

/** Removes deleted roles from the viewers, the grants and every block's restrictions. */
export function withoutPrincipals(
  document: PageDocument,
  principals: readonly string[],
): PageDocument {
  const removed = new Set(principals)
  const clean = <T extends Block>(block: T): T => ({
    ...block,
    restrictions: block.restrictions.filter((restriction) => !removed.has(restriction.principal)),
  })
  return {
    ...document,
    access: {
      view: document.access.view.filter((principal) => !removed.has(principal)),
      grants: document.access.grants.filter((grant) => !removed.has(grant.principal)),
    },
    rows: document.rows.map((row) => ({ ...row, blocks: row.blocks.map(clean) })),
    table: document.table === null ? null : clean(document.table),
  }
}

/** Sets an optional description; an empty one is removed. */
export function withDescription<T extends { description?: string | undefined }>(
  value: T,
  description: string,
): T {
  const next = { ...value }
  if (description === '') delete next.description
  else next.description = description
  return next
}
