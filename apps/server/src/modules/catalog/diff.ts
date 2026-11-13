// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogColumn, CatalogObject, ObjectChange, SchemaDiff } from '@stashley/shared'

const columnFields = [
  'dataType',
  'columnType',
  'nullable',
  'defaultValue',
  'autoIncrement',
  'generated',
  'onUpdate',
] as const satisfies readonly (keyof CatalogColumn)[]

function keysOf(object: CatalogObject): string {
  return JSON.stringify([object.primaryKey, object.uniqueKeys, object.foreignKeys])
}

/** Compares two catalog snapshots; row estimates and column order are ignored. */
export function diffSnapshots(before: CatalogObject[], after: CatalogObject[]): SchemaDiff {
  const old = new Map(before.map((object) => [object.name, object]))
  const next = new Map(after.map((object) => [object.name, object]))
  const diff: SchemaDiff = {
    addedObjects: [...next.keys()].filter((name) => !old.has(name)).sort(),
    removedObjects: [...old.keys()].filter((name) => !next.has(name)).sort(),
    changedObjects: [],
  }
  for (const [name, previous] of old) {
    const current = next.get(name)
    if (current === undefined) continue
    const oldColumns = new Map(previous.columns.map((column) => [column.name, column]))
    const newColumns = new Map(current.columns.map((column) => [column.name, column]))
    const change: ObjectChange = {
      object: name,
      addedColumns: [...newColumns.keys()].filter((column) => !oldColumns.has(column)),
      removedColumns: [...oldColumns.keys()].filter((column) => !newColumns.has(column)),
      changedColumns: [],
      keysChanged: keysOf(previous) !== keysOf(current),
    }
    if (previous.type !== current.type) change.typeChanged = [previous.type, current.type]
    for (const [columnName, column] of oldColumns) {
      const updated = newColumns.get(columnName)
      if (updated === undefined) continue
      // A field missing from an older snapshot is unknown there, not changed.
      const fields = columnFields.filter(
        (field) => column[field] !== undefined && column[field] !== updated[field],
      )
      if (fields.length > 0) change.changedColumns.push({ column: columnName, fields })
    }
    if (
      change.typeChanged !== undefined ||
      change.addedColumns.length > 0 ||
      change.removedColumns.length > 0 ||
      change.changedColumns.length > 0 ||
      change.keysChanged
    ) {
      diff.changedObjects.push(change)
    }
  }
  diff.changedObjects.sort((a, b) => a.object.localeCompare(b.object))
  return diff
}

export function isEmptyDiff(diff: SchemaDiff): boolean {
  return (
    diff.addedObjects.length === 0 &&
    diff.removedObjects.length === 0 &&
    diff.changedObjects.length === 0
  )
}
