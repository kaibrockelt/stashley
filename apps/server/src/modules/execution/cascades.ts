// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject } from '@stashley/shared'

const lower = (name: string) => name.toLowerCase()

/**
 * The written table and the tables its foreign key actions change as well, so their cached
 * reads are evicted too: `ON DELETE`/`ON UPDATE` `CASCADE`, `SET NULL` and `SET DEFAULT`,
 * followed through further cascades. An action the catalog does not know (snapshots from
 * before it was read) counts as changing. Triggers stay invisible; their tables keep their
 * cache until it expires (§12).
 */
export function affectedObjects(
  catalog: ReadonlyMap<string, CatalogObject>,
  object: string,
  kind: 'delete' | 'update' | null,
  changed: readonly string[],
): string[] {
  const objects = new Set([object])
  if (kind === null) return [...objects]
  // Per table: the columns that changed, or null when its rows went away.
  const queue: { object: string; columns: readonly string[] | null }[] = [
    { object, columns: kind === 'update' ? changed.map(lower) : null },
  ]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { object: target, columns } = next
    for (const child of catalog.values()) {
      for (const key of child.foreignKeys) {
        if (key.targetObject !== target || objects.has(child.name)) continue
        const action = columns === null ? key.onDelete : key.onUpdate
        if (action === 'restrict' || action === 'no_action') continue
        if (columns !== null && !key.targetColumns.some((column) => columns.includes(lower(column))))
          continue
        objects.add(child.name)
        // A cascaded delete deletes further; any other action changes the referring columns.
        queue.push({
          object: child.name,
          columns:
            columns === null && (action === 'cascade' || action === undefined)
              ? null
              : key.columns.map(lower),
        })
      }
    }
  }
  return [...objects]
}
