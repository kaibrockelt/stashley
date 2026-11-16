// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError } from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'
import type { ResourceColumn, ResourceModel } from '../access/service.ts'
import type { ResourceFilter, ResourceListRequest } from '../execution/resource-reader.ts'

/**
 * Query parameters of `list` and `count` (§16, E16, E19): `limit` up to 1,000, `cursor`,
 * one sort column (`sort=-eingang_am`), `fields=a,b` and `filter[column][op]=value`.
 * Unknown parameters, operators and columns reject the request; an excluded column reads
 * exactly like one that does not exist.
 */

export const apiFilterOperators = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'like',
  'null',
] as const
type ApiFilterOperator = (typeof apiFilterOperators)[number]

export const defaultLimit = 100
export const maxLimit = 1000
export const maxInValues = 100

const filterPattern = /^filter\[([^[\]]+)\]\[([a-z]+)\]$/

function badRequest(errors: FieldError[]): AppError {
  return new AppError('bad_request', { errors })
}

function single(name: string, value: unknown, errors: FieldError[]): string | undefined {
  if (typeof value === 'string') return value
  errors.push({ field: name, code: Array.isArray(value) ? 'duplicate' : 'invalid' })
  return undefined
}

function columnOf(resource: ResourceModel, name: string): ResourceColumn | undefined {
  return resource.columns.find((column) => column.name === name)
}

/** A query string value read for its column: booleans as true/false, others as text. */
function valueFor(column: ResourceColumn, text: string): unknown {
  if (column.kind === 'boolean') {
    if (text === 'true' || text === '1') return true
    if (text === 'false' || text === '0') return false
    return text
  }
  return text
}

/** Rejects parameters other than the allowed ones. */
export function onlyParameters(
  query: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const entries = Object.entries((query ?? {}) as Record<string, unknown>)
  const unknown = entries.filter(([name]) => !allowed.includes(name))
  if (unknown.length > 0) {
    throw badRequest(unknown.map(([name]) => ({ field: name, code: 'unknown_parameter' })))
  }
  return Object.fromEntries(entries)
}

export function parseFilters(
  query: Record<string, unknown>,
  resource: ResourceModel,
  errors: FieldError[],
): ResourceFilter[] {
  const filters: ResourceFilter[] = []
  for (const [name, raw] of Object.entries(query)) {
    const match = filterPattern.exec(name)
    if (match === null) continue
    const [, columnName = '', operator = ''] = match
    const text = single(name, raw, errors)
    if (text === undefined) continue
    const column = columnOf(resource, columnName)
    if (column === undefined) {
      errors.push({ field: name, code: 'unknown_field' })
      continue
    }
    if (!(apiFilterOperators as readonly string[]).includes(operator)) {
      errors.push({ field: name, code: 'unknown_operator' })
      continue
    }
    const op = operator as ApiFilterOperator
    if (op === 'null') {
      if (text !== 'true' && text !== 'false') {
        errors.push({ field: name, code: 'invalid' })
        continue
      }
      filters.push({
        column: column.name,
        operator: text === 'true' ? 'null' : 'not_null',
        param: name,
      })
      continue
    }
    if (op === 'in') {
      const items = text.split(',')
      if (items.length > maxInValues) {
        errors.push({ field: name, code: 'too_many_values', params: { max: maxInValues } })
        continue
      }
      filters.push({
        column: column.name,
        operator: 'in',
        value: items.map((item) => valueFor(column, item)),
        param: name,
      })
      continue
    }
    filters.push({ column: column.name, operator: op, value: valueFor(column, text), param: name })
  }
  return filters
}

/** Parameters of `GET /:resource`. */
export function parseListQuery(query: unknown, resource: ResourceModel): ResourceListRequest {
  const params = Object.entries((query ?? {}) as Record<string, unknown>)
  const errors: FieldError[] = []
  for (const [name] of params) {
    if (!['limit', 'cursor', 'sort', 'fields'].includes(name) && !filterPattern.test(name)) {
      errors.push({ field: name, code: 'unknown_parameter' })
    }
  }
  const values = Object.fromEntries(params)
  let limit = defaultLimit
  if (values.limit !== undefined) {
    const text = single('limit', values.limit, errors)
    const parsed = text === undefined || !/^\d{1,5}$/.test(text) ? NaN : Number(text)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
      if (text !== undefined) {
        errors.push({ field: 'limit', code: 'out_of_range', params: { min: 1, max: maxLimit } })
      }
    } else limit = parsed
  }
  let sort: ResourceListRequest['sort']
  if (values.sort !== undefined) {
    const text = single('sort', values.sort, errors)
    if (text !== undefined) {
      const descending = text.startsWith('-')
      const name = descending ? text.slice(1) : text
      if (name.includes(',')) errors.push({ field: 'sort', code: 'one_sort_column' })
      else if (columnOf(resource, name) === undefined) {
        errors.push({ field: 'sort', code: 'unknown_field' })
      } else sort = { column: name, direction: descending ? 'desc' : 'asc' }
    }
  }
  let fields: string[] | undefined
  if (values.fields !== undefined) {
    const text = single('fields', values.fields, errors)
    if (text !== undefined) {
      fields = [...new Set(text.split(',').map((name) => name.trim()))]
      if (fields.some((name) => columnOf(resource, name) === undefined)) {
        errors.push({ field: 'fields', code: 'unknown_field' })
      }
    }
  }
  let cursor: string | undefined
  if (values.cursor !== undefined) cursor = single('cursor', values.cursor, errors)
  const filters = parseFilters(values, resource, errors)
  if (errors.length > 0) throw badRequest(errors)
  return { limit, filters, ...(sort !== undefined && { sort }), ...(fields && { fields }), cursor }
}

/** Parameters of `GET /:resource/count`: filters only. */
export function parseCountQuery(query: unknown, resource: ResourceModel): ResourceFilter[] {
  const params = Object.entries((query ?? {}) as Record<string, unknown>)
  const errors: FieldError[] = params
    .filter(([name]) => !filterPattern.test(name))
    .map(([name]) => ({ field: name, code: 'unknown_parameter' }))
  const filters = parseFilters(Object.fromEntries(params), resource, errors)
  if (errors.length > 0) throw badRequest(errors)
  return filters
}

/**
 * The body of a write (E16): a JSON object of columns. Columns that are unknown or excluded
 * answer 400 alike; known columns the operation cannot write answer 422.
 */
export function checkBody(
  resource: ResourceModel,
  body: unknown,
  writable: 'insertable' | 'updatable',
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest([{ field: '_', code: 'object_required' }])
  }
  const unknown: FieldError[] = []
  const readOnly: FieldError[] = []
  for (const name of Object.keys(body)) {
    const column = columnOf(resource, name)
    if (column === undefined) unknown.push({ field: name, code: 'unknown_field' })
    else if (!column[writable]) readOnly.push({ field: name, code: 'field_not_writable' })
  }
  if (unknown.length > 0) throw badRequest(unknown)
  if (readOnly.length > 0) throw new AppError('validation_failed', { errors: readOnly })
  return body as Record<string, unknown>
}
