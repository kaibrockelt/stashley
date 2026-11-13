// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import nodeSqlParser from 'node-sql-parser'

const parser = new nodeSqlParser.Parser()

/**
 * Tables and views a MariaDB view reads, from its definition (MySQL has
 * `VIEW_TABLE_USAGE` instead). An unparsable definition yields no dependencies.
 */
export function viewTables(definition: string, database: string): string[] {
  if (definition.trim() === '') return []
  try {
    const entries = parser.tableList(definition, { database: 'MariaDB' })
    const names = new Set<string>()
    for (const entry of entries) {
      const [, schema, table] = entry.split('::')
      if (table === undefined) continue
      if (schema !== undefined && schema !== 'null' && schema !== database) continue
      names.add(table)
    }
    return [...names].sort()
  } catch {
    return []
  }
}
