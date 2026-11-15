// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  BuilderAggregate,
  CatalogColumn,
  CatalogObject,
  FieldError,
  QuerySpec,
  TimeBucket,
  ValueKind,
} from '@stashley/shared'
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  sql,
  type RawBuilder,
} from 'kysely'

/** Compiles SQL text only; it never connects anywhere. */
const compiler = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new MysqlIntrospector(db),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  },
})

/** A relation a join may follow, physical or virtual. */
export interface BuilderRelation {
  sourceObject: string
  sourceColumn: string
  targetObject: string
  targetColumn: string
}

export interface BuilderContext {
  catalog: ReadonlyMap<string, CatalogObject>
  relations: readonly BuilderRelation[]
  /** The connection's time zone; time buckets follow it. */
  timeZone: string
  /** The server has time zone tables, so TIMESTAMP values can be converted for buckets. */
  timeZoneTables: boolean
  /** Defined parameters and whether each takes a list; a list fits only `in` and `not_in`. */
  parameterLists?: ReadonlyMap<string, boolean>
}

export type BuilderNote = 'timestamp_buckets_utc'

export interface CompiledSpec {
  sql: string
  notes: BuilderNote[]
}

export class BuilderError extends Error {
  readonly errors: FieldError[]

  constructor(errors: FieldError[]) {
    super('Invalid query builder spec')
    this.name = 'BuilderError'
    this.errors = errors
  }
}

const numericKinds = new Set<ValueKind>(['integer', 'bigint', 'decimal', 'float', 'year'])
const dateKinds = new Set<ValueKind>(['date', 'datetime', 'timestamp'])
const clockBuckets = new Set<TimeBucket>(['quarter_hour', 'hour'])

const comparisons = {
  eq: sql`=`,
  ne: sql`<>`,
  lt: sql`<`,
  lte: sql`<=`,
  gt: sql`>`,
  gte: sql`>=`,
  like: sql`LIKE`,
} as const

function literal(value: string | number | boolean): RawBuilder<unknown> {
  return sql.lit(value)
}

/**
 * Time buckets (§10.3) in the connection's time zone: DATETIME on its stored wall time,
 * TIMESTAMP through CONVERT_TZ when the server has time zone tables, otherwise in UTC.
 */
function bucket(value: RawBuilder<unknown>, unit: TimeBucket): RawBuilder<unknown> {
  switch (unit) {
    case 'quarter_hour':
      return sql`DATE_ADD(TIMESTAMP(DATE_FORMAT(${value}, '%Y-%m-%d %H:00:00')), INTERVAL (FLOOR(MINUTE(${value}) / 15) * 15) MINUTE)`
    case 'hour':
      return sql`TIMESTAMP(DATE_FORMAT(${value}, '%Y-%m-%d %H:00:00'))`
    case 'day':
      return sql`DATE(${value})`
    case 'week':
      // Weeks start on Monday; WEEKDAY() is 0 for Monday.
      return sql`DATE_SUB(DATE(${value}), INTERVAL WEEKDAY(${value}) DAY)`
    case 'month':
      return sql`DATE(DATE_FORMAT(${value}, '%Y-%m-01'))`
    case 'year':
      return sql`MAKEDATE(YEAR(${value}), 1)`
  }
}

function aggregate(fn: BuilderAggregate, value: RawBuilder<unknown> | null): RawBuilder<unknown> {
  if (value === null) return sql`COUNT(*)`
  switch (fn) {
    case 'count':
      return sql`COUNT(${value})`
    case 'count_distinct':
      return sql`COUNT(DISTINCT ${value})`
    case 'sum':
      return sql`SUM(${value})`
    case 'avg':
      return sql`AVG(${value})`
    case 'min':
      return sql`MIN(${value})`
    case 'max':
      return sql`MAX(${value})`
  }
}

/**
 * Compiles a builder spec to SQL text with Kysely's MySQL compiler (§10.3). Identifiers are
 * quoted, constants become escaped literals and parameters become `:name`; the text is
 * then validated like handwritten SQL.
 */
export function compileSpec(spec: QuerySpec, ctx: BuilderContext): CompiledSpec {
  const errors: FieldError[] = []
  const fail = (field: string, code: string) => errors.push({ field: `builder.${field}`, code })
  const notes = new Set<BuilderNote>()

  const sources = new Map<string, CatalogObject>()
  const base = ctx.catalog.get(spec.base)
  if (base === undefined) {
    fail('base', 'unknown_object')
    throw new BuilderError(errors)
  }
  sources.set('base', base)

  const joins: RawBuilder<unknown>[] = []
  spec.joins.forEach((join, index) => {
    const from = sources.get(join.from)
    const target = ctx.catalog.get(join.target)
    if (sources.has(join.alias)) fail(`joins.${index}.alias`, 'duplicate')
    if (from === undefined) fail(`joins.${index}.from`, 'unknown_alias')
    if (target === undefined) fail(`joins.${index}.target`, 'unknown_object')
    if (from === undefined || target === undefined) return
    const known = ctx.relations.some(
      (relation) =>
        (relation.sourceObject === from.name &&
          relation.sourceColumn === join.column &&
          relation.targetObject === target.name &&
          relation.targetColumn === join.targetColumn) ||
        (relation.sourceObject === target.name &&
          relation.sourceColumn === join.targetColumn &&
          relation.targetObject === from.name &&
          relation.targetColumn === join.column),
    )
    if (!known) fail(`joins.${index}`, 'unknown_relation')
    sources.set(join.alias, target)
    const kind = join.kind === 'inner' ? sql`INNER JOIN` : sql`LEFT JOIN`
    joins.push(
      sql`\n${kind} ${sql.table(target.name)} AS ${sql.id(join.alias)} ON ${sql.ref(
        `${join.alias}.${join.targetColumn}`,
      )} = ${sql.ref(`${join.from}.${join.column}`)}`,
    )
  })

  const columnOf = (field: string, alias: string, name: string): CatalogColumn | undefined => {
    const source = sources.get(alias)
    if (source === undefined) {
      fail(field, 'unknown_alias')
      return undefined
    }
    const column = source.columns.find((entry) => entry.name === name)
    if (column === undefined) fail(field, 'unknown_column')
    return column
  }

  const names = new Set<string>()
  const outputs: { name: string; expr: RawBuilder<unknown>; grouped: boolean }[] = []
  spec.columns.forEach((entry, index) => {
    const field = `columns.${index}`
    if (names.has(entry.name.toLowerCase())) fail(`${field}.name`, 'duplicate')
    names.add(entry.name.toLowerCase())
    if (entry.aggregate !== undefined && entry.bucket !== undefined) {
      fail(field, 'aggregate_and_bucket')
      return
    }
    if (entry.column === null) {
      if (entry.aggregate !== 'count') fail(`${field}.column`, 'required')
      else outputs.push({ name: entry.name, expr: sql`COUNT(*)`, grouped: false })
      return
    }
    const column = columnOf(`${field}.column`, entry.source, entry.column)
    if (column === undefined) return
    let expr: RawBuilder<unknown> = sql.ref(`${entry.source}.${entry.column}`)
    if (entry.bucket !== undefined) {
      if (
        !dateKinds.has(column.kind) ||
        (column.kind === 'date' && clockBuckets.has(entry.bucket))
      ) {
        fail(`${field}.bucket`, 'not_a_time')
        return
      }
      if (column.kind === 'timestamp') {
        if (ctx.timeZoneTables) expr = sql`CONVERT_TZ(${expr}, '+00:00', ${literal(ctx.timeZone)})`
        else notes.add('timestamp_buckets_utc')
      }
      expr = bucket(expr, entry.bucket)
    }
    if (entry.aggregate !== undefined) {
      if (
        (entry.aggregate === 'sum' || entry.aggregate === 'avg') &&
        !numericKinds.has(column.kind)
      ) {
        fail(`${field}.aggregate`, 'not_numeric')
        return
      }
      expr = aggregate(entry.aggregate, expr)
    }
    outputs.push({ name: entry.name, expr, grouped: entry.aggregate === undefined })
  })

  const conditions: RawBuilder<unknown>[] = []
  spec.filters.forEach((filter, index) => {
    const field = `filters.${index}`
    if (columnOf(`${field}.column`, filter.source, filter.column) === undefined) return
    const ref = sql.ref(`${filter.source}.${filter.column}`)
    const value = filter.value
    if (filter.operator === 'null' || filter.operator === 'not_null') {
      if (value !== undefined) fail(`${field}.value`, 'not_allowed')
      else
        conditions.push(filter.operator === 'null' ? sql`${ref} IS NULL` : sql`${ref} IS NOT NULL`)
      return
    }
    if (value === undefined) {
      fail(`${field}.value`, 'required')
      return
    }
    if (value.kind === 'parameter') {
      const list = ctx.parameterLists?.get(value.name)
      const wantsList = filter.operator === 'in' || filter.operator === 'not_in'
      if (list !== undefined && list !== wantsList) {
        fail(`${field}.value`, wantsList ? 'list_expected' : 'list_not_allowed')
        return
      }
    }
    const parameter = value.kind === 'parameter' ? sql.raw(`:${value.name}`) : undefined
    const constant = value.kind === 'constant' ? value.value : undefined
    switch (filter.operator) {
      case 'in':
      case 'not_in': {
        const not = filter.operator === 'not_in' ? sql`NOT IN` : sql`IN`
        if (parameter !== undefined) {
          conditions.push(sql`${ref} ${not} (${parameter})`)
        } else if (Array.isArray(constant) && constant.length > 0) {
          conditions.push(sql`${ref} ${not} (${sql.join(constant.map(literal))})`)
        } else fail(`${field}.value`, 'invalid')
        return
      }
      case 'between':
        if (Array.isArray(constant) && constant.length === 2) {
          const [low, high] = constant as [string | number | boolean, string | number | boolean]
          conditions.push(sql`${ref} BETWEEN ${literal(low)} AND ${literal(high)}`)
        } else fail(`${field}.value`, 'invalid')
        return
      default: {
        const operator = comparisons[filter.operator]
        if (parameter !== undefined) conditions.push(sql`${ref} ${operator} ${parameter}`)
        else if (Array.isArray(constant) || constant === undefined)
          fail(`${field}.value`, 'invalid')
        else conditions.push(sql`${ref} ${operator} ${literal(constant)}`)
      }
    }
  })

  spec.sort.forEach((entry, index) => {
    if (!names.has(entry.column.toLowerCase())) fail(`sort.${index}.column`, 'unknown_column')
  })
  if (errors.length > 0) throw new BuilderError(errors)

  const aggregated = outputs.some((output) => !output.grouped)
  const groups = aggregated
    ? outputs.flatMap((output, index) => (output.grouped ? [sql.lit(index + 1)] : []))
    : []
  const empty = sql``
  const query = sql`SELECT ${sql.join(
    outputs.map((output) => sql`${output.expr} AS ${sql.id(output.name)}`),
  )}\nFROM ${sql.table(base.name)} AS ${sql.id('base')}${sql.join(joins, empty)}${
    conditions.length > 0 ? sql`\nWHERE ${sql.join(conditions, sql` AND `)}` : empty
  }${groups.length > 0 ? sql`\nGROUP BY ${sql.join(groups)}` : empty}${
    spec.sort.length > 0
      ? sql`\nORDER BY ${sql.join(
          spec.sort.map(
            (entry) =>
              sql`${sql.id(entry.column)} ${entry.direction === 'asc' ? sql`ASC` : sql`DESC`}`,
          ),
        )}`
      : empty
  }${spec.limit !== null ? sql`\nLIMIT ${sql.lit(spec.limit)}` : empty}`
  const compiled = query.compile(compiler)
  // Everything is inlined; a bound value here would be lost when the text is stored.
  if (compiled.parameters.length > 0) throw new Error('Builder SQL must not carry parameters')
  return { sql: compiled.sql, notes: [...notes] }
}
