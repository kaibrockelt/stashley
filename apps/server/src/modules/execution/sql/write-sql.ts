// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ValueKind } from '@stashley/shared'
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  sql,
  type RawBuilder,
} from 'kysely'
import type { Statement } from '../../queries/sql-guard/executable.ts'
import { wallTime } from './parameters.ts'

/**
 * Generated SQL of the write path (§11). Statements name one table and bind every value;
 * there is no free write SQL. Row locks take only the written table: `FOR UPDATE` over a
 * join would lock (and on MySQL need write privileges on) the joined tables as well, so the
 * base filter is checked by a separate read of the locked row.
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

/**
 * A column value to write: SQL for the server's own expressions (the version increment, the
 * column default of `PUT /:id`), otherwise a bound value.
 */
export type WriteValue = { value: unknown } | { expression: 'increment' | 'default' }

const equals = (entries: readonly [string, unknown][]) =>
  sql.join(
    entries.map(([column, value]) => sql`${sql.ref(column)} = ${value}`),
    sql` AND `,
  )

/**
 * Canonical JSON values (§9.5) as the driver binds them for a column: DATETIME as the wall
 * time of the connection, TIMESTAMP in UTC (the session runs in UTC), booleans as 1 or 0,
 * sets as their comma list.
 */
export function bindWrite(kind: ValueKind, value: unknown, connectionTimeZone: string): unknown {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'boolean':
      return value === true ? 1 : 0
    case 'datetime':
      return wallTime(value as string, connectionTimeZone)
    case 'timestamp':
      return wallTime(value as string, 'UTC')
    case 'set':
      return (value as string[]).join(',')
    default:
      return value
  }
}

/** The written table's row by key, locked for this transaction unless `lock` is false. */
export function lockRow(
  object: string,
  keyColumn: string,
  columns: readonly string[],
  key: unknown,
  lock = true,
): Statement {
  return lockWhere(object, keyColumn, columns, [[keyColumn, key]], lock)
}

/** Columns in order, then the key as `k`; locked (`FOR UPDATE`) unless `lock` is false. */
export function lockWhere(
  object: string,
  keyColumn: string,
  columns: readonly string[],
  where: readonly [string, unknown][],
  lock = true,
): Statement {
  const selected = [
    ...columns.map((column, index) => sql`${sql.ref(column)} AS ${sql.id(`c${index}`)}`),
    sql`${sql.ref(keyColumn)} AS ${sql.id('k')}`,
  ]
  return compile(
    sql`SELECT ${sql.join(selected)} FROM ${sql.table(object)} WHERE ${equals(where)} LIMIT 1${
      lock ? sql` FOR UPDATE` : sql``
    }`,
  )
}

export function insertRow(object: string, values: readonly [string, unknown][]): Statement {
  if (values.length === 0) return compile(sql`INSERT INTO ${sql.table(object)} () VALUES ()`)
  return compile(
    sql`INSERT INTO ${sql.table(object)} (${sql.join(values.map(([column]) => sql.ref(column)))}) VALUES (${sql.join(
      values.map(([, value]) => sql`${value}`),
    )})`,
  )
}

export function updateRow(
  object: string,
  keyColumn: string,
  key: unknown,
  sets: readonly [string, WriteValue][],
): Statement {
  const parts = sets.map(([column, value]) => {
    if (!('expression' in value)) return sql`${sql.ref(column)} = ${value.value}`
    return value.expression === 'increment'
      ? sql`${sql.ref(column)} = ${sql.ref(column)} + 1`
      : sql`${sql.ref(column)} = DEFAULT`
  })
  return compile(
    sql`UPDATE ${sql.table(object)} SET ${sql.join(parts)} WHERE ${sql.ref(keyColumn)} = ${key}`,
  )
}

export function deleteRow(object: string, keyColumn: string, key: unknown): Statement {
  return compile(sql`DELETE FROM ${sql.table(object)} WHERE ${sql.ref(keyColumn)} = ${key}`)
}

/**
 * Whether a row with these values exists, optionally other than the row `except`: finds
 * the duplicate key or the missing referenced row behind a refused write.
 */
export function exists(
  object: string,
  where: readonly [string, unknown][],
  except?: { column: string; key: unknown },
): Statement {
  const parts = [equals(where)]
  if (except !== undefined) parts.push(sql`${sql.ref(except.column)} <> ${except.key}`)
  return compile(
    sql`SELECT 1 AS ${sql.id('x')} FROM ${sql.table(object)} WHERE ${sql.join(parts, sql` AND `)} LIMIT 1`,
  )
}
