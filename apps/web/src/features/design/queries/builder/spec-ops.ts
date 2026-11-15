// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  BuilderAggregate,
  BuilderOperator,
  DesignCatalog,
  DesignCatalogObject,
  ParamType,
  QueryParameter,
  QuerySpec,
  TimeBucket,
  ValueKind,
} from '@stashley/shared'

/**
 * Pure edits of a query builder spec (§10.3). They mirror the rules of the server's compiler,
 * so the builder offers only what compiles: joins along known relations in either direction,
 * aggregates and time buckets that fit the column, unique output names, and sort entries that
 * name an output column. The server still checks everything.
 */

export type BuilderSpec = QuerySpec
export type SpecColumn = QuerySpec['columns'][number]
export type SpecFilter = QuerySpec['filters'][number]
export type SpecJoin = QuerySpec['joins'][number]
export type ColumnFunction = BuilderAggregate | TimeBucket | 'value'

const numericKinds = new Set<ValueKind>(['integer', 'bigint', 'decimal', 'float', 'year'])
const dateKinds = new Set<ValueKind>(['date', 'datetime', 'timestamp'])
const textKinds = new Set<ValueKind>(['string', 'enum', 'set', 'json'])
const outputPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const aliasPattern = /^[a-z][a-z0-9_]{0,30}$/

export const maxColumns = 50
export const maxJoins = 10
export const maxFilters = 30
export const maxSort = 5

export function isNumericKind(kind: ValueKind | undefined): boolean {
  return kind !== undefined && numericKinds.has(kind)
}

/** Aggregates the compiler accepts on a column of this kind. */
export function aggregatesFor(kind: ValueKind | undefined): BuilderAggregate[] {
  const all: BuilderAggregate[] = ['count', 'count_distinct', 'min', 'max']
  return isNumericKind(kind) ? ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] : all
}

/** Time buckets for a column: none for non-dates, no clock buckets for DATE. */
export function bucketsFor(kind: ValueKind | undefined): TimeBucket[] {
  if (kind === undefined || !dateKinds.has(kind)) return []
  const days: TimeBucket[] = ['day', 'week', 'month', 'year']
  return kind === 'date' ? days : ['quarter_hour', 'hour', ...days]
}

export function functionsFor(kind: ValueKind | undefined): ColumnFunction[] {
  return ['value', ...aggregatesFor(kind), ...bucketsFor(kind)]
}

export function functionOf(column: SpecColumn): ColumnFunction {
  return column.aggregate ?? column.bucket ?? 'value'
}

/** Operators a filter offers on a column of this kind. */
export function operatorsFor(kind: ValueKind | undefined): BuilderOperator[] {
  const base: BuilderOperator[] = ['eq', 'ne', 'in', 'not_in', 'null', 'not_null']
  if (kind === 'boolean') return ['eq', 'ne', 'null', 'not_null']
  if (kind !== undefined && textKinds.has(kind))
    return [...base.slice(0, 2), 'like', ...base.slice(2), 'lt', 'gt']
  return ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in', 'null', 'not_null']
}

/** A parameter's type from the column it filters. */
export function paramTypeFor(kind: ValueKind | undefined): ParamType {
  switch (kind) {
    case 'integer':
    case 'bigint':
    case 'year':
      return 'integer'
    case 'decimal':
    case 'float':
      return 'decimal'
    case 'date':
      return 'date'
    case 'datetime':
    case 'timestamp':
      return 'datetime'
    case 'boolean':
      return 'boolean'
    default:
      return 'string'
  }
}

/** An identifier for output names and parameters: letters, digits, underscores. */
export function sanitize(name: string, fallback: string): string {
  const ascii = name
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const safe = ascii === '' ? fallback : /^[0-9]/.test(ascii) ? `_${ascii}` : ascii
  return safe.slice(0, 64)
}

function unique(candidate: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((name) => name.toLowerCase()))
  if (!lower.has(candidate.toLowerCase())) return candidate
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`
    const name = `${candidate.slice(0, 64 - suffix.length)}${suffix}`
    if (!lower.has(name.toLowerCase())) return name
  }
}

const functionSuffix: Record<Exclude<ColumnFunction, 'value'>, string> = {
  count: 'count',
  count_distinct: 'distinct',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  quarter_hour: 'quarter_hour',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
}

/** A suggested output name for a column and function, unique among `taken`. */
export function outputName(
  column: string | null,
  fn: ColumnFunction,
  taken: ReadonlySet<string>,
): string {
  if (column === null) return unique('row_count', taken)
  const base = sanitize(column, 'column')
  const name = fn === 'value' ? base : sanitize(`${base}_${functionSuffix[fn]}`, 'column')
  return unique(name, taken)
}

export function isValidOutputName(name: string): boolean {
  return outputPattern.test(name)
}

/** Base and joins with their objects, in order. */
export function sourcesOf(
  spec: BuilderSpec,
  catalog: DesignCatalog,
): { alias: string; object: DesignCatalogObject | undefined }[] {
  const find = (name: string) => catalog.objects.find((object) => object.name === name)
  return [
    { alias: 'base', object: find(spec.base) },
    ...spec.joins.map((join) => ({ alias: join.alias, object: find(join.target) })),
  ]
}

export function objectOf(
  spec: BuilderSpec,
  catalog: DesignCatalog,
  alias: string,
): DesignCatalogObject | undefined {
  return sourcesOf(spec, catalog).find((source) => source.alias === alias)?.object
}

export function columnKind(
  spec: BuilderSpec,
  catalog: DesignCatalog,
  alias: string,
  column: string | null,
): ValueKind | undefined {
  if (column === null) return 'bigint'
  return objectOf(spec, catalog, alias)?.columns.find((entry) => entry.name === column)?.kind
}

export interface JoinOption {
  column: string
  target: string
  targetColumn: string
  /** Along the relation (many-to-one) or against it (one-to-many). */
  direction: 'forward' | 'reverse'
}

/** Relations from the object behind `from` to other exposed objects, in both directions. */
export function joinOptions(spec: BuilderSpec, catalog: DesignCatalog, from: string): JoinOption[] {
  const object = objectOf(spec, catalog, from)
  if (object === undefined) return []
  const options: JoinOption[] = []
  for (const relation of catalog.relations) {
    if (relation.sourceObject === object.name) {
      options.push({
        column: relation.sourceColumn,
        target: relation.targetObject,
        targetColumn: relation.targetColumn,
        direction: 'forward',
      })
    }
    if (relation.targetObject === object.name) {
      options.push({
        column: relation.targetColumn,
        target: relation.sourceObject,
        targetColumn: relation.sourceColumn,
        direction: 'reverse',
      })
    }
  }
  return options
}

export function newAlias(spec: BuilderSpec, target: string): string {
  const taken = new Set(['base', ...spec.joins.map((join) => join.alias)])
  const base =
    sanitize(target.toLowerCase(), 'j')
      .toLowerCase()
      .replace(/^[^a-z]+/, '')
      .slice(0, 26) || 'j'
  const candidate = aliasPattern.test(base) ? base : 'j'
  if (!taken.has(candidate)) return candidate
  for (let n = 2; ; n += 1) if (!taken.has(`${candidate}${n}`)) return `${candidate}${n}`
}

export function addJoin(
  spec: BuilderSpec,
  from: string,
  option: JoinOption,
  kind: SpecJoin['kind'] = 'left',
): BuilderSpec {
  if (spec.joins.length >= maxJoins) return spec
  const join: SpecJoin = {
    alias: newAlias(spec, option.target),
    from,
    column: option.column,
    target: option.target,
    targetColumn: option.targetColumn,
    kind,
  }
  return { ...spec, joins: [...spec.joins, join] }
}

/** Removes a join, the joins that start from it, and every column and filter on them. */
export function removeJoin(spec: BuilderSpec, alias: string): BuilderSpec {
  const removed = new Set([alias])
  let grew = true
  while (grew) {
    grew = false
    for (const join of spec.joins) {
      if (!removed.has(join.alias) && removed.has(join.from)) {
        removed.add(join.alias)
        grew = true
      }
    }
  }
  const columns = spec.columns.filter((column) => !removed.has(column.source))
  const names = new Set(columns.map((column) => column.name))
  return {
    ...spec,
    joins: spec.joins.filter((join) => !removed.has(join.alias)),
    // A spec needs one column; counting rows of the base always works.
    columns:
      columns.length > 0
        ? columns
        : [{ name: 'row_count', source: 'base', column: null, aggregate: 'count' }],
    filters: spec.filters.filter((filter) => !removed.has(filter.source)),
    sort: spec.sort.filter((entry) => names.has(entry.column)),
  }
}

/** A new spec on a base object, with its first columns. */
export function specFor(object: DesignCatalogObject): BuilderSpec {
  const taken = new Set<string>()
  const columns = object.columns.slice(0, 6).map((column) => {
    const name = outputName(column.name, 'value', taken)
    taken.add(name)
    return { name, source: 'base', column: column.name }
  })
  return {
    schemaVersion: 1,
    base: object.name,
    joins: [],
    columns,
    filters: [],
    sort: [],
    limit: null,
  }
}

export function takenNames(spec: BuilderSpec, except?: number): Set<string> {
  return new Set(spec.columns.filter((_, index) => index !== except).map((column) => column.name))
}

export function addColumn(
  spec: BuilderSpec,
  source: string,
  column: string | null,
  fn: ColumnFunction = column === null ? 'count' : 'value',
): BuilderSpec {
  if (spec.columns.length >= maxColumns) return spec
  const entry: SpecColumn = {
    name: outputName(column, fn, takenNames(spec)),
    source,
    column,
    ...(fn !== 'value' && (isBucket(fn) ? { bucket: fn } : { aggregate: fn })),
  }
  return { ...spec, columns: [...spec.columns, entry] }
}

function isBucket(fn: ColumnFunction): fn is TimeBucket {
  return (
    fn === 'quarter_hour' ||
    fn === 'hour' ||
    fn === 'day' ||
    fn === 'week' ||
    fn === 'month' ||
    fn === 'year'
  )
}

/**
 * Changes a column; a suggested name follows the new column and function unless the
 * manager typed their own. Sort entries follow a renamed column.
 */
export function updateColumn(
  spec: BuilderSpec,
  index: number,
  patch: { source?: string; column?: string | null; fn?: ColumnFunction; name?: string },
): BuilderSpec {
  const current = spec.columns[index]
  if (current === undefined) return spec
  const source = patch.source ?? current.source
  const column = patch.column !== undefined ? patch.column : current.column
  let fn = patch.fn ?? functionOf(current)
  if (column === null) fn = 'count'
  const taken = takenNames(spec, index)
  const suggested = outputName(current.column, functionOf(current), taken)
  const custom = current.name !== suggested
  const name = patch.name ?? (custom ? current.name : outputName(column, fn, taken))
  const next: SpecColumn = {
    name,
    source,
    column,
    ...(fn !== 'value' && (isBucket(fn) ? { bucket: fn } : { aggregate: fn })),
  }
  return {
    ...spec,
    columns: spec.columns.map((entry, i) => (i === index ? next : entry)),
    sort: spec.sort.map((entry) =>
      entry.column === current.name ? { ...entry, column: name } : entry,
    ),
  }
}

export function removeColumn(spec: BuilderSpec, index: number): BuilderSpec {
  const current = spec.columns[index]
  if (current === undefined || spec.columns.length <= 1) return spec
  return {
    ...spec,
    columns: spec.columns.filter((_, i) => i !== index),
    sort: spec.sort.filter((entry) => entry.column !== current.name),
  }
}

/** Output columns the result is grouped by: every plain or bucketed column, once any column aggregates. */
export function groupingOf(spec: BuilderSpec): string[] {
  if (!spec.columns.some((column) => column.aggregate !== undefined)) return []
  return spec.columns
    .filter((column) => column.aggregate === undefined)
    .map((column) => column.name)
}

/** Parameter names the filters use, with the type and list form their columns suggest. */
export function specParameters(
  spec: BuilderSpec,
  catalog: DesignCatalog,
): { name: string; type: ParamType; list: boolean }[] {
  const out: { name: string; type: ParamType; list: boolean }[] = []
  for (const filter of spec.filters) {
    const value = filter.value
    if (value?.kind !== 'parameter') continue
    if (out.some((entry) => entry.name === value.name)) continue
    out.push({
      name: value.name,
      type: paramTypeFor(columnKind(spec, catalog, filter.source, filter.column)),
      list: filter.operator === 'in' || filter.operator === 'not_in',
    })
  }
  return out
}

/**
 * Definitions for the spec's parameters: existing ones keep their type, requirement and
 * default, new ones take their column's type. The list form always follows the operator, and
 * a default that no longer fits it is dropped.
 */
export function syncSpecDefinitions(
  definitions: readonly QueryParameter[],
  wanted: readonly { name: string; type: ParamType; list: boolean }[],
): QueryParameter[] {
  return wanted.map((entry) => {
    const existing = definitions.find((definition) => definition.name === entry.name)
    if (existing === undefined) {
      return {
        name: entry.name,
        type: entry.type,
        list: entry.list,
        required: false,
        defaultValue: null,
      }
    }
    if (existing.list === entry.list) return existing
    return { ...existing, list: entry.list, defaultValue: null }
  })
}

type Scalar = string | number | boolean

/** A typed constant from the editor's text for a column of this kind. */
export function parseConstant(kind: ValueKind | undefined, text: string): Scalar {
  const value = text.trim()
  if (kind === 'boolean') return value === 'true' || value === '1'
  if (kind === 'integer' || kind === 'bigint' || kind === 'year') {
    return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value
  }
  if (kind === 'decimal' || kind === 'float') {
    const normalized = value.replace(',', '.')
    return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : value
  }
  return text
}

/** Constant values for an operator: lists split at commas, `between` takes two. */
export function constantFor(
  operator: BuilderOperator,
  kind: ValueKind | undefined,
  texts: readonly string[],
): Scalar | Scalar[] {
  if (operator === 'in' || operator === 'not_in') {
    return (texts[0] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => parseConstant(kind, part))
  }
  if (operator === 'between')
    return [parseConstant(kind, texts[0] ?? ''), parseConstant(kind, texts[1] ?? '')]
  return parseConstant(kind, texts[0] ?? '')
}

/** The editor's texts for a stored constant. */
export function constantTexts(
  value: Scalar | Scalar[] | undefined,
  operator: BuilderOperator,
): string[] {
  if (value === undefined) return ['']
  if (Array.isArray(value))
    return operator === 'between' ? value.map(String) : [value.map(String).join(', ')]
  return [String(value)]
}

/** A filter on a column, with a value that fits the operator. */
export function newFilter(
  spec: BuilderSpec,
  catalog: DesignCatalog,
  source: string,
  column: string,
): SpecFilter {
  const kind = columnKind(spec, catalog, source, column)
  const operator = operatorsFor(kind)[0] ?? 'eq'
  return {
    source,
    column,
    operator,
    value: { kind: 'constant', value: kind === 'boolean' ? true : '' },
  }
}

/** Keeps a filter's value valid when its operator changes. */
export function withOperator(
  filter: SpecFilter,
  operator: BuilderOperator,
  kind: ValueKind | undefined,
): SpecFilter {
  if (operator === 'null' || operator === 'not_null') {
    return { source: filter.source, column: filter.column, operator }
  }
  const list = operator === 'in' || operator === 'not_in'
  const between = operator === 'between'
  const previous = filter.value
  if (previous?.kind === 'parameter' && !between) return { ...filter, operator, value: previous }
  const texts =
    previous?.kind === 'constant' ? constantTexts(previous.value, filter.operator) : ['']
  const value = constantFor(
    operator,
    kind,
    between ? [texts[0] ?? '', texts[1] ?? ''] : [texts.join(', ')],
  )
  return {
    ...filter,
    operator,
    value: { kind: 'constant', value: list && !Array.isArray(value) ? [value] : value },
  }
}

/** A field error path of the server (`builder.columns.2.bucket`) as section and index. */
export function errorTarget(field: string): {
  section: 'base' | 'joins' | 'columns' | 'filters' | 'sort' | 'other'
  index: number | null
} {
  const match = /^builder\.(base|joins|columns|filters|sort)(?:\.(\d+))?/.exec(field)
  if (match === null) return { section: 'other', index: null }
  return { section: match[1] as 'base', index: match[2] === undefined ? null : Number(match[2]) }
}
