// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError, ValueKind } from '@stashley/shared'
import { checkParamValue } from '@stashley/shared'
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
import type { ColumnExpr, ModelColumn, OutputExpr, TableModel } from './table-model.ts'

/** Compiles SQL text with bound values; it never connects anywhere. */
const compiler = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new MysqlIntrospector(db),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  },
})

export const columnFilterOperators = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'contains',
  'null',
  'not_null',
] as const
export type ColumnFilterOperator = (typeof columnFilterOperators)[number]

export interface ColumnFilter {
  columnId: string
  operator: ColumnFilterOperator
  value?: unknown
}

/** Where a page continues: after (`next`) or before (`prev`) the row with these raw values. */
export interface CursorPosition {
  direction: 'next' | 'prev'
  sort: unknown
  key: unknown
}

export interface TableRequest {
  sort?: { columnId: string; direction: 'asc' | 'desc' } | undefined
  search?: string | undefined
  filters: readonly ColumnFilter[]
  cursor?: CursorPosition | undefined
  limit: number
}

/** Values resolved on the server for one request. */
export interface ResolvedValues {
  /** Per base filter condition: its bound value, already typed for the column. */
  baseFilter: readonly unknown[]
  /** Per binding: the client's filter or URL value, or undefined when it is not set. */
  bindings: readonly unknown[]
}

export interface ValueOptions {
  /** The connection's time zone, for DATETIME values. */
  connectionTimeZone: string
  /** The instance's display time zone, for the day boundaries of date filters. */
  displayTimeZone: string
}

export interface SelectStatement extends Statement {
  /** Output aliases in model column order, then the key `k` and the raw sort value `s`. */
  outputs: ModelColumn[]
  /** True when the sort is the key itself; then there is no separate sort value. */
  sortIsKey: boolean
  /** Rows come back in reverse order and must be turned around (`prev`). */
  reversed: boolean
}

/** Values the client sent that do not fit the column; field errors on the request. */
export class TableRequestError extends Error {
  readonly errors: FieldError[]

  constructor(errors: FieldError[]) {
    super('Invalid table request')
    this.name = 'TableRequestError'
    this.errors = errors
  }
}

const like = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`

/**
 * A value typed for a column (§9.5, D13): DATETIME values are wall times of the connection,
 * TIMESTAMP values UTC (the session runs in UTC).
 */
export function bindForColumn(
  kind: ValueKind,
  value: unknown,
  options: ValueOptions,
): { ok: true; value: unknown } | { ok: false; code: string } {
  switch (kind) {
    case 'integer':
    case 'bigint':
    case 'year':
      return checkParamValue('integer', value)
    case 'decimal':
    case 'float':
      return checkParamValue('decimal', value)
    case 'date':
      return checkParamValue('date', value)
    case 'datetime':
    case 'timestamp': {
      const checked = checkParamValue('datetime', value)
      if (!checked.ok) return checked
      const zone = kind === 'datetime' ? options.connectionTimeZone : 'UTC'
      return { ok: true, value: wallTime(checked.value as string, zone) }
    }
    case 'boolean': {
      const checked = checkParamValue('boolean', value)
      return checked.ok ? { ok: true, value: checked.value === true ? 1 : 0 } : checked
    }
    case 'time':
      return typeof value === 'string' && /^\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(value)
        ? { ok: true, value }
        : { ok: false, code: 'invalid' }
    case 'string':
    case 'enum':
    case 'set':
      return checkParamValue('string', value)
    default:
      return { ok: false, code: 'not_filterable' }
  }
}

/** The start of a calendar day in the display time zone, as a column value. */
function dayStart(date: string, kind: ValueKind, options: ValueOptions): string {
  const instant = Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: options.displayTimeZone })
    .toInstant()
    .toString()
  return wallTime(instant, kind === 'datetime' ? options.connectionTimeZone : 'UTC')
}

function nextDay(date: string): string {
  return Temporal.PlainDate.from(date).add({ days: 1 }).toString()
}

function columnSql(expr: ColumnExpr): RawBuilder<unknown> {
  return sql.ref(`${expr.alias}.${expr.column}`)
}

/** Display values: `CONCAT` over `COALESCE`d parts, with the literal text bound (§10.6). */
function outputSql(expr: OutputExpr): RawBuilder<unknown> {
  if (expr.type === 'column') return columnSql(expr)
  const parts = expr.parts.map((part) =>
    typeof part === 'string' ? sql`${part}` : sql`COALESCE(CAST(${columnSql(part)} AS CHAR), '')`,
  )
  return sql`CONCAT(${sql.join(parts)})`
}

function aliasesOf(expr: OutputExpr): string[] {
  if (expr.type === 'column') return [expr.alias]
  return expr.parts.flatMap((part) => (typeof part === 'string' ? [] : [part.alias]))
}

interface Conditions {
  sql: RawBuilder<unknown>[]
  aliases: Set<string>
}

/** Base filter, page filter bindings, column filters and search, combined with AND. */
function conditions(
  model: TableModel,
  values: ResolvedValues,
  request: Pick<TableRequest, 'filters' | 'search'>,
  options: ValueOptions,
): Conditions {
  const out: RawBuilder<unknown>[] = []
  const aliases = new Set<string>()
  const errors: FieldError[] = []

  model.baseFilter.forEach((condition, index) => {
    aliases.add(condition.expr.alias)
    out.push(comparison(columnSql(condition.expr), condition.operator, values.baseFilter[index]))
  })

  model.bindings.forEach((binding, index) => {
    const value = values.bindings[index]
    if (value === undefined || value === null || value === '') return
    aliases.add(binding.expr.alias)
    const column = columnSql(binding.expr)
    const field = `bindings.${index}`
    const kind = binding.expr.kind
    if (binding.operator === 'contains') {
      if (typeof value !== 'string') return void errors.push({ field, code: 'invalid' })
      out.push(sql`${column} LIKE ${like(value)}`)
      return
    }
    const range = dateRange(value)
    if (binding.operator === 'range' || (range !== undefined && kind !== 'date')) {
      if (range === undefined) return void errors.push({ field, code: 'invalid' })
      if (kind === 'date') {
        if (range.from !== undefined) out.push(sql`${column} >= ${range.from}`)
        if (range.to !== undefined) out.push(sql`${column} <= ${range.to}`)
      } else if (kind === 'datetime' || kind === 'timestamp') {
        if (range.from !== undefined)
          out.push(sql`${column} >= ${dayStart(range.from, kind, options)}`)
        if (range.to !== undefined) {
          out.push(sql`${column} < ${dayStart(nextDay(range.to), kind, options)}`)
        }
      } else errors.push({ field, code: 'not_a_date' })
      return
    }
    const list = Array.isArray(value) ? value : [value]
    const bound: unknown[] = []
    for (const item of list) {
      const checked = bindForColumn(kind, item, options)
      if (!checked.ok) return void errors.push({ field, code: checked.code })
      bound.push(checked.value)
    }
    if (bound.length === 0) return
    out.push(
      binding.operator === 'in' || bound.length > 1
        ? sql`${column} IN (${sql.join(bound.map((item) => sql`${item}`))})`
        : sql`${column} = ${bound[0]}`,
    )
  })

  const byId = new Map(model.columns.map((column) => [column.id, column]))
  request.filters.forEach((filter, index) => {
    const field = `filters.${index}`
    const column = byId.get(filter.columnId)
    if (column === undefined)
      return void errors.push({ field: `${field}.columnId`, code: 'unknown_column' })
    for (const alias of aliasesOf(column.expr)) aliases.add(alias)
    const expr = outputSql(column.expr)
    if (filter.operator === 'null' || filter.operator === 'not_null') {
      out.push(filter.operator === 'null' ? sql`${expr} IS NULL` : sql`${expr} IS NOT NULL`)
      return
    }
    if (filter.operator === 'contains') {
      if (typeof filter.value !== 'string' || filter.value === '') {
        return void errors.push({ field: `${field}.value`, code: 'invalid' })
      }
      out.push(sql`${expr} LIKE ${like(filter.value)}`)
      return
    }
    if (column.expr.type === 'template') {
      return void errors.push({ field: `${field}.operator`, code: 'not_allowed' })
    }
    if (filter.operator === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 1000) {
        return void errors.push({ field: `${field}.value`, code: 'invalid' })
      }
      const bound: unknown[] = []
      for (const item of filter.value as unknown[]) {
        const checked = bindForColumn(column.kind, item, options)
        if (!checked.ok) return void errors.push({ field: `${field}.value`, code: checked.code })
        bound.push(checked.value)
      }
      out.push(sql`${expr} IN (${sql.join(bound.map((item) => sql`${item}`))})`)
      return
    }
    const checked = bindForColumn(column.kind, filter.value, options)
    if (!checked.ok) return void errors.push({ field: `${field}.value`, code: checked.code })
    out.push(comparison(expr, filter.operator, checked.value))
  })

  const search = request.search?.trim() ?? ''
  if (search !== '' && model.searchColumns.length > 0) {
    const terms = model.searchColumns.map((id) => {
      // The model checked that every search column exists.
      const column = byId.get(id) as ModelColumn
      for (const alias of aliasesOf(column.expr)) aliases.add(alias)
      return sql`${outputSql(column.expr)} LIKE ${like(search)}`
    })
    out.push(sql`(${sql.join(terms, sql` OR `)})`)
  }

  if (errors.length > 0) throw new TableRequestError(errors)
  return { sql: out, aliases }
}

function dateRange(value: unknown): { from?: string; to?: string } | undefined {
  const date = (entry: unknown) => typeof entry === 'string' && checkParamValue('date', entry).ok
  if (typeof value === 'string') return date(value) ? { from: value, to: value } : undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { from, to } = value as { from?: unknown; to?: unknown }
  if ((from !== undefined && !date(from)) || (to !== undefined && !date(to))) return undefined
  if (from === undefined && to === undefined) return undefined
  return {
    ...(from !== undefined && { from: from as string }),
    ...(to !== undefined && { to: to as string }),
  }
}

function comparison(
  expr: RawBuilder<unknown>,
  operator: string,
  value: unknown,
): RawBuilder<unknown> {
  switch (operator) {
    case 'eq':
      return sql`${expr} = ${value}`
    case 'ne':
      return sql`${expr} <> ${value}`
    case 'lt':
      return sql`${expr} < ${value}`
    case 'lte':
      return sql`${expr} <= ${value}`
    case 'gt':
      return sql`${expr} > ${value}`
    case 'gte':
      return sql`${expr} >= ${value}`
    case 'in': {
      const list = Array.isArray(value) ? value : [value]
      // An empty list matches nothing, like a filter that excludes everything.
      if (list.length === 0) return sql`1 = 0`
      return sql`${expr} IN (${sql.join(list.map((item) => sql`${item}`))})`
    }
    case 'null':
      return sql`${expr} IS NULL`
    default:
      return sql`${expr} IS NOT NULL`
  }
}

/** Joins needed for these aliases, with every parent of a needed join. */
function neededJoins(model: TableModel, aliases: ReadonlySet<string>) {
  const needed = new Set(aliases)
  for (const join of [...model.joins].reverse()) {
    if (needed.has(join.alias)) needed.add(join.parent)
  }
  return model.joins.filter((join) => needed.has(join.alias))
}

function from(model: TableModel, joins: TableModel['joins']): RawBuilder<unknown> {
  return sql`${sql.table(model.object)} AS ${sql.id('t0')}${sql.join(
    joins.map(
      (join) =>
        sql` LEFT JOIN ${sql.table(join.object)} AS ${sql.id(join.alias)} ON ${sql.ref(
          `${join.alias}.${join.column}`,
        )} = ${sql.ref(`${join.parent}.${join.parentColumn}`)}`,
    ),
    sql``,
  )}`
}

function where(parts: RawBuilder<unknown>[]): RawBuilder<unknown> {
  return parts.length === 0 ? sql`` : sql` WHERE ${sql.join(parts, sql` AND `)}`
}

/**
 * Keyset predicate after (or before) a position, NULL-aware (§10.6): ascending order puts
 * NULLs first, descending last, as MySQL and MariaDB sort them.
 */
function keyset(
  sort: RawBuilder<unknown>,
  key: RawBuilder<unknown>,
  descending: boolean,
  position: CursorPosition,
): RawBuilder<unknown> {
  const after = descending ? sql`<` : sql`>`
  if (position.sort === null || position.sort === undefined) {
    return descending
      ? sql`(${sort} IS NULL AND ${key} ${after} ${position.key})`
      : sql`((${sort} IS NULL AND ${key} ${after} ${position.key}) OR ${sort} IS NOT NULL)`
  }
  const tie = sql`(${sort} = ${position.sort} AND ${key} ${after} ${position.key})`
  return descending
    ? sql`(${sort} ${after} ${position.sort} OR ${tie} OR ${sort} IS NULL)`
    : sql`(${sort} ${after} ${position.sort} OR ${tie})`
}

/** One page of a table source with keyset pagination (§10.6). */
export function selectStatement(
  model: TableModel,
  values: ResolvedValues,
  request: TableRequest,
  options: ValueOptions,
): SelectStatement {
  const filter = conditions(model, values, request, options)
  const sortSpec = request.sort ?? model.sort
  const sortColumn =
    sortSpec === null ? undefined : model.columns.find((column) => column.id === sortSpec.columnId)
  if (sortSpec !== null && sortColumn === undefined) {
    throw new TableRequestError([{ field: 'sort.columnId', code: 'unknown_column' }])
  }
  const key = columnSql(model.key)
  const sortIsKey =
    sortColumn === undefined ||
    (sortColumn.expr.type === 'column' &&
      sortColumn.expr.alias === 't0' &&
      sortColumn.expr.column === model.key.column)
  const sortExpr = sortIsKey || sortColumn === undefined ? key : outputSql(sortColumn.expr)
  const reversed = request.cursor?.direction === 'prev'
  const descending = (sortSpec?.direction === 'desc') !== reversed
  const order = descending ? sql`DESC` : sql`ASC`

  const parts = [...filter.sql]
  if (request.cursor !== undefined) {
    parts.push(
      sortIsKey
        ? sql`${key} ${descending ? sql`<` : sql`>`} ${request.cursor.key}`
        : keyset(sortExpr, key, descending, request.cursor),
    )
  }
  const selected = model.columns.map(
    (column, index) => sql`${outputSql(column.expr)} AS ${sql.id(`c${index}`)}`,
  )
  selected.push(sql`${key} AS ${sql.id('k')}`)
  if (!sortIsKey) selected.push(sql`${sortExpr} AS ${sql.id('s')}`)
  const query = sql`SELECT ${sql.join(selected)} FROM ${from(model, model.joins)}${where(parts)} ORDER BY ${
    sortIsKey ? sql`${key} ${order}` : sql`${sortExpr} ${order}, ${key} ${order}`
  } LIMIT ${request.limit + 1}`
  const compiled = query.compile(compiler)
  return {
    sql: compiled.sql,
    values: [...compiled.parameters],
    outputs: model.columns,
    sortIsKey,
    reversed,
  }
}

/** The number of rows, with joins only where filters need them (§10.6). */
export function countStatement(
  model: TableModel,
  values: ResolvedValues,
  request: Pick<TableRequest, 'filters' | 'search'>,
  options: ValueOptions,
): Statement {
  const filter = conditions(model, values, request, options)
  const compiled = sql`SELECT COUNT(*) AS ${sql.id('n')} FROM ${from(
    model,
    neededJoins(model, filter.aliases),
  )}${where(filter.sql)}`.compile(compiler)
  return { sql: compiled.sql, values: [...compiled.parameters] }
}

/** One row by key, still within the base filter: a foreign key value finds nothing. */
export function rowStatement(
  model: TableModel,
  values: ResolvedValues,
  key: unknown,
): SelectStatement {
  const filter = conditions(
    model,
    values,
    { filters: [] },
    {
      connectionTimeZone: 'UTC',
      displayTimeZone: 'UTC',
    },
  )
  const keyExpr = columnSql(model.key)
  const selected = model.columns.map(
    (column, index) => sql`${outputSql(column.expr)} AS ${sql.id(`c${index}`)}`,
  )
  selected.push(sql`${keyExpr} AS ${sql.id('k')}`)
  const compiled = sql`SELECT ${sql.join(selected)} FROM ${from(model, model.joins)}${where([
    ...filter.sql,
    sql`${keyExpr} = ${key}`,
  ])} LIMIT 1`.compile(compiler)
  return {
    sql: compiled.sql,
    values: [...compiled.parameters],
    outputs: model.columns,
    sortIsKey: true,
    reversed: false,
  }
}
