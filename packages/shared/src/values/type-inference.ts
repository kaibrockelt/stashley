// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { isEmptyCell, readDate, readNumber, type CellFormat } from './csv-values.ts'

/**
 * Column types for new tables (§17 step 7, E28), suggested from every value of a CSV column
 * and editable before the table is created.
 */

export const newColumnTypes = [
  'int',
  'bigint',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'varchar',
  'text',
] as const
export type NewColumnTypeName = (typeof newColumnTypes)[number]

export interface NewColumnType {
  type: NewColumnTypeName
  /** `varchar`: characters, 1–16383 (utf8mb4 keeps rows below InnoDB's limit only up to 255). */
  length?: number
  /** `decimal`: 1–65 digits, of them 0–30 after the point. */
  precision?: number
  scale?: number
}

export const varcharSteps = [32, 64, 128, 255] as const
export const maxDecimalPrecision = 65
export const maxDecimalScale = 30

const int32 = [-2147483648n, 2147483647n] as const
const int64 = [-9223372036854775808n, 9223372036854775807n] as const

export interface ColumnStats {
  /** Non-empty values seen. */
  values: number
  empty: number
  maxLength: number
  /** Every value an integer (no leading zeros), with its range. */
  integer: boolean
  min: bigint | null
  max: bigint | null
  /** Every value a number; digits before and after the point. */
  numeric: boolean
  intDigits: number
  scale: number
  date: boolean
  datetime: boolean
  /** Every value a true/false word other than plain 0 and 1. */
  boolean: boolean
  booleanWords: boolean
}

export function emptyStats(): ColumnStats {
  return {
    values: 0,
    empty: 0,
    maxLength: 0,
    integer: true,
    min: null,
    max: null,
    numeric: true,
    intDigits: 0,
    scale: 0,
    date: true,
    datetime: true,
    boolean: true,
    booleanWords: false,
  }
}

/** Adds one cell to the statistics of its column. */
export function addValue(stats: ColumnStats, raw: string, format: CellFormat): void {
  if (isEmptyCell(raw, format)) {
    stats.empty++
    return
  }
  stats.values++
  stats.maxLength = Math.max(stats.maxLength, [...raw].length)
  const text = raw.trim()

  if (stats.numeric || stats.integer) {
    const number = readNumber(text, format)
    if (number === undefined) {
      stats.numeric = false
      stats.integer = false
    } else {
      const [whole = '', fraction = ''] = number.replace('-', '').split('.')
      // Leading zeros (postal codes, phone numbers) are text, not numbers.
      if (whole.length > 1 && whole.startsWith('0')) {
        stats.numeric = false
        stats.integer = false
      } else {
        stats.intDigits = Math.max(stats.intDigits, whole.length)
        stats.scale = Math.max(stats.scale, fraction.length)
        if (fraction !== '') stats.integer = false
        if (stats.integer) {
          const value = BigInt(number)
          stats.min = stats.min === null || value < stats.min ? value : stats.min
          stats.max = stats.max === null || value > stats.max ? value : stats.max
        }
      }
    }
  }
  if (stats.date && readDate(text, format.dateFormat, false) === undefined) stats.date = false
  if (
    stats.datetime &&
    readDate(text, format.dateTimeFormat, true) === undefined &&
    readDate(text, format.dateFormat, false) === undefined
  ) {
    stats.datetime = false
  }
  if (stats.boolean) {
    const value = text.toLowerCase()
    const isTrue = format.trueValues.some((word) => word.trim().toLowerCase() === value)
    const isFalse = format.falseValues.some((word) => word.trim().toLowerCase() === value)
    if (!isTrue && !isFalse) stats.boolean = false
    else if (value !== '0' && value !== '1') stats.booleanWords = true
  }
}

/** The smallest VARCHAR step with headroom (1.5 × the longest value), or TEXT beyond 255. */
export function textType(maxLength: number): NewColumnType {
  if (maxLength > 255) return { type: 'text' }
  const wanted = Math.ceil(maxLength * 1.5)
  const step = varcharSteps.find((candidate) => candidate >= wanted) ?? 255
  return { type: 'varchar', length: step }
}

/**
 * The suggested type (E28): INT within 32 bits, otherwise BIGINT; DECIMAL from the widest
 * digits; DATE and DATETIME in the chosen formats; BOOLEAN only for true/false words (plain
 * 0/1 columns stay INT); text as VARCHAR with headroom up to 255 characters, then TEXT.
 * Columns without values become VARCHAR(255).
 */
export function suggestType(stats: ColumnStats): NewColumnType {
  if (stats.values === 0) return { type: 'varchar', length: 255 }
  if (stats.boolean && stats.booleanWords) return { type: 'boolean' }
  if (stats.integer && stats.min !== null && stats.max !== null) {
    if (stats.min >= int32[0] && stats.max <= int32[1]) return { type: 'int' }
    if (stats.min >= int64[0] && stats.max <= int64[1]) return { type: 'bigint' }
  }
  if (stats.numeric) {
    const precision = Math.max(stats.intDigits + stats.scale, 1)
    if (precision <= maxDecimalPrecision && stats.scale <= maxDecimalScale) {
      return { type: 'decimal', precision, scale: stats.scale }
    }
  }
  if (stats.date) return { type: 'date' }
  if (stats.datetime) return { type: 'datetime' }
  return textType(stats.maxLength)
}

/** A type definition the DDL generator accepts; the field of the problem otherwise. */
export function checkNewColumnType(column: NewColumnType): string | undefined {
  switch (column.type) {
    case 'varchar':
      return column.length !== undefined &&
        Number.isInteger(column.length) &&
        column.length >= 1 &&
        column.length <= 16383
        ? undefined
        : 'length'
    case 'decimal': {
      const { precision, scale } = column
      if (
        precision === undefined ||
        !Number.isInteger(precision) ||
        precision < 1 ||
        precision > maxDecimalPrecision
      )
        return 'precision'
      if (
        scale === undefined ||
        !Number.isInteger(scale) ||
        scale < 0 ||
        scale > Math.min(maxDecimalScale, precision)
      )
        return 'scale'
      return undefined
    }
    default:
      return column.length === undefined &&
        column.precision === undefined &&
        column.scale === undefined
        ? undefined
        : 'type'
  }
}
