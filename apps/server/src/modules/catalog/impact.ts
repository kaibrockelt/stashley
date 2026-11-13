// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ImpactItem, SchemaDiff } from '@stashley/shared'
import { placeholders } from '../table-access/templates.ts'

export interface ImpactInput {
  accesses: {
    id: string
    objectName: string
    keyColumn: string | null
    displayTemplate: string | null
    exclusions: string[]
  }[]
  relations: {
    id: string
    sourceObject: string
    sourceColumn: string
    targetObject: string
    targetColumn: string
  }[]
}

/**
 * Lists what a schema change affects: table access, exclusions, display templates and
 * virtual relations. Queries, components and API endpoints join this list in later
 * milestones (§9.3).
 */
export function impactOf(diff: SchemaDiff, input: ImpactInput): ImpactItem[] {
  const removedObjects = new Set(diff.removedObjects)
  const changes = new Map(diff.changedObjects.map((change) => [change.object, change]))
  const removed = (object: string, column: string) =>
    removedObjects.has(object) || (changes.get(object)?.removedColumns.includes(column) ?? false)
  const changed = (object: string, column: string) =>
    changes.get(object)?.changedColumns.some((entry) => entry.column === column) ?? false
  const items: ImpactItem[] = []

  for (const access of input.accesses) {
    const label = access.objectName
    if (removedObjects.has(access.objectName)) {
      items.push({ kind: 'table_access', id: access.id, label, reason: 'object_removed' })
      continue
    }
    const change = changes.get(access.objectName)
    if (change === undefined) continue
    if (access.keyColumn !== null && removed(access.objectName, access.keyColumn)) {
      items.push({ kind: 'table_access', id: access.id, label, reason: 'column_removed' })
    } else if (change.keysChanged) {
      items.push({ kind: 'table_access', id: access.id, label, reason: 'key_changed' })
    }
    for (const column of access.exclusions) {
      if (removed(access.objectName, column)) {
        items.push({
          kind: 'column_exclusion',
          id: access.id,
          label: `${label}.${column}`,
          reason: 'column_removed',
        })
      }
    }
  }

  for (const access of input.accesses) {
    if (access.displayTemplate === null || removedObjects.has(access.objectName)) continue
    for (const placeholder of placeholders(access.displayTemplate)) {
      const object = placeholder.relation ?? access.objectName
      if (removed(object, placeholder.column) || changed(object, placeholder.column)) {
        items.push({
          kind: 'display_template',
          id: access.id,
          label: access.objectName,
          reason: removed(object, placeholder.column) ? 'column_removed' : 'column_changed',
        })
        break
      }
    }
  }

  for (const relation of input.relations) {
    const label = `${relation.sourceObject}.${relation.sourceColumn} → ${relation.targetObject}.${relation.targetColumn}`
    if (removedObjects.has(relation.sourceObject) || removedObjects.has(relation.targetObject)) {
      items.push({ kind: 'relation', id: relation.id, label, reason: 'object_removed' })
    } else if (
      removed(relation.sourceObject, relation.sourceColumn) ||
      removed(relation.targetObject, relation.targetColumn)
    ) {
      items.push({ kind: 'relation', id: relation.id, label, reason: 'column_removed' })
    } else if (
      changed(relation.sourceObject, relation.sourceColumn) ||
      changed(relation.targetObject, relation.targetColumn)
    ) {
      items.push({ kind: 'relation', id: relation.id, label, reason: 'column_changed' })
    }
  }
  return items
}
