// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { isTextKind, type CatalogObject } from '@stashley/shared'

/** A `{column}` or `{relation.column}` placeholder of a display template. */
export interface Placeholder {
  relation?: string
  column: string
}

const pattern = /\{([^{}.\s]+)(?:\.([^{}.\s]+))?\}/g

/** Placeholders in order; text between them is kept literally. */
export function placeholders(template: string): Placeholder[] {
  return [...template.matchAll(pattern)].map((match) =>
    match[2] === undefined
      ? { column: match[1] ?? '' }
      : { relation: match[1] ?? '', column: match[2] },
  )
}

/**
 * Default display template: the first text column that is not excluded, otherwise the key
 * column (§ Beziehungen). The key column can never be excluded for everyone.
 */
export function defaultTemplate(
  object: CatalogObject | undefined,
  keyColumn: string | null,
  excluded: ReadonlySet<string> = new Set(),
): string {
  const text = object?.columns.find(
    (column) => isTextKind(column.kind) && !excluded.has(column.name),
  )
  if (text !== undefined) return `{${text.name}}`
  return keyColumn === null ? '' : `{${keyColumn}}`
}

export type TemplateProblem =
  'invalid' | 'unknown_column' | 'excluded_column' | 'unknown_relation' | 'target_not_exposed'

/** What a template may read: the catalog, the object's relations and the table access. */
export interface TemplateContext {
  object: CatalogObject
  objects: ReadonlyMap<string, CatalogObject>
  /** Relations whose source is `object`. */
  relations: readonly { sourceColumn: string; targetObject: string }[]
  /** Columns of `object` excluded for everyone. */
  excluded: ReadonlySet<string>
  /** Table access of another object, if it is exposed and readable. */
  target: (name: string) => { excluded: ReadonlySet<string> } | undefined
}

/**
 * Checks a template against the current catalog and table access (§8.3: every object
 * involved needs `read`, and no column used may be excluded). `{relation.column}` follows
 * one relation, named by its source column or, if unambiguous, by its target object.
 */
export function checkTemplate(
  template: string,
  context: TemplateContext,
): TemplateProblem | undefined {
  const parts = placeholders(template)
  if (parts.length === 0) return 'invalid'
  for (const part of parts) {
    if (part.relation === undefined) {
      if (!context.object.columns.some((column) => column.name === part.column)) {
        return 'unknown_column'
      }
      if (context.excluded.has(part.column)) return 'excluded_column'
      continue
    }
    const bySource = context.relations.filter((relation) => relation.sourceColumn === part.relation)
    const byTarget = context.relations.filter((relation) => relation.targetObject === part.relation)
    const relation = bySource[0] ?? (byTarget.length === 1 ? byTarget[0] : undefined)
    if (relation === undefined) return 'unknown_relation'
    const target = context.objects.get(relation.targetObject)
    if (target === undefined || !target.columns.some((column) => column.name === part.column)) {
      return 'unknown_column'
    }
    const access = context.target(relation.targetObject)
    if (access === undefined) return 'target_not_exposed'
    if (access.excluded.has(part.column)) return 'excluded_column'
  }
  return undefined
}
