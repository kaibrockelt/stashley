// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { NewTableColumn, NewTableDefinition } from '@stashley/shared'
import {
  checkNewTable,
  columnTypeText,
  isValidNewName,
  maxIdentifierLength,
} from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'

/**
 * `CREATE TABLE` for new tables (§17 step 7, E28). The statement is assembled from fixed
 * pieces only: names that pass `isValidNewName` (lower-case letters, digits, underscores, no
 * reserved word) in backticks, type texts from a closed list with checked numbers, and
 * defaults that `checkNewDefault` reduced to digits, dates or text without quotes' escape
 * characters. The definition is checked again here, so no caller can bypass the checks.
 */

const id = (name: string) => {
  // Defense in depth: the definition check allows nothing else.
  if (!isValidNewName(name))
    throw new AppError('validation_failed', { errors: [{ field: 'name', code: 'invalid_name' }] })
  return `\`${name}\``
}

function defaultClause(column: NewTableColumn): string {
  const value = column.default
  if (value === null) return ''
  if (value.kind === 'now') return ' DEFAULT CURRENT_TIMESTAMP'
  switch (column.type) {
    case 'int':
    case 'bigint':
    case 'decimal':
      // Digits, a sign and a point only (checked).
      return ` DEFAULT ${value.value}`
    case 'boolean':
      return ` DEFAULT ${value.value === 'true' ? '1' : '0'}`
    default:
      // Dates and text: no backslash and no control character (checked); quotes doubled.
      return ` DEFAULT '${value.value.replace(/'/g, "''")}'`
  }
}

/** A unique key name: `uq_<column>`, shortened and made distinct. */
function keyNames(columns: readonly string[]): Map<string, string> {
  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const column of columns) {
    let name = `uq_${column}`.slice(0, maxIdentifierLength)
    for (let index = 2; used.has(name); index++) {
      const suffix = `_${index}`
      name = `uq_${column}`.slice(0, maxIdentifierLength - suffix.length) + suffix
    }
    used.add(name)
    names.set(column, name)
  }
  return names
}

/**
 * The `CREATE TABLE` statement of a checked definition. `taken` are the object names the
 * catalog knows; a name the read user cannot see still fails at the database (1050).
 */
export function createTableStatement(
  definition: NewTableDefinition,
  context: { taken: readonly string[]; sourceCount?: number | undefined },
): string {
  const errors = checkNewTable(definition, context)
  if (errors.length > 0) throw new AppError('validation_failed', { errors })
  const key = definition.primaryKey
  const lines: string[] = []
  if (key.kind === 'added') lines.push(`  ${id(key.name)} BIGINT NOT NULL AUTO_INCREMENT`)
  for (const column of definition.columns) {
    const isKey = key.kind === 'column' && key.column === column.name
    const notNull = column.required || isKey
    lines.push(
      `  ${id(column.name)} ${columnTypeText(column)} ${notNull ? 'NOT NULL' : 'NULL'}${defaultClause(column)}`,
    )
  }
  lines.push(`  PRIMARY KEY (${id(key.kind === 'added' ? key.name : key.column)})`)
  const unique = definition.columns
    .filter((column) => column.unique && !(key.kind === 'column' && key.column === column.name))
    .map((column) => column.name)
  const names = keyNames(unique)
  for (const column of unique) {
    lines.push(`  UNIQUE KEY ${id(names.get(column) as string)} (${id(column)})`)
  }
  return `CREATE TABLE ${id(definition.name)} (\n${lines.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
}
