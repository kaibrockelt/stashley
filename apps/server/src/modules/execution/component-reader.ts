// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import type {
  ComponentResult,
  CountResult,
  FieldError,
  FilterOptions,
  Freshness,
  PageDocument,
  QueryResult,
  TableResult,
  TableRow,
  ValueKind,
} from '@stashley/shared'
import { checkParamList, checkParamValue } from '@stashley/shared'
import type { Clock } from '../../platform/clock.ts'
import { systemClock } from '../../platform/clock.ts'
import { AppError } from '../../platform/http/problem.ts'
import { encodeValue } from '../../target/encoding.ts'
import type { AuthorizedComponent, AuthorizedFilter } from '../access/handles.ts'
import type { CompiledQuerySource, CompiledTableSource } from '../access/compile.ts'
import type { QueryCache } from '../cache/query-cache.ts'
import { buildStatement } from '../queries/sql-guard/executable.ts'
import type { VariablesService } from '../variables/service.ts'
import type { ReadExecutor } from './executor.ts'
import { normalizeResult } from './results.ts'
import { decodeCursor, encodeCursor } from './sql/cursor.ts'
import { ParameterError, resolveParameters, type ResolvedParameters } from './sql/parameters.ts'
import {
  bindForColumn,
  countStatement,
  rowStatement,
  selectStatement,
  TableRequestError,
  type ColumnFilter,
  type CursorPosition,
  type ResolvedValues,
  type ValueOptions,
} from './sql/table-sql.ts'

/** What the client sends for a component: filter and URL values, and table options. */
export interface ComponentInput {
  filters: Readonly<Record<string, unknown>>
  params: Readonly<Record<string, unknown>>
  sort?: { columnId: string; direction: 'asc' | 'desc' } | undefined
  search?: string | undefined
  columnFilters?: readonly ColumnFilter[] | undefined
  cursor?: string | undefined
  pageSize?: number | undefined
  refresh?: boolean
}

/** Stored queries run up to this many rows (§10.7). */
export const queryRowLimit = 10_000
/** Rows per page of query tables and filter options. */
const defaultPageSize = 50
const optionPageSize = 50
/** A live query slower than this gets a hint to cache it (§12). */
const slowLiveMs = 2_000
/** Unfiltered counts above this many estimated rows use the estimate (D7). */
const estimateRows = 1_000_000

/** A value as text for search and comparison; sets are joined, other objects serialized. */
function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(text).join(',')
  return JSON.stringify(value)
}

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22)

function invalid(errors: FieldError[]): AppError {
  return new AppError('validation_failed', { errors })
}

/** A stored query with its parameters resolved for one request, and its cache key. */
interface PreparedQuery {
  source: CompiledQuerySource
  resolved: ResolvedParameters
  key: string
}

/** A cached page of a table source, with the raw key and sort values for its cursors. */
interface TablePage {
  rows: TableRow[]
  raw: unknown[][]
  invalidRows: number[]
  more: boolean
}

/**
 * Reads authorized components (§10.5–10.7, §12). It accepts only handles from `access`;
 * cache lookups come after authorization and entries never hold decisions.
 */
export class ComponentReader {
  private readonly executor: ReadExecutor
  private readonly cache: QueryCache
  private readonly variables: VariablesService
  private readonly cursorKey: Buffer
  private readonly displayTimeZone: string
  private readonly clock: Clock

  constructor(deps: {
    executor: ReadExecutor
    cache: QueryCache
    variables: VariablesService
    cursorKey: Buffer
    displayTimeZone: string
    clock?: Clock
  }) {
    this.executor = deps.executor
    this.cache = deps.cache
    this.variables = deps.variables
    this.cursorKey = deps.cursorKey
    this.displayTimeZone = deps.displayTimeZone
    this.clock = deps.clock ?? systemClock
  }

  /** Page filter and URL values, checked against the page's definitions. */
  private inputs(document: PageDocument, input: ComponentInput): void {
    const errors: FieldError[] = []
    for (const [id, value] of Object.entries(input.filters)) {
      const filter = document.filters.find((entry) => entry.id === id)
      if (filter === undefined) {
        errors.push({ field: `filters.${id}`, code: 'not_allowed' })
        continue
      }
      if (value === null || value === undefined) continue
      const ok =
        filter.kind === 'text'
          ? typeof value === 'string' && value.length <= 1000
          : filter.kind === 'date'
            ? filter.range
              ? typeof value === 'object' &&
                !Array.isArray(value) &&
                Object.entries(value).every(
                  ([key, date]) =>
                    (key === 'from' || key === 'to') && checkParamValue('date', date).ok,
                )
              : checkParamValue('date', value).ok
            : filter.multiple
              ? Array.isArray(value) &&
                value.length <= 1000 &&
                value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
              : ['string', 'number', 'boolean'].includes(typeof value)
      if (!ok) errors.push({ field: `filters.${id}`, code: 'invalid' })
    }
    for (const [name, value] of Object.entries(input.params)) {
      const parameter = document.parameters.find((entry) => entry.name === name)
      if (parameter === undefined) {
        errors.push({ field: `params.${name}`, code: 'not_allowed' })
        continue
      }
      if (value === null || value === undefined) continue
      const checked = parameter.list
        ? checkParamList(parameter.type, value)
        : checkParamValue(parameter.type, value)
      if (!checked.ok) errors.push({ field: `params.${name}`, code: checked.code })
    }
    if (errors.length > 0) throw invalid(errors)
  }

  private bound(
    from: { kind: 'filter'; filterId: string } | { kind: 'url'; name: string },
    input: ComponentInput,
  ): unknown {
    return from.kind === 'filter' ? input.filters[from.filterId] : input.params[from.name]
  }

  private freshness(
    loaded: { fetchedAt: number; stale: boolean; tooLarge: boolean },
    ttlSeconds: number,
    durationMs: number | undefined,
  ): Freshness {
    return {
      fetchedAt: new Date(loaded.fetchedAt).toISOString(),
      stale: loaded.stale,
      ...(ttlSeconds === 0 &&
        durationMs !== undefined &&
        durationMs > slowLiveMs && {
          hint: { code: 'slow_live_query' as const, recommendedTtlSeconds: 60 },
        }),
      ...(loaded.tooLarge && { notCached: 'too_large' as const }),
    }
  }

  /** Resolves the parameters of a stored query and its cache key, without running it. */
  private async prepareQuery(
    source: CompiledQuerySource,
    user: { id: string; email: string },
    clientValues: Record<string, unknown>,
  ): Promise<PreparedQuery> {
    const variables = await this.variables.current()
    const target = await this.executor.target(source.connection.connectionId)
    let resolved
    try {
      resolved = resolveParameters({
        names: source.stored.analysis.parameters,
        definitions: source.stored.parameters,
        user,
        variables,
        input: clientValues,
        timeZone: target.timeZone,
      })
    } catch (error) {
      if (error instanceof ParameterError) throw invalid(error.errors)
      throw error
    }
    const key = `query:${source.stored.queryId}:${source.stored.version}:${queryRowLimit}:${hash(resolved.key)}${
      resolved.usesUserContext ? `:user:${user.id}` : ''
    }`
    return { source, resolved, key }
  }

  /** Runs a prepared query through the cache. */
  private async loadQuery(
    query: PreparedQuery,
    refresh: boolean,
  ): Promise<{ result: QueryResult; freshness: Freshness }> {
    const { source, resolved, key } = query
    let durationMs: number | undefined
    const loaded = await this.cache.load<QueryResult>({
      key,
      ttlSeconds: source.stored.cacheTtlSeconds,
      dependencies: { ...source.dependencies, variables: resolved.variables },
      refresh,
      load: async () => {
        const statement = buildStatement(
          source.stored.executable,
          resolved.values,
          queryRowLimit + 1,
        )
        const raw = await this.executor.execute(source.connection.connectionId, statement)
        durationMs = raw.durationMs
        const { size, ...result } = normalizeResult(
          raw.rows,
          raw.fields,
          queryRowLimit,
          raw.timeZone,
        )
        return { value: result, size }
      },
    })
    return {
      result: loaded.value,
      freshness: this.freshness(loaded, source.stored.cacheTtlSeconds, durationMs),
    }
  }

  /** Reads a component: a query result, or a page of a table source. */
  async read(
    handle: AuthorizedComponent,
    input: ComponentInput,
  ): Promise<ComponentResult | TableResult> {
    this.inputs(handle.page.document, input)
    const source = handle.component.source
    if (source === undefined) throw new AppError('not_found')
    if (source.kind === 'table') return this.readTable(handle, source, input)
    const values: Record<string, unknown> = {}
    for (const binding of source.bindings) {
      const value = this.bound(binding.from, input)
      if (value !== undefined && value !== null && value !== '') values[binding.parameter] = value
    }
    const query = await this.prepareQuery(source, handle.user, values)
    if (handle.component.block.type !== 'table') {
      const { result, freshness } = await this.loadQuery(query, input.refresh === true)
      return { ...result, ...freshness, nextCursor: null, prevCursor: null }
    }
    return this.pageQueryResult(query, input)
  }

  /**
   * Stored queries in tables (§10.7): run once up to the limit; sorting, filters, search and
   * paging work on the result. Live queries keep it as a paging snapshot for five minutes and
   * page through it without running again; a reload or a manual refresh runs them again.
   */
  private async pageQueryResult(
    query: PreparedQuery,
    input: ComponentInput,
  ): Promise<ComponentResult> {
    const fingerprint = hash([query.key, input.sort, input.columnFilters, input.search])
    let position: CursorPosition | undefined
    if (input.cursor !== undefined) {
      position = decodeCursor(this.cursorKey, input.cursor, fingerprint)
      if (position === undefined || typeof position.key !== 'number') {
        throw new AppError('cursor_invalid')
      }
    }
    const offset = typeof position?.key === 'number' ? position.key : 0
    let rows: QueryResult
    let freshness: Freshness
    let snapshot: string | null = null
    if (typeof position?.sort === 'string' && input.refresh !== true) {
      const kept = this.cache.snapshot<QueryResult>(position.sort)
      if (kept === undefined) throw new AppError('cursor_expired')
      rows = kept.value
      snapshot = position.sort
      freshness = { fetchedAt: new Date(kept.fetchedAt).toISOString(), stale: false }
    } else {
      const loaded = await this.loadQuery(query, input.refresh === true)
      rows = loaded.result
      freshness = loaded.freshness
      if (query.source.stored.cacheTtlSeconds === 0) {
        snapshot = this.cache.keepSnapshot(rows, JSON.stringify(rows.rows).length * 2)
      }
    }
    const filtered = filterRows(rows, input)
    const pageSize = input.pageSize ?? defaultPageSize
    const page = filtered.slice(offset, offset + pageSize)
    const cursor = (at: number) =>
      encodeCursor(this.cursorKey, {
        fingerprint,
        direction: 'next',
        sort: snapshot,
        key: at,
      })
    return {
      columns: rows.columns,
      rows: page,
      truncated: rows.truncated,
      ...freshness,
      nextCursor: offset + pageSize < filtered.length ? cursor(offset + pageSize) : null,
      prevCursor: offset > 0 ? cursor(Math.max(0, offset - pageSize)) : null,
      total: filtered.length,
    }
  }

  /** Base filter values for this request: constants, instance variables, the user (§ Basisfilter). */
  private async baseValues(
    source: CompiledTableSource,
    user: { id: string; email: string },
    options: ValueOptions,
  ): Promise<{ values: unknown[]; variables: string[] }> {
    const model = source.model
    if (model === null) return { values: [], variables: [] }
    const current = await this.variables.current()
    const variables: string[] = []
    const values = model.baseFilter.map((condition, index) => {
      const value = condition.value
      if (value === undefined) return undefined
      let raw: unknown
      if (value.kind === 'constant') raw = value.value
      else if (value.kind === 'user') raw = value.field === 'id' ? user.id : user.email
      else {
        const variable = current.get(value.name)
        // Fail closed: without its value, a base filter would restrict nothing.
        if (variable === undefined) {
          throw new AppError('query_failed', {
            errors: [{ field: `baseFilter.${index}`, code: 'variable_missing' }],
          })
        }
        variables.push(value.name)
        raw = variable.value
      }
      const bind = (item: unknown) => {
        const checked = bindForColumn(condition.expr.kind, item, options)
        if (!checked.ok) {
          throw new AppError('query_failed', {
            errors: [{ field: `baseFilter.${index}`, code: checked.code }],
          })
        }
        return checked.value
      }
      if (condition.operator === 'in') return (Array.isArray(raw) ? raw : [raw]).map(bind)
      return bind(raw)
    })
    return { values, variables }
  }

  private async tableContext(
    handle: AuthorizedComponent,
    source: CompiledTableSource,
    input: ComponentInput,
  ) {
    const model = source.model
    if (model === null) throw new AppError('not_found')
    const options: ValueOptions = {
      connectionTimeZone: source.connection.timeZone,
      displayTimeZone: this.displayTimeZone,
    }
    const base = await this.baseValues(source, handle.user, options)
    const values: ResolvedValues = {
      baseFilter: base.values,
      bindings: model.bindings.map((binding) => this.bound(binding.from, input)),
    }
    return { model, options, values, variables: base.variables }
  }

  private async readTable(
    handle: AuthorizedComponent,
    source: CompiledTableSource,
    input: ComponentInput,
  ): Promise<TableResult> {
    const { model, options, values, variables } = await this.tableContext(handle, source, input)
    const request = {
      sort: input.sort,
      search: input.search,
      filters: input.columnFilters ?? [],
      limit: Math.min(input.pageSize ?? model.pageSize, 500),
    }
    const fingerprint = hash([
      model.fingerprint,
      values,
      request.sort,
      request.filters,
      request.search,
    ])
    let cursor: CursorPosition | undefined
    if (input.cursor !== undefined) {
      cursor = decodeCursor(this.cursorKey, input.cursor, fingerprint)
      if (cursor === undefined) throw new AppError('cursor_invalid')
    }
    let statement
    try {
      statement = selectStatement(model, values, { ...request, cursor }, options)
    } catch (error) {
      if (error instanceof TableRequestError) throw invalid(error.errors)
      throw error
    }
    const key = `table:${handle.page.pageId}:${handle.component.id}:${fingerprint}:${input.cursor ?? ''}:${request.limit}`
    let durationMs: number | undefined
    const loaded = await this.cache.load<TablePage>({
      key,
      ttlSeconds: source.cacheTtlSeconds,
      dependencies: {
        ...source.dependencies,
        variables: [...source.dependencies.variables, ...variables],
      },
      refresh: input.refresh === true,
      load: async () => {
        const raw = await this.executor.execute(source.connection.connectionId, statement)
        durationMs = raw.durationMs
        const rows = raw.rows.slice(0, request.limit)
        if (statement.reversed) rows.reverse()
        const encoded = this.encodeRows(model.columns, rows, raw.timeZone, model.key.kind)
        return {
          value: { ...encoded, raw: rows, more: raw.rows.length > request.limit },
          size: JSON.stringify(encoded.rows).length * 2,
        }
      },
    })
    const value = loaded.value
    const columnCount = model.columns.length
    const position = (row: unknown[] | undefined, direction: 'next' | 'prev') =>
      row === undefined
        ? null
        : encodeCursor(this.cursorKey, {
            fingerprint,
            direction,
            sort: statement.sortIsKey ? null : (row[columnCount + 1] ?? null),
            key: row[columnCount],
          })
    const first = value.raw[0]
    const last = value.raw.at(-1)
    const backwards = cursor?.direction === 'prev'
    return {
      columns: model.columns.map((column) => ({
        id: column.id,
        label: column.label ?? null,
        kind: column.kind,
      })),
      rows: value.rows,
      truncated: false,
      ...this.freshness(loaded, source.cacheTtlSeconds, durationMs),
      nextCursor: backwards || value.more ? position(last, 'next') : null,
      prevCursor:
        cursor !== undefined && (!backwards || value.more) ? position(first, 'prev') : null,
      ...(value.invalidRows.length > 0 && { invalidRows: value.invalidRows }),
    }
  }

  private encodeRows(
    columns: { id: string; kind: ValueKind }[],
    rows: unknown[][],
    timeZone: string,
    keyKind: ValueKind,
  ): { rows: TableRow[]; invalidRows: number[] } {
    const invalidRows: number[] = []
    const encoded = rows.map((row, index) => {
      const values: Record<string, unknown> = {}
      let invalidRow = false
      columns.forEach((column, position) => {
        const encodedValue = encodeValue(
          column.kind,
          row[position] as string | number | null,
          timeZone,
        )
        if (encodedValue.invalid === true) invalidRow = true
        values[column.id] = encodedValue.value
      })
      if (invalidRow) invalidRows.push(index)
      return {
        key: encodeValue(keyKind, row[columns.length] as string | number | null, timeZone).value,
        values,
      }
    })
    return { rows: encoded, invalidRows }
  }

  /** The number of rows of a table source (§10.6); large unfiltered objects use the estimate. */
  async count(handle: AuthorizedComponent, input: ComponentInput): Promise<CountResult> {
    this.inputs(handle.page.document, input)
    const source = handle.component.source
    if (source?.kind !== 'table') throw new AppError('not_found')
    const { model, options, values, variables } = await this.tableContext(handle, source, input)
    const request = { filters: input.columnFilters ?? [], search: input.search }
    const unfiltered =
      model.baseFilter.length === 0 &&
      request.filters.length === 0 &&
      (request.search ?? '').trim() === '' &&
      values.bindings.every((value) => value === undefined || value === null || value === '')
    const estimate = source.connection.catalog.get(model.object)?.rowEstimate ?? null
    let statement
    try {
      statement = countStatement(model, values, request, options)
    } catch (error) {
      if (error instanceof TableRequestError) throw invalid(error.errors)
      throw error
    }
    const approximate = unfiltered && estimate !== null && estimate > estimateRows
    const key = `count:${handle.page.pageId}:${handle.component.id}:${hash([model.fingerprint, values, request])}`
    try {
      const loaded = await this.cache.load<number>({
        key,
        ttlSeconds: Math.max(source.cacheTtlSeconds, 30),
        dependencies: {
          ...source.dependencies,
          variables: [...source.dependencies.variables, ...variables],
        },
        refresh: input.refresh === true,
        load: async () => {
          const raw = approximate
            ? await this.executor.execute(source.connection.connectionId, {
                sql: 'SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
                values: [source.connection.database, model.object],
              })
            : await this.executor.execute(source.connection.connectionId, statement)
          return { value: Number(raw.rows[0]?.[0] ?? 0), size: 16 }
        },
      })
      return {
        count: loaded.value,
        approximate,
        ...this.freshness(loaded, source.cacheTtlSeconds, undefined),
      }
    } catch (error) {
      // A filtered count that times out is unknown, not an error (D7).
      if (error instanceof AppError && error.code === 'query_timeout') {
        return {
          count: null,
          approximate: false,
          fetchedAt: new Date(this.clock()).toISOString(),
          stale: false,
        }
      }
      throw error
    }
  }

  /** One row by key, within the base filter; a key outside it is not found. */
  async row(handle: AuthorizedComponent, key: string): Promise<TableRow> {
    const source = handle.component.source
    if (source?.kind !== 'table' || source.model === null) throw new AppError('not_found')
    const kind = source.model.key.kind
    const parsed =
      kind === 'integer' || kind === 'bigint'
        ? checkParamValue('integer', key)
        : checkParamValue('string', key)
    if (!parsed.ok) throw new AppError('not_found')
    const { model, values } = await this.tableContext(handle, source, { filters: {}, params: {} })
    const statement = rowStatement(model, values, parsed.value)
    const raw = await this.executor.execute(source.connection.connectionId, statement)
    const [row] = this.encodeRows(model.columns, raw.rows, raw.timeZone, model.key.kind).rows
    if (row === undefined) throw new AppError('not_found')
    return row
  }

  /** Options of a select page filter, searchable and paged (§13.6). */
  async options(
    handle: AuthorizedFilter,
    input: {
      search?: string | undefined
      cursor?: string | undefined
      values?: readonly (string | number | boolean)[] | undefined
    },
  ): Promise<FilterOptions> {
    const filter = handle.filter.filter
    const source = handle.filter.source
    if (filter.kind !== 'select' || source === undefined) throw new AppError('not_found')
    const query = await this.prepareQuery(source, handle.user, {})
    const { result, freshness } = await this.loadQuery(query, false)
    const all = result.rows.map((row) => ({
      value: row[filter.valueColumn] ?? null,
      label: text(row[filter.labelColumn]),
    }))
    if (input.values !== undefined) {
      // Values from the URL arrive as text, numbers or booleans; compare their text.
      const wanted = new Set(input.values.map((value) => text(value)))
      return {
        options: all.filter((option) => wanted.has(text(option.value))),
        nextCursor: null,
        ...freshness,
      }
    }
    const search = (input.search ?? '').trim().toLowerCase()
    const options = all.filter(
      (option) => search === '' || option.label.toLowerCase().includes(search),
    )
    const fingerprint = hash([handle.page.pageId, filter.id, search])
    let offset = 0
    if (input.cursor !== undefined) {
      const position = decodeCursor(this.cursorKey, input.cursor, fingerprint)
      if (position === undefined || typeof position.key !== 'number')
        throw new AppError('cursor_invalid')
      offset = position.key
    }
    const next = offset + optionPageSize
    return {
      options: options.slice(offset, next),
      nextCursor:
        next < options.length
          ? encodeCursor(this.cursorKey, { fingerprint, direction: 'next', sort: null, key: next })
          : null,
      ...freshness,
    }
  }
}

/** Filters, search and sort over a stored query's result (§10.7). */
export function filterRows(result: QueryResult, input: ComponentInput): Record<string, unknown>[] {
  const kinds = new Map(result.columns.map((column) => [column.name, column.kind]))
  const numeric = (kind: ValueKind | undefined) =>
    kind === 'integer' ||
    kind === 'bigint' ||
    kind === 'decimal' ||
    kind === 'float' ||
    kind === 'year'
  const compare = (kind: ValueKind | undefined, a: unknown, b: unknown): number => {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1
    if (b === null || b === undefined) return 1
    if (numeric(kind)) return Number(a) - Number(b)
    return text(a).localeCompare(text(b))
  }
  const errors: FieldError[] = []
  const filters = input.columnFilters ?? []
  filters.forEach((filter, index) => {
    if (!kinds.has(filter.columnId))
      errors.push({ field: `filters.${index}.columnId`, code: 'unknown_column' })
  })
  if (input.sort !== undefined && !kinds.has(input.sort.columnId)) {
    errors.push({ field: 'sort.columnId', code: 'unknown_column' })
  }
  if (errors.length > 0) throw invalid(errors)
  const search = (input.search ?? '').trim().toLowerCase()
  let rows = result.rows.filter((row) =>
    filters.every((filter) => {
      const value = row[filter.columnId]
      const kind = kinds.get(filter.columnId)
      switch (filter.operator) {
        case 'null':
          return value === null || value === undefined
        case 'not_null':
          return value !== null && value !== undefined
        case 'contains':
          return text(value).toLowerCase().includes(text(filter.value).toLowerCase())
        case 'in':
          return (
            Array.isArray(filter.value) &&
            filter.value.some((item) => compare(kind, value, item) === 0)
          )
        case 'eq':
          return compare(kind, value, filter.value) === 0
        case 'ne':
          return compare(kind, value, filter.value) !== 0
        case 'lt':
          return value !== null && compare(kind, value, filter.value) < 0
        case 'lte':
          return value !== null && compare(kind, value, filter.value) <= 0
        case 'gt':
          return compare(kind, value, filter.value) > 0
        case 'gte':
          return compare(kind, value, filter.value) >= 0
      }
    }),
  )
  if (search !== '') {
    rows = rows.filter((row) =>
      Object.values(row).some((value) => text(value).toLowerCase().includes(search)),
    )
  }
  if (input.sort !== undefined) {
    const { columnId, direction } = input.sort
    const kind = kinds.get(columnId)
    const factor = direction === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => factor * compare(kind, a[columnId], b[columnId]))
  }
  return rows
}
