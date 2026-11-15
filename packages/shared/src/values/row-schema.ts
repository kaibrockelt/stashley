// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { CatalogColumn } from '../api/connections.ts'
import type { FieldError } from '../api/errors.ts'
import type { ValueKind } from './column-kinds.ts'

/**
 * The row schema of forms and table editing (§11 step 2). Client and server check a payload
 * with the same code, so a value the form accepts is a value the server accepts. Values use
 * the JSON forms of §9.5; the checks follow the column definition (length, range, precision,
 * enum values) and leave the rest to the database, whose errors are translated (§11 step 7).
 */

/** What the row schema needs to know about one writable field. */
export interface FieldSpec {
  /** Column name, also the payload key. */
  column: string
  kind: ValueKind
  columnType: string
  nullable: boolean
  /** Must be given on create and can never be null. */
  required: boolean
  maxLength: number | null
  precision: number | null
  scale: number | null
  enumValues?: string[] | undefined
}

/** Kinds a form can edit; JSON, binary and spatial columns stay read-only. */
export function editableKind(kind: ValueKind): boolean {
  return kind !== 'json' && kind !== 'unsupported'
}

/**
 * Whether a column must be given on insert: `NOT NULL` without default, and neither
 * auto-increment nor generated.
 */
export function columnRequired(column: CatalogColumn): boolean {
  return (
    !column.nullable && column.defaultValue === null && !column.autoIncrement && !column.generated
  )
}

export function fieldSpec(column: CatalogColumn, options: { required?: boolean } = {}): FieldSpec {
  return {
    column: column.name,
    kind: column.kind,
    columnType: column.columnType,
    nullable: column.nullable,
    required: columnRequired(column) || options.required === true,
    maxLength: column.maxLength,
    precision: column.precision,
    scale: column.scale,
    enumValues: column.enumValues,
  }
}

export type FieldCheck =
  | { ok: true; value: unknown }
  | { ok: false; code: string; params?: Record<string, string | number> }

const integerRanges: Record<string, [bigint, bigint]> = {
  tinyint: [-128n, 127n],
  smallint: [-32768n, 32767n],
  mediumint: [-8388608n, 8388607n],
  int: [-2147483648n, 2147483647n],
  integer: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
}
const unsignedMax: Record<string, bigint> = {
  tinyint: 255n,
  smallint: 65535n,
  mediumint: 16777215n,
  int: 4294967295n,
  integer: 4294967295n,
  bigint: 18446744073709551615n,
}

const integerText = /^-?(0|[1-9]\d{0,19})$/
const decimalText = /^(-?)(\d+)(?:\.(\d+))?$/
const dateText = /^(\d{4})-(\d{2})-(\d{2})$/
const instantText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/
const timeText = /^(-)?(\d{1,3}):([0-5]\d)(?::([0-5]\d)(\.\d{1,6})?)?$/

const unsigned = (spec: FieldSpec) => /\bunsigned\b/i.test(spec.columnType)
const baseType = (spec: FieldSpec) => /^[a-z]+/i.exec(spec.columnType)?.[0]?.toLowerCase() ?? ''

function validDate(text: string, minYear: number): boolean {
  const match = dateText.exec(text)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < minYear || month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function integerRange(spec: FieldSpec): [bigint, bigint] {
  const type = baseType(spec)
  const range = integerRanges[type] ?? integerRanges.bigint!
  return unsigned(spec) ? [0n, unsignedMax[type] ?? unsignedMax.bigint!] : range
}

function outOfRange(min: bigint | number | string, max: bigint | number | string): FieldCheck {
  return { ok: false, code: 'out_of_range', params: { min: String(min), max: String(max) } }
}

/** Checks one non-null value and returns its canonical form. */
export function checkFieldValue(spec: FieldSpec, value: unknown): FieldCheck {
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, code: 'invalid' }
    case 'integer':
    case 'bigint': {
      let text: string
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) return { ok: false, code: 'invalid' }
        text = String(value)
      } else if (typeof value === 'string' && integerText.test(value)) text = value
      else return { ok: false, code: 'invalid' }
      const [min, max] = integerRange(spec)
      const parsed = BigInt(text)
      if (parsed < min || parsed > max) return outOfRange(min, max)
      return { ok: true, value: spec.kind === 'integer' ? Number(parsed) : parsed.toString() }
    }
    case 'decimal': {
      const text =
        typeof value === 'number' && Number.isFinite(value) && !/e/i.test(String(value))
          ? String(value)
          : value
      const match = typeof text === 'string' ? decimalText.exec(text) : null
      if (match === null) return { ok: false, code: 'invalid' }
      const sign = match[1] ?? ''
      const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '')
      const fraction = (match[3] ?? '').replace(/0+$/, '')
      const scale = spec.scale ?? 0
      const digits = (spec.precision ?? 65) - scale
      if (fraction.length > scale) {
        return { ok: false, code: 'too_many_decimals', params: { max: scale } }
      }
      const zero = /^0*$/.test(whole) && fraction.length === 0
      if (whole.replace(/^0$/, '').length > digits || (unsigned(spec) && sign === '-' && !zero)) {
        const limit = `${'9'.repeat(digits) || '0'}${scale > 0 ? `.${'9'.repeat(scale)}` : ''}`
        return outOfRange(unsigned(spec) ? '0' : `-${limit}`, limit)
      }
      const canonical = `${zero ? '' : sign}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`
      return { ok: true, value: canonical }
    }
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { ok: false, code: 'invalid' }
      if (unsigned(spec) && value < 0) return outOfRange(0, '∞')
      return { ok: true, value }
    case 'date':
      return typeof value === 'string' && validDate(value, 1000)
        ? { ok: true, value }
        : { ok: false, code: 'invalid' }
    case 'datetime':
    case 'timestamp': {
      if (typeof value !== 'string' || !instantText.test(value)) {
        return { ok: false, code: 'invalid' }
      }
      const time = Date.parse(value)
      if (!Number.isFinite(time) || !validDate(value.slice(0, 10), 0)) {
        return { ok: false, code: 'invalid' }
      }
      const instant = new Date(time).toISOString()
      if (spec.kind === 'timestamp') {
        // The range of TIMESTAMP, in UTC.
        if (instant < '1970-01-01T00:00:01' || instant > '2038-01-19T03:14:07.999999Z') {
          return outOfRange('1970-01-01T00:00:01Z', '2038-01-19T03:14:07Z')
        }
      } else if (instant < '1000-01-01' || /^[+-]/.test(instant)) {
        return outOfRange('1000-01-01T00:00:00Z', '9999-12-31T23:59:59Z')
      }
      return { ok: true, value: instant.replace('.000Z', 'Z') }
    }
    case 'time': {
      const match = typeof value === 'string' ? timeText.exec(value) : null
      if (match === null) return { ok: false, code: 'invalid' }
      const hours = Number(match[2])
      const seconds = match[4] ?? '00'
      const beyond =
        hours === 838 && match[3] === '59' && seconds === '59' && /[1-9]/.test(match[5] ?? '')
      if (hours > 838 || beyond) {
        return outOfRange('-838:59:59', '838:59:59')
      }
      const hh = String(hours).padStart(2, '0')
      return { ok: true, value: `${match[1] ?? ''}${hh}:${match[3]}:${seconds}${match[5] ?? ''}` }
    }
    case 'year':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return { ok: false, code: 'invalid' }
      if (value !== 0 && (value < 1901 || value > 2155)) return outOfRange(1901, 2155)
      return { ok: true, value }
    case 'string': {
      if (typeof value !== 'string') return { ok: false, code: 'invalid' }
      // MySQL counts characters, not UTF-16 units.
      const length = [...value].length
      if (spec.maxLength !== null && length > spec.maxLength) {
        return { ok: false, code: 'too_long', params: { max: spec.maxLength } }
      }
      return { ok: true, value }
    }
    case 'enum':
      return typeof value === 'string' && (spec.enumValues ?? []).includes(value)
        ? { ok: true, value }
        : { ok: false, code: 'not_allowed' }
    case 'set': {
      const allowed = spec.enumValues ?? []
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, code: 'invalid' }
      }
      if (value.some((item) => !allowed.includes(item as string))) {
        return { ok: false, code: 'not_allowed' }
      }
      // In the order of the definition, without repeats, like the database stores them.
      return { ok: true, value: allowed.filter((item) => value.includes(item)) }
    }
    case 'json':
    case 'unsupported':
      return { ok: false, code: 'field_not_writable' }
  }
}

/** A field's value, or `null`; empty text counts as missing for required fields. */
export function checkField(spec: FieldSpec, value: unknown): FieldCheck {
  if (value === null || (spec.required && value === '')) {
    return spec.nullable && !spec.required
      ? { ok: true, value: null }
      : { ok: false, code: 'required' }
  }
  if (spec.kind === 'set' && Array.isArray(value) && value.length === 0 && spec.required) {
    return { ok: false, code: 'required' }
  }
  return checkFieldValue(spec, value)
}

export type RowMode = 'create' | 'update'

export type RowCheck =
  { ok: true; values: Record<string, unknown> } | { ok: false; errors: FieldError[] }

/**
 * Checks a payload against the writable fields. The schema is strict: keys that are not
 * writable fields are rejected (`field_not_writable`). On create every required field must be
 * given; updates send only what changed.
 */
export function checkRow(fields: readonly FieldSpec[], mode: RowMode, payload: unknown): RowCheck {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: '_', code: 'invalid' }] }
  }
  const input = payload as Record<string, unknown>
  const byColumn = new Map(fields.map((field) => [field.column, field]))
  const errors: FieldError[] = []
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(input)) {
    if (!byColumn.has(key)) errors.push({ field: key, code: 'field_not_writable' })
  }
  for (const field of fields) {
    if (!Object.hasOwn(input, field.column)) {
      if (mode === 'create' && field.required)
        errors.push({ field: field.column, code: 'required' })
      continue
    }
    const checked = checkField(field, input[field.column])
    if (checked.ok) values[field.column] = checked.value
    else {
      errors.push({
        field: field.column,
        code: checked.code,
        ...(checked.params !== undefined && { params: checked.params }),
      })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}

/**
 * The same check as a Zod schema, so it composes with request schemas. Issue messages are the
 * field error codes.
 */
export function buildRowSchema(
  fields: readonly FieldSpec[],
  mode: RowMode,
): z.ZodType<Record<string, unknown>> {
  return z.unknown().transform((payload, context) => {
    const result = checkRow(fields, mode, payload)
    if (result.ok) return result.values
    for (const error of result.errors) {
      context.addIssue({
        code: 'custom',
        path: error.field === '_' ? [] : [error.field],
        message: error.code,
        ...(error.params !== undefined && { params: error.params }),
      })
    }
    return z.NEVER
  })
}
