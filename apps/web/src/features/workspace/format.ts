// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ColumnFormat, DimensionValue, ValueKind } from '@stashley/shared'
import { useIntl, type IntlShape } from 'react-intl'
import { useSession } from '../../api/session.ts'
import { useT } from '../../i18n/use-t.ts'

/**
 * Formats values as the API encodes them (§9.5) with `Intl`, in the user's formatting locale.
 * Instants show in the instance time zone; dates have no time zone.
 */
export type ValueFormatter = (value: unknown, kind?: ValueKind, format?: ColumnFormat) => string

const empty = '–'

function numeric(value: unknown): number | string | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return value
  return null
}

function asNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value)
}

/** Seconds as the two largest units, e.g. "1 h 5 min". */
export function formatDuration(intl: IntlShape, seconds: number): string {
  const sign = seconds < 0 ? '−' : ''
  let rest = Math.round(Math.abs(seconds))
  const parts: string[] = []
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    const amount = Math.floor(rest / size)
    rest -= amount * size
    if (amount > 0 || (unit === 'second' && parts.length === 0)) {
      parts.push(intl.formatNumber(amount, { style: 'unit', unit, unitDisplay: 'short' }))
    }
    if (parts.length === 2) break
  }
  return sign + parts.join(' ')
}

/** The largest fitting unit for a relative time. */
export function formatRelative(intl: IntlShape, iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000
  const abs = Math.abs(seconds)
  for (const [unit, size] of [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    if (abs >= size)
      return intl.formatRelativeTime(Math.round(seconds / size), unit, { numeric: 'auto' })
  }
  return intl.formatRelativeTime(Math.round(seconds), 'second', { numeric: 'auto' })
}

export function createFormatter(
  intl: IntlShape,
  timeZone: string,
  yes: string,
  no: string,
): ValueFormatter {
  const dateOnly = (value: string) =>
    intl.formatDate(`${value}T00:00:00Z`, { dateStyle: 'medium', timeZone: 'UTC' })
  const instant = (value: string) =>
    intl.formatDate(value, { dateStyle: 'medium', timeStyle: 'short', timeZone })
  const isDate = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const isInstant = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value))

  return (value, kind, format) => {
    if (value === null || value === undefined) return empty
    if (format !== undefined) {
      const number = numeric(value)
      switch (format.kind) {
        case 'integer':
          if (number !== null) return intl.formatNumber(Math.round(asNumber(number)))
          break
        case 'decimal':
          if (number !== null)
            return intl.formatNumber(asNumber(number), {
              minimumFractionDigits: format.digits,
              maximumFractionDigits: format.digits,
            })
          break
        case 'currency':
          if (number !== null)
            return intl.formatNumber(asNumber(number), {
              style: 'currency',
              currency: format.currency,
              ...(format.digits !== undefined && {
                minimumFractionDigits: format.digits,
                maximumFractionDigits: format.digits,
              }),
            })
          break
        case 'percent':
          if (number !== null)
            return intl.formatNumber(asNumber(number), {
              style: 'percent',
              minimumFractionDigits: format.digits,
              maximumFractionDigits: format.digits,
            })
          break
        case 'duration':
          if (number !== null)
            return formatDuration(intl, asNumber(number) * (format.unit === 'minutes' ? 60 : 1))
          break
        case 'date':
          if (isDate(value)) return dateOnly(value)
          if (isInstant(value)) return intl.formatDate(value, { dateStyle: 'medium', timeZone })
          break
        case 'datetime':
          if (isInstant(value)) return instant(value)
          if (isDate(value)) return dateOnly(value)
          break
        case 'relative':
          if (isInstant(value)) return formatRelative(intl, value)
          if (isDate(value)) return formatRelative(intl, `${value}T00:00:00Z`)
          break
      }
    }
    switch (kind) {
      case 'boolean':
        return value === true || value === 1 ? yes : no
      case 'integer':
      case 'bigint':
      case 'decimal':
      case 'float':
      case 'year': {
        const number = numeric(value)
        if (number === null) break
        if (kind === 'year') return String(number)
        // Strings keep the exact decimal digits.
        return intl.formatNumber(number as number, { maximumFractionDigits: 20 })
      }
      case 'date':
        if (isDate(value)) return dateOnly(value)
        break
      case 'datetime':
      case 'timestamp':
        if (isInstant(value)) return instant(value)
        break
      case 'set':
        if (Array.isArray(value)) return value.join(', ')
        break
      default:
        if (kind === undefined && typeof value === 'number') return intl.formatNumber(value)
    }
    if (typeof value === 'boolean') return value ? yes : no
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
}

export function useValueFormatter(): ValueFormatter {
  const intl = useIntl()
  const t = useT()
  const { instance } = useSession()
  return createFormatter(intl, instance.timeZone, t('value.yes'), t('value.no'))
}

/** Labels of dimension values; NULL reads "(empty)", the bucket "Other". */
export function useDimensionLabel(): (
  value: DimensionValue,
  kind?: ValueKind,
  format?: ColumnFormat,
) => string {
  const t = useT()
  const formatValue = useValueFormatter()
  return (value, kind, format) =>
    value.kind === 'empty'
      ? t('value.empty')
      : value.kind === 'other'
        ? t('value.other')
        : formatValue(value.value, kind, format)
}
