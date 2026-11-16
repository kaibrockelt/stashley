// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ValueKind } from './column-kinds.ts'
import { instantOf, type WallTime } from './date-expression.ts'

/**
 * Values of CSV cells (§17 step 2, E25). A cell is text; these functions read it into the
 * JSON form of §9.5 for its column kind, so the row schema then checks lengths, ranges and
 * precision as it does for forms.
 */

export const decimalSeparators = ['.', ','] as const
export type DecimalSeparator = (typeof decimalSeparators)[number]

/** `''` means no thousands separator; the space covers the narrow and no-break spaces too. */
export const thousandsSeparators = ['', '.', ',', ' ', "'"] as const
export type ThousandsSeparator = (typeof thousandsSeparators)[number]

export interface CellFormat {
  decimalSeparator: DecimalSeparator
  thousandsSeparator: ThousandsSeparator
  /** Tokens `YYYY`, `YY`, `MM`, `M`, `DD`, `D` and literal separators, e.g. `DD.MM.YYYY`. */
  dateFormat: string
  /** The date format followed by `HH:mm` or `HH:mm:ss`; seconds may be missing in a value. */
  dateTimeFormat: string
  trueValues: readonly string[]
  falseValues: readonly string[]
  /** Cells read as NULL, compared after trimming; the empty cell by default. */
  emptyValues: readonly string[]
  /** Wall times without an offset are read in this zone (`APP_TIMEZONE`). */
  timeZone: string
}

export type CellResult = { ok: true; value: unknown } | { ok: false; code: string }

const invalid: CellResult = { ok: false, code: 'invalid' }

// Date formats

const dateTokens = ['YYYY', 'YY', 'MM', 'M', 'DD', 'D', 'HH', 'H', 'mm', 'ss'] as const
type DateToken = (typeof dateTokens)[number]

type FormatPart = { token: DateToken } | { literal: string }

const tokenPatterns: Record<DateToken, string> = {
  YYYY: '(\\d{4})',
  YY: '(\\d{2})',
  MM: '(\\d{2})',
  M: '(\\d{1,2})',
  DD: '(\\d{2})',
  D: '(\\d{1,2})',
  HH: '(\\d{2})',
  H: '(\\d{1,2})',
  mm: '(\\d{2})',
  ss: '(\\d{2})',
}

const literalPattern = /^[ .,/\-:T]$/

/** Splits a format into tokens and literals; undefined when it is not a valid format. */
export function parseDateFormat(format: string): FormatPart[] | undefined {
  const parts: FormatPart[] = []
  let rest = format
  while (rest.length > 0) {
    const token = dateTokens.find((candidate) => rest.startsWith(candidate))
    if (token !== undefined) {
      parts.push({ token })
      rest = rest.slice(token.length)
      continue
    }
    const char = rest[0] as string
    if (!literalPattern.test(char)) return undefined
    parts.push({ literal: char })
    rest = rest.slice(1)
  }
  const tokens = parts.flatMap((part) => ('token' in part ? [part.token] : []))
  if (new Set(tokens.map((token) => token[0])).size !== tokens.length) return undefined
  return tokens.length > 0 ? parts : undefined
}

/** A date format names a year, a month and a day and nothing else. */
export function isDateFormat(format: string): boolean {
  const parts = parseDateFormat(format)
  if (parts === undefined) return false
  const kinds = new Set(parts.flatMap((part) => ('token' in part ? [part.token[0]] : [])))
  return kinds.size === 3 && kinds.has('Y') && kinds.has('M') && kinds.has('D')
}

/** A date-time format adds hours and minutes, optionally seconds. */
export function isDateTimeFormat(format: string): boolean {
  const parts = parseDateFormat(format)
  if (parts === undefined) return false
  const kinds = new Set(parts.flatMap((part) => ('token' in part ? [part.token] : [])))
  const has = (...tokens: DateToken[]) => tokens.some((token) => kinds.has(token))
  return has('YYYY', 'YY') && has('MM', 'M') && has('DD', 'D') && has('HH', 'H') && kinds.has('mm')
}

const compiled = new Map<string, { pattern: RegExp; tokens: DateToken[] } | null>()

function compile(format: string, optionalSeconds: boolean) {
  const cacheKey = `${optionalSeconds ? '?' : ''}${format}`
  const cached = compiled.get(cacheKey)
  if (cached !== undefined) return cached
  const parts = parseDateFormat(format)
  let result: { pattern: RegExp; tokens: DateToken[] } | null = null
  if (parts !== undefined) {
    const tokens: DateToken[] = []
    let source = ''
    parts.forEach((part, index) => {
      if ('literal' in part) {
        const next = parts[index + 1]
        // `:ss` may be missing in a value when the format has seconds.
        if (optionalSeconds && next !== undefined && 'token' in next && next.token === 'ss') {
          source += `(?:${part.literal.replace(/[.\-/]/g, '\\$&')}`
          return
        }
        source += part.literal === ' ' ? '\\s+' : part.literal.replace(/[.\-/]/g, '\\$&')
        return
      }
      tokens.push(part.token)
      source += tokenPatterns[part.token]
      const previous = parts[index - 1]
      if (optionalSeconds && part.token === 'ss' && previous !== undefined && 'literal' in previous)
        source += ')?'
    })
    result = { pattern: new RegExp(`^${source}$`), tokens }
  }
  compiled.set(cacheKey, result)
  return result
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Reads a text with a format into wall time fields; undefined when it does not match. */
export function readDate(text: string, format: string, withTime: boolean): WallTime | undefined {
  const compiledFormat = compile(format, withTime)
  if (compiledFormat === null) return undefined
  const match = compiledFormat.pattern.exec(text)
  if (match === null) return undefined
  const wall: WallTime = { year: NaN, month: NaN, day: NaN, hour: 0, minute: 0, second: 0 }
  compiledFormat.tokens.forEach((token, index) => {
    const raw = match[index + 1]
    if (raw === undefined) return
    const value = Number(raw)
    if (token === 'YYYY') wall.year = value
    else if (token === 'YY') wall.year = value < 70 ? 2000 + value : 1900 + value
    else if (token === 'MM' || token === 'M') wall.month = value
    else if (token === 'DD' || token === 'D') wall.day = value
    else if (token === 'HH' || token === 'H') wall.hour = value
    else if (token === 'mm') wall.minute = value
    else wall.second = value
  })
  if (
    !Number.isInteger(wall.year) ||
    wall.year < 1000 ||
    wall.month < 1 ||
    wall.month > 12 ||
    wall.day < 1 ||
    wall.day > daysIn(wall.year, wall.month) ||
    wall.hour > 23 ||
    wall.minute > 59 ||
    wall.second > 59
  ) {
    return undefined
  }
  return wall
}

/** Writes a date in a format, for previews and the error list. */
export function formatDate(wall: WallTime, format: string): string {
  const parts = parseDateFormat(format) ?? []
  return parts
    .map((part) => {
      if ('literal' in part) return part.literal
      switch (part.token) {
        case 'YYYY':
          return pad(wall.year, 4)
        case 'YY':
          return pad(wall.year % 100)
        case 'MM':
          return pad(wall.month)
        case 'M':
          return String(wall.month)
        case 'DD':
          return pad(wall.day)
        case 'D':
          return String(wall.day)
        case 'HH':
          return pad(wall.hour)
        case 'H':
          return String(wall.hour)
        case 'mm':
          return pad(wall.minute)
        default:
          return pad(wall.second)
      }
    })
    .join('')
}

const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i

// Numbers

const groupSpaces = /[\u00a0\u202f]/g

/**
 * Normalizes a number to `-123.45`: a sign, digits, and the decimal separator; thousands
 * separators only between groups of three digits.
 */
export function readNumber(
  text: string,
  format: Pick<CellFormat, 'decimalSeparator' | 'thousandsSeparator'>,
): string | undefined {
  let value = text.trim().replace(groupSpaces, ' ')
  if (format.thousandsSeparator === format.decimalSeparator) return undefined
  let sign = ''
  if (value.startsWith('-') || value.startsWith('+')) {
    sign = value[0] === '-' ? '-' : ''
    value = value.slice(1)
  }
  const [whole = '', fraction, extra] = value.split(format.decimalSeparator)
  if (extra !== undefined) return undefined
  let digits = whole
  const separator = format.thousandsSeparator
  if (separator !== '' && whole.includes(separator)) {
    const groups = whole.split(separator)
    if (
      !/^\d{1,3}$/.test(groups[0] ?? '') ||
      groups.slice(1).some((group) => !/^\d{3}$/.test(group))
    ) {
      return undefined
    }
    digits = groups.join('')
  }
  if (!/^\d+$/.test(digits)) return undefined
  if (fraction !== undefined && !/^\d+$/.test(fraction)) return undefined
  const normalized = `${sign}${digits}${fraction === undefined ? '' : `.${fraction}`}`
  return normalized === '-0' ? '0' : normalized
}

// Cells

const lowered = (values: readonly string[]) => values.map((value) => value.trim().toLowerCase())

/** Whether a cell counts as empty (NULL). */
export function isEmptyCell(raw: string, format: Pick<CellFormat, 'emptyValues'>): boolean {
  const trimmed = raw.trim()
  return format.emptyValues.some((value) => value.trim() === trimmed)
}

/**
 * Reads one non-empty cell into the JSON form of its column kind (§9.5). Text keeps its
 * spaces; other kinds are trimmed (E25).
 */
export function readCell(
  raw: string,
  kind: ValueKind,
  format: CellFormat,
  enumValues?: readonly string[],
): CellResult {
  if (kind === 'string') return { ok: true, value: raw }
  const text = raw.trim()
  switch (kind) {
    case 'boolean': {
      const value = text.toLowerCase()
      if (lowered(format.trueValues).includes(value)) return { ok: true, value: true }
      if (lowered(format.falseValues).includes(value)) return { ok: true, value: false }
      return invalid
    }
    case 'integer':
    case 'bigint':
    case 'year': {
      const number = readNumber(text, format)
      if (number === undefined || number.includes('.')) return invalid
      const trimmed = number.replace(/^(-?)0+(?=\d)/, '$1')
      if (kind === 'bigint') return { ok: true, value: trimmed }
      const parsed = Number(trimmed)
      return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : invalid
    }
    case 'decimal': {
      const number = readNumber(text, format)
      return number === undefined ? invalid : { ok: true, value: number }
    }
    case 'float': {
      const number = readNumber(text, format)
      if (number === undefined) return invalid
      const parsed = Number(number)
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : invalid
    }
    case 'date': {
      const wall = readDate(text, format.dateFormat, false)
      if (wall === undefined) return invalid
      return { ok: true, value: `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` }
    }
    case 'datetime':
    case 'timestamp': {
      // An instant with an offset stands for itself; other values are wall times (E25).
      if (isoInstant.test(text)) {
        const instant = Date.parse(text)
        return Number.isNaN(instant)
          ? invalid
          : { ok: true, value: new Date(instant).toISOString().replace('.000Z', 'Z') }
      }
      const wall =
        readDate(text, format.dateTimeFormat, true) ?? readDate(text, format.dateFormat, false)
      if (wall === undefined) return invalid
      const instant = instantOf(wall, format.timeZone)
      return { ok: true, value: new Date(instant).toISOString().replace('.000Z', 'Z') }
    }
    case 'time':
      return /^-?\d{1,3}:[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$/.test(text)
        ? { ok: true, value: text }
        : invalid
    case 'enum': {
      const found = enumValues?.find((value) => value.toLowerCase() === text.toLowerCase())
      return found === undefined ? { ok: false, code: 'not_in_list' } : { ok: true, value: found }
    }
    case 'set': {
      const items = text === '' ? [] : text.split(',').map((item) => item.trim())
      const values: string[] = []
      for (const item of items) {
        const found = enumValues?.find((value) => value.toLowerCase() === item.toLowerCase())
        if (found === undefined) return { ok: false, code: 'not_in_list' }
        if (!values.includes(found)) values.push(found)
      }
      return { ok: true, value: values }
    }
    default:
      return { ok: false, code: 'not_importable' }
  }
}

// Suggested formats (E25)

export interface FormatSuggestion {
  decimalSeparator: DecimalSeparator
  thousandsSeparator: ThousandsSeparator
  dateFormat: string
  dateTimeFormat: string
  trueValues: string[]
  falseValues: string[]
}

const dateCandidates = [
  'YYYY-MM-DD',
  'DD.MM.YYYY',
  'D.M.YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'D/M/YYYY',
  'M/D/YYYY',
  'DD.MM.YY',
] as const

/** Default formats of a format locale such as `de-DE` or `en-US`. */
export function localeFormats(formatLocale: string): FormatSuggestion {
  const decimal = new Intl.NumberFormat(formatLocale)
    .formatToParts(1.5)
    .find((part) => part.type === 'decimal')?.value
  const comma = decimal === ','
  const sample = new Intl.DateTimeFormat(formatLocale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.UTC(2006, 0, 31, 12)))
  const dateFormat = sample.startsWith('2006')
    ? 'YYYY-MM-DD'
    : sample.startsWith('01')
      ? 'MM/DD/YYYY'
      : sample.includes('.')
        ? 'DD.MM.YYYY'
        : 'DD/MM/YYYY'
  const german = formatLocale.toLowerCase().startsWith('de')
  return {
    decimalSeparator: comma ? ',' : '.',
    thousandsSeparator: '',
    dateFormat,
    dateTimeFormat: `${dateFormat} HH:mm:ss`,
    trueValues: german ? ['ja', 'wahr', 'true', '1', 'x'] : ['true', 'yes', '1', 'x'],
    falseValues: german ? ['nein', 'falsch', 'false', '0'] : ['false', 'no', '0'],
  }
}

/**
 * Formats suggested from sample values per column: what the data shows unambiguously wins,
 * otherwise the user's format locale decides (E25).
 */
export function suggestFormats(
  columns: readonly (readonly string[])[],
  formatLocale: string,
): FormatSuggestion {
  const defaults = localeFormats(formatLocale)
  const values = columns.flat().map((value) => value.trim())
  const numeric = values.filter((value) => /^[+-]?[\d.,' \u00a0\u202f]*\d$/.test(value))
  let decimal: DecimalSeparator = defaults.decimalSeparator
  let thousands: ThousandsSeparator = ''
  const commaDecimal = numeric.some((value) => /^[+-]?\d+,\d{1,2}$|,\d{1,2}$/.test(value))
  const dotDecimal = numeric.some((value) => /^[+-]?\d+\.\d{1,2}$/.test(value))
  if (commaDecimal && !dotDecimal) decimal = ','
  else if (dotDecimal && !commaDecimal) decimal = '.'
  const grouped = (separator: string) =>
    numeric.some((value) =>
      new RegExp(
        `^[+-]?\\d{1,3}(\\${separator}\\d{3})+(\\${decimal === ',' ? ',' : '.'}\\d+)?$`,
      ).test(value),
    )
  if (decimal === ',' && grouped('.')) thousands = '.'
  else if (decimal === '.' && numeric.some((value) => /^\d{1,3}(,\d{3})+\.\d+$/.test(value)))
    thousands = ','

  const dateLike = values.filter((value) => /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.test(value))
  let dateFormat = defaults.dateFormat
  if (dateLike.length > 0) {
    const dates = dateLike.map((value) => value.split(/\s+/)[0] as string)
    const fitting = dateCandidates.filter((candidate) =>
      dates.every((date) => readDate(date, candidate, false) !== undefined),
    )
    if (fitting.includes(defaults.dateFormat as (typeof dateCandidates)[number]))
      dateFormat = defaults.dateFormat
    else if (fitting[0] !== undefined) dateFormat = fitting[0]
  }
  // Seconds may be missing in a value, so the format always names them.
  const dateTimeFormat = `${dateFormat} HH:mm:ss`
  return {
    ...defaults,
    decimalSeparator: decimal,
    thousandsSeparator: thousands,
    dateFormat,
    dateTimeFormat,
  }
}
