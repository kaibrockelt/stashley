// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createIntl } from 'react-intl'
import { describe, expect, it } from 'vitest'
import { createFormatter, formatDuration, formatRelative } from './format.ts'

const intl = createIntl({ locale: 'de-DE', messages: {} })
const format = createFormatter(intl, 'Europe/Berlin', 'Ja', 'Nein')

describe('value formats', () => {
  it('formats numbers by kind and keeps exact decimals', () => {
    expect(format(1234.5, 'float')).toBe('1.234,5')
    expect(format('12345678901234567890', 'bigint')).toBe('12.345.678.901.234.567.890')
    expect(format('49.90', 'decimal')).toBe('49,9')
    expect(format(2026, 'year')).toBe('2026')
    expect(format(null, 'integer')).toBe('–')
  })

  it('applies column formats', () => {
    expect(format('49.9', 'decimal', { kind: 'currency', currency: 'EUR' })).toBe('49,90\u00a0€')
    expect(format(0.856, 'float', { kind: 'percent', digits: 1 })).toBe('85,6 %')
    expect(format(3.14159, 'float', { kind: 'decimal', digits: 2 })).toBe('3,14')
    expect(format(2.6, 'float', { kind: 'integer' })).toBe('3')
    expect(format(3900, 'integer', { kind: 'duration', unit: 'seconds' })).toBe('1 Std. 5 Min.')
    expect(format(90, 'integer', { kind: 'duration', unit: 'minutes' })).toBe('1 Std. 30 Min.')
    expect(format('x', 'string', { kind: 'integer' })).toBe('x')
  })

  it('shows dates without and instants with the instance time zone', () => {
    expect(format('2026-06-13', 'date')).toBe('13.06.2026')
    expect(format('2026-06-13T12:30:00.000Z', 'datetime')).toBe('13.06.2026, 14:30')
    expect(format('2026-06-13T12:30:00.000Z', 'timestamp', { kind: 'date' })).toBe('13.06.2026')
    expect(format('2026-06-13', 'date', { kind: 'datetime' })).toBe('13.06.2026')
  })

  it('formats booleans, sets and other values', () => {
    expect(format(true, 'boolean')).toBe('Ja')
    expect(format(0, 'boolean')).toBe('Nein')
    expect(format(['a', 'b'], 'set')).toBe('a, b')
    expect(format({ a: 1 }, 'json')).toBe('{"a":1}')
    expect(format(false)).toBe('Nein')
    expect(format(5)).toBe('5')
  })

  it('formats durations and relative times', () => {
    expect(formatDuration(intl, 0)).toBe('0 Sek.')
    expect(formatDuration(intl, -61)).toBe('−1 Min. 1 Sek.')
    expect(formatDuration(intl, 90_061)).toBe('1 Tg. 1 Std.')
    const now = Date.parse('2026-06-13T12:30:00Z')
    expect(formatRelative(intl, '2026-06-13T12:27:00Z', now)).toBe('vor 3 Minuten')
    expect(formatRelative(intl, '2026-06-13T12:29:58Z', now)).toBe('vor 2 Sekunden')
    expect(formatRelative(intl, '2026-06-10T12:30:00Z', now)).toBe('vor 3 Tagen')
  })
})
