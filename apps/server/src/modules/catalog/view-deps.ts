// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import nodeSqlParser from 'node-sql-parser'

const parser = new nodeSqlParser.Parser()

/** `schema`.`object` not followed by a third part (which would be a column). */
const qualified = /`((?:[^`]|``)+)`\.`((?:[^`]|``)+)`(?!\s*\.)/g

/**
 * Tables and views a MariaDB view reads, from its definition (MySQL has
 * `VIEW_TABLE_USAGE` instead). MariaDB stores definitions with every table qualified by
 * its schema, but with nested parentheses that node-sql-parser does not always accept;
 * those qualified names are the fallback.
 */
export function viewTables(definition: string, database: string): string[] {
  if (definition.trim() === '') return []
  const names = new Set<string>()
  try {
    for (const entry of parser.tableList(definition, { database: 'MariaDB' })) {
      const [, schema, table] = entry.split('::')
      if (table === undefined) continue
      if (schema !== undefined && schema !== 'null' && schema !== database) continue
      names.add(table)
    }
  } catch {
    for (const match of definition.matchAll(qualified)) {
      const schema = (match[1] ?? '').replace(/``/g, '`')
      const table = (match[2] ?? '').replace(/``/g, '`')
      if (schema === database) names.add(table)
    }
  }
  return [...names].sort()
}
