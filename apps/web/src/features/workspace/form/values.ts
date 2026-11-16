// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError, FieldSpec, RenderField } from '@stashley/shared'
import {
  checkRow,
  evaluateDateExpression,
  formatWallDate,
  instantOf,
  parseDateExpression,
  wallTimeOf,
} from '@stashley/shared'

/**
 * Values of form fields between the inputs and the API (§ Formulare). Inputs hold text as the
 * user types it; numbers follow the user's format (49,90), date-times are wall times of the
 * instance time zone. The payload uses the JSON forms of §9.5 and is checked with the same
 * row schema as on the server.
 */

/** What an input holds: text, a switch, the chosen values of a set, or nothing. */
export type InputValue = string | boolean | string[] | null

export interface FormatContext {
  /** The user's formatting locale, e.g. `de-DE`. */
  locale: string
  /** The instance time zone (`APP_TIMEZONE`). */
  timeZone: string
}

export function decimalSeparator(locale: string): string {
  try {
    return (
      new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')
        ?.value ?? '.'
    )
  } catch {
    return '.'
  }
}

/**
 * A number as typed, in canonical form (`-1234.5`), or undefined. Group separators are
 * accepted where they group digits by three; the decimal separator is the locale's.
 */
export function parseNumber(text: string, locale: string): string | undefined {
  const decimal = decimalSeparator(locale)
  const group = decimal === ',' ? '.' : ','
  let value = text.trim().replace(/[\s\u00a0\u202f']/g, '')
  if (value === '') return undefined
  const sign = value.startsWith('-') || value.startsWith('−') ? '-' : ''
  value = value.replace(/^[-−+]/, '')
  const [whole = '', fraction, extra] = value.split(decimal)
  if (extra !== undefined) return undefined
  if (whole.includes(group)) {
    if (!new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(whole)) return undefined
  } else if (!/^\d*$/.test(whole)) return undefined
  if (fraction !== undefined && !/^\d+$/.test(fraction)) return undefined
  const digits = whole.replaceAll(group, '')
  if (digits === '' && fraction === undefined) return undefined
  return `${sign}${digits === '' ? '0' : digits}${fraction === undefined ? '' : `.${fraction}`}`
}

/** A canonical number for the input, with the locale's decimal separator, without grouping. */
export function formatNumberInput(value: unknown, locale: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const text = String(value)
  return decimalSeparator(locale) === ',' ? text.replace('.', ',') : text
}

/** `YYYY-MM-DDTHH:MM` of an instant in the instance time zone, for a datetime input. */
export function instantToInput(value: unknown, timeZone: string): string {
  if (typeof value !== 'string' || value === '') return ''
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const wall = wallTimeOf(time, timeZone)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${formatWallDate(wall)}T${pad(wall.hour)}:${pad(wall.minute)}`
}

/** The instant of a datetime input's wall time in the instance time zone. */
export function inputToInstant(text: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (match === null) return undefined
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0))
  const instant = instantOf(
    {
      year: year ?? 0,
      month: month ?? 1,
      day: day ?? 1,
      hour: hour ?? 0,
      minute: minute ?? 0,
      second: second ?? 0,
    },
    timeZone,
  )
  return new Date(instant).toISOString().replace('.000Z', 'Z')
}

/** An API value as the input shows it. */
export function toInput(field: RenderField, value: unknown, format: FormatContext): InputValue {
  if (value === null || value === undefined) {
    return field.kind === 'boolean' ? false : field.kind === 'set' ? [] : null
  }
  switch (field.kind) {
    case 'boolean':
      return value === true
    case 'set':
      return Array.isArray(value) ? value.map(String) : []
    case 'integer':
    case 'decimal':
    case 'float':
      return formatNumberInput(value, format.locale)
    case 'datetime':
    case 'timestamp':
      return instantToInput(value, format.timeZone)
    default:
      return typeof value === 'string' || typeof value === 'number' ? String(value) : null
  }
}

export type Converted = { ok: true; value: unknown } | { ok: false; code: string }

/** An input value in its JSON form; empty inputs are null. */
export function fromInput(field: RenderField, input: InputValue, format: FormatContext): Converted {
  if (input === null || input === '') return { ok: true, value: null }
  switch (field.kind) {
    case 'boolean':
      return { ok: true, value: input === true }
    case 'set':
      return { ok: true, value: Array.isArray(input) ? input : [] }
    case 'integer':
    case 'bigint':
    case 'decimal':
    case 'float':
    case 'year': {
      if (typeof input !== 'string') return { ok: false, code: 'invalid' }
      // Foreign keys hold the chosen key as it came from the server.
      if (field.reference !== undefined && field.kind === 'bigint')
        return { ok: true, value: input }
      const number = parseNumber(input, format.locale)
      if (number === undefined) return { ok: false, code: 'invalid' }
      if (field.kind === 'integer' || field.kind === 'year' || field.kind === 'float') {
        return { ok: true, value: Number(number) }
      }
      return { ok: true, value: number }
    }
    case 'datetime':
    case 'timestamp': {
      if (typeof input !== 'string') return { ok: false, code: 'invalid' }
      const instant = inputToInstant(input, format.timeZone)
      return instant === undefined ? { ok: false, code: 'invalid' } : { ok: true, value: instant }
    }
    default:
      return typeof input === 'string' ? { ok: true, value: input } : { ok: false, code: 'invalid' }
  }
}

/** The shared row schema's view of a rendered field. */
export function specOf(field: RenderField): FieldSpec {
  return {
    column: field.column,
    kind: field.kind,
    columnType: field.columnType,
    nullable: field.nullable,
    required: field.required,
    maxLength: field.maxLength,
    precision: field.precision,
    scale: field.scale,
    enumValues: field.enumValues,
  }
}

/** What a new record starts with: defaults, page filter and URL values, date suggestions. */
export function initialValues(
  fields: readonly RenderField[],
  context: {
    filters: Readonly<Record<string, unknown>>
    params: Readonly<Record<string, unknown>>
    now: number
  },
  format: FormatContext,
): Record<string, InputValue> {
  const values: Record<string, InputValue> = {}
  for (const field of fields) {
    let value: unknown = null
    const prefill = field.default
    if (prefill?.kind === 'value') value = prefill.value
    else if (prefill?.kind === 'filter') value = context.filters[prefill.filterId] ?? null
    else if (prefill?.kind === 'url') value = context.params[prefill.name] ?? null
    const generator = field.generator
    if (generator?.kind === 'date' && generator.editable) {
      const expression = parseDateExpression(generator.expression)
      const kind = field.kind
      if (
        expression !== undefined &&
        (kind === 'date' || kind === 'datetime' || kind === 'timestamp')
      ) {
        value = evaluateDateExpression(expression, context.now, format.timeZone, kind)
      }
    }
    values[field.column] = toInput(field, value, format)
  }
  return values
}

export interface Payload {
  values: Record<string, unknown>
  errors: FieldError[]
}

/**
 * The payload of a write: fields the operation may carry, converted and checked with the row
 * schema. Updates send only what changed against `loaded`.
 */
export function buildPayload(
  fields: readonly RenderField[],
  inputs: Readonly<Record<string, InputValue>>,
  operation: 'create' | 'update',
  format: FormatContext,
  loaded?: Readonly<Record<string, InputValue>>,
): Payload {
  const writable = fields.filter((field) => (operation === 'create' ? field.create : field.update))
  const values: Record<string, unknown> = {}
  const errors: FieldError[] = []
  for (const field of writable) {
    const input = inputs[field.column] ?? null
    if (
      loaded !== undefined &&
      JSON.stringify(loaded[field.column] ?? null) === JSON.stringify(input)
    ) {
      continue
    }
    // Optional fields left empty on create are left to the server and the database.
    if (operation === 'create' && !field.required && (input === null || input === '')) continue
    const converted = fromInput(field, input, format)
    if (!converted.ok) errors.push({ field: field.column, code: converted.code })
    else values[field.column] = converted.value
  }
  const specs = writable
    .filter((field) => !errors.some((error) => error.field === field.column))
    .map(specOf)
  const checked = checkRow(specs, operation, values)
  if (!checked.ok) errors.push(...checked.errors)
  return { values: checked.ok ? checked.values : values, errors }
}
