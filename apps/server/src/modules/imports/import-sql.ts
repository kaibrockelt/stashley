// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  sql,
  type RawBuilder,
} from 'kysely'
import type { Statement } from '../queries/sql-guard/executable.ts'

/**
 * Batch SQL of the CSV import (§17 step 6): one table per statement, every value bound,
 * multi-row `INSERT` for new rows and a row-value `IN` for the lookup of existing keys.
 */

const compiler = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new MysqlIntrospector(db),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  },
})

function compile(query: RawBuilder<unknown>): Statement {
  const compiled = query.compile(compiler)
  return { sql: compiled.sql, values: [...compiled.parameters] }
}

/** A cell the database fills with the column default. */
export const useDefault = Symbol('default')
export type CellValue = unknown

function value(item: CellValue): RawBuilder<unknown> {
  return item === useDefault ? sql`DEFAULT` : sql`${item}`
}

export function insertRows(
  object: string,
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
): Statement {
  if (columns.length === 0) {
    return compile(
      sql`INSERT INTO ${sql.table(object)} () VALUES ${sql.join(rows.map(() => sql`()`))}`,
    )
  }
  return compile(
    sql`INSERT INTO ${sql.table(object)} (${sql.join(columns.map((column) => sql.ref(column)))}) VALUES ${sql.join(
      rows.map((row) => sql`(${sql.join(row.map(value))})`),
    )}`,
  )
}

function keyMatch(columns: readonly string[], keys: readonly (readonly unknown[])[]) {
  if (columns.length === 1) {
    return sql`${sql.ref(columns[0] as string)} IN (${sql.join(keys.map((key) => sql`${key[0]}`))})`
  }
  return sql`(${sql.join(columns.map((column) => sql.ref(column)))}) IN (${sql.join(
    keys.map((key) => sql`(${sql.join(key.map((item) => sql`${item}`))})`),
  )})`
}

/** Rows whose key columns equal one of `keys`: the key columns first, then `columns`. */
export function rowsByKeys(
  object: string,
  keyColumns: readonly string[],
  columns: readonly string[],
  keys: readonly (readonly unknown[])[],
  lock: boolean,
): Statement {
  const selected = [...keyColumns, ...columns].map(
    (column, index) => sql`${sql.ref(column)} AS ${sql.id(`c${index}`)}`,
  )
  return compile(
    sql`SELECT ${sql.join(selected)} FROM ${sql.table(object)} WHERE ${keyMatch(keyColumns, keys)}${
      lock ? sql` FOR UPDATE` : sql``
    }`,
  )
}
