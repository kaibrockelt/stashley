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

/** Default display template: the first text column, otherwise the key column (§ Beziehungen). */
export function defaultTemplate(
  object: CatalogObject | undefined,
  keyColumn: string | null,
): string {
  const text = object?.columns.find((column) => isTextKind(column.kind))
  if (text !== undefined) return `{${text.name}}`
  return keyColumn === null ? '' : `{${keyColumn}}`
}
