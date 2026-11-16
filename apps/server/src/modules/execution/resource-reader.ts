// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import type { FieldError, ValueKind } from '@stashley/shared'
import { checkParamValue } from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'
import { encodeValue } from '../../target/encoding.ts'
import type { AuthorizedResource } from '../access/handles.ts'
import type { ReadExecutor } from './executor.ts'
import { decodeCursor, encodeCursor } from './sql/cursor.ts'
import {
  countStatement,
  rowStatement,
  selectStatement,
  TableRequestError,
  type ColumnFilter,
  type ResolvedValues,
  type ValueOptions,
} from './sql/table-sql.ts'

/**
 * Reads of the public API (§16, E19): live through the read user, without the query cache,
 * every readable column of one object as raw values, no base filter.
 */

export interface ResourceFilter {
  column: string
  operator: ColumnFilter['operator']
  value?: unknown
  /** The query parameter it came from, named in errors, e.g. `filter[betrag][gte]`. */
  param: string
}

export interface ResourceListRequest {
  sort?: { column: string; direction: 'asc' | 'desc' } | undefined
  filters: readonly ResourceFilter[]
  /** Columns to return; all when undefined. */
  fields?: readonly string[] | undefined
  cursor?: string | undefined
  limit: number
}

export interface ResourcePage {
  data: Record<string, unknown>[]
  nextCursor: string | null
}

/** Unfiltered counts above this many estimated rows use the estimate (D7). */
const estimateRows = 1_000_000
const noValues: ResolvedValues = { baseFilter: [], bindings: [] }

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22)

function badRequest(errors: FieldError[]): AppError {
  return new AppError('bad_request', { errors })
}

export class ResourceReader {
  private readonly executor: ReadExecutor
  private readonly cursorKey: Buffer
  private readonly displayTimeZone: string

  constructor(deps: { executor: ReadExecutor; cursorKey: Buffer; displayTimeZone: string }) {
    this.executor = deps.executor
    this.cursorKey = deps.cursorKey
    this.displayTimeZone = deps.displayTimeZone
  }

  private async options(handle: AuthorizedResource): Promise<ValueOptions> {
    const target = await this.executor.target(handle.resource.connection.connectionId)
    return { connectionTimeZone: target.timeZone, displayTimeZone: this.displayTimeZone }
  }

  private encode(
    handle: AuthorizedResource,
    row: unknown[],
    timeZone: string,
    fields: readonly string[] | undefined,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    const wanted = fields === undefined ? undefined : new Set(fields)
    handle.resource.read.columns.forEach((column, index) => {
      if (wanted !== undefined && !wanted.has(column.id)) return
      values[column.id] = encodeValue(
        column.kind,
        row[index] as string | number | null,
        timeZone,
      ).value
    })
    return values
  }

  private columnFilters(filters: readonly ResourceFilter[]): ColumnFilter[] {
    return filters.map((filter) => ({
      columnId: filter.column,
      operator: filter.operator,
      ...(filter.value !== undefined && { value: filter.value }),
    }))
  }

  /** Field errors of the SQL builder, renamed to the query parameters they came from. */
  private translate(error: unknown, filters: readonly ResourceFilter[]): never {
    if (error instanceof TableRequestError) {
      throw badRequest(
        error.errors.map((entry) => {
          const index = /^filters\.(\d+)\./.exec(entry.field)?.[1]
          const field =
            index !== undefined
              ? (filters[Number(index)]?.param ?? 'filter')
              : entry.field.startsWith('sort')
                ? 'sort'
                : entry.field
          return { ...entry, field }
        }),
      )
    }
    throw error
  }

  async list(handle: AuthorizedResource, request: ResourceListRequest): Promise<ResourcePage> {
    const resource = handle.resource
    const model = resource.read
    const options = await this.options(handle)
    const filters = this.columnFilters(request.filters)
    const sort =
      request.sort === undefined
        ? undefined
        : { columnId: request.sort.column, direction: request.sort.direction }
    const fingerprint = hash([
      'api',
      model.fingerprint,
      sort,
      filters,
      resource.keyless ? 'offset' : 'keyset',
    ])
    let position
    if (request.cursor !== undefined) {
      position = decodeCursor(this.cursorKey, request.cursor, fingerprint)
      if (position === undefined || position.direction !== 'next') {
        throw new AppError('cursor_invalid')
      }
    }
    const offset = resource.keyless
      ? typeof position?.key === 'number' && Number.isSafeInteger(position.key)
        ? position.key
        : 0
      : undefined
    let statement
    try {
      statement = selectStatement(
        model,
        noValues,
        {
          sort,
          filters,
          limit: request.limit,
          ...(offset === undefined ? { cursor: position } : { offset }),
        },
        options,
      )
    } catch (error) {
      this.translate(error, request.filters)
    }
    const raw = await this.executor.execute(resource.connection.connectionId, statement)
    const rows = raw.rows.slice(0, request.limit)
    const more = raw.rows.length > request.limit
    const columnCount = model.columns.length
    const last = rows.at(-1)
    let nextCursor: string | null = null
    if (more && last !== undefined) {
      nextCursor = encodeCursor(this.cursorKey, {
        fingerprint,
        direction: 'next',
        sort: offset !== undefined || statement.sortIsKey ? null : (last[columnCount + 1] ?? null),
        key: offset !== undefined ? offset + rows.length : last[columnCount],
      })
    }
    return {
      data: rows.map((row) => this.encode(handle, row, raw.timeZone, request.fields)),
      nextCursor,
    }
  }

  /** The number of rows (§16, D7): estimated only for large unfiltered objects. */
  async count(
    handle: AuthorizedResource,
    filters: readonly ResourceFilter[],
  ): Promise<{ count: number | null; approximate: boolean }> {
    const resource = handle.resource
    const options = await this.options(handle)
    const columnFilters = this.columnFilters(filters)
    let statement
    try {
      statement = countStatement(resource.read, noValues, { filters: columnFilters }, options)
    } catch (error) {
      this.translate(error, filters)
    }
    const estimate = resource.catalog.rowEstimate
    const approximate = filters.length === 0 && estimate !== null && estimate > estimateRows
    try {
      const raw = approximate
        ? await this.executor.execute(resource.connection.connectionId, {
            sql: 'SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            values: [resource.connection.database, resource.object.objectName],
          })
        : await this.executor.execute(resource.connection.connectionId, statement)
      return { count: Number(raw.rows[0]?.[0] ?? 0), approximate }
    } catch (error) {
      // A filtered count that times out is unknown, not an error (D7).
      if (error instanceof AppError && error.code === 'query_timeout') {
        return { count: null, approximate: false }
      }
      throw error
    }
  }

  /** One row by key, or undefined. A key that cannot be one is not found. */
  async get(
    handle: AuthorizedResource,
    rawKey: string,
    fields?: readonly string[],
  ): Promise<Record<string, unknown> | undefined> {
    const resource = handle.resource
    const kind: ValueKind = resource.read.key.kind
    const parsed =
      kind === 'integer' || kind === 'bigint'
        ? checkParamValue('integer', rawKey)
        : checkParamValue('string', rawKey)
    if (!parsed.ok) return undefined
    const statement = rowStatement(resource.read, noValues, parsed.value)
    const raw = await this.executor.execute(resource.connection.connectionId, statement)
    const row = raw.rows[0]
    return row === undefined ? undefined : this.encode(handle, row, raw.timeZone, fields)
  }
}
