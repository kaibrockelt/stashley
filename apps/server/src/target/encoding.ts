// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ValueKind } from '@stashley/shared'

/**
 * Converts a driver value (with `dateStrings`, `bigNumberStrings`) to its JSON form (§9.5).
 * `DATETIME` values are wall times in the connection's time zone and become UTC instants.
 * Invalid zero dates become null; the caller flags the row.
 */
export function encodeValue(
  kind: ValueKind,
  raw: string | number | null | undefined,
  timeZone: string,
): { value: unknown; invalid?: true } {
  if (raw === null || raw === undefined) return { value: null }
  const text = String(raw)
  switch (kind) {
    case 'boolean':
      return { value: Number(raw) !== 0 }
    case 'integer':
    case 'year':
    case 'float':
      return { value: Number(raw) }
    case 'bigint':
    case 'decimal':
      // The driver returns them as strings without exponent; they stay exact.
      return { value: text }
    case 'date':
      return isZeroDate(text) || !isValidDate(text)
        ? { value: null, invalid: true }
        : { value: text }
    case 'datetime':
    case 'timestamp': {
      if (isZeroDate(text)) return { value: null, invalid: true }
      // Legacy data written with ALLOW_INVALID_DATES (e.g. 2025-02-30) is flagged like a zero date.
      try {
        return { value: wallTimeToInstant(text, kind === 'datetime' ? timeZone : 'UTC') }
      } catch {
        return { value: null, invalid: true }
      }
    }
    case 'set':
      return { value: text === '' ? [] : text.split(',') }
    case 'unsupported':
      return { value: null }
    default:
      return { value: text }
  }
}

/** Converts a JSON value for a write: UTC instants become wall times again. */
export function decodeDateTime(instant: string, timeZone: string): string {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone)
  return zoned.toPlainDateTime().toString().replace('T', ' ')
}

function isZeroDate(text: string): boolean {
  return text.startsWith('0000-00-00') || /^\d{4}-00-|^\d{4}-\d{2}-00/.test(text)
}

function isValidDate(text: string): boolean {
  try {
    Temporal.PlainDate.from(text)
    return true
  } catch {
    return false
  }
}

function wallTimeToInstant(text: string, timeZone: string): string {
  const plain = Temporal.PlainDateTime.from(text.replace(' ', 'T'))
  return plain.toZonedDateTime(timeZone, { disambiguation: 'compatible' }).toInstant().toString()
}
