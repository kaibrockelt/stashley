// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { exportCell, exportFormat, exportRow } from './csv.ts'

describe('CSV export (E12)', () => {
  const german = exportFormat('de-DE', 'Europe/Berlin')
  const us = exportFormat('en-US', 'Europe/Berlin')

  it('follows the user format for delimiter and decimal separator', () => {
    expect(german).toMatchObject({ delimiter: ';', decimal: ',' })
    expect(us).toMatchObject({ delimiter: ',', decimal: '.' })
    expect(exportFormat('de-CH', 'UTC')).toMatchObject({ delimiter: ',', decimal: '.' })
    expect(exportFormat('xx-invalid-locale-!', 'UTC')).toMatchObject({ delimiter: ',' })
    expect(exportCell('49.90', 'decimal', german)).toBe('49,90')
    expect(exportCell('49.90', 'decimal', us)).toBe('49.90')
    expect(exportCell(-5, 'integer', german)).toBe('-5')
    expect(exportRow(['a', 'b'], german)).toBe('a;b\r\n')
  })

  it('writes dates as ISO and date-times as wall times of the instance', () => {
    expect(exportCell('2026-05-08', 'date', german)).toBe('2026-05-08')
    expect(exportCell('2026-05-08T16:45:00Z', 'datetime', german)).toBe('2026-05-08 18:45:00')
    expect(exportCell(true, 'boolean', german)).toBe('true')
    expect(exportCell(['mo', 'di'], 'set', german)).toBe('mo, di')
    expect(exportCell(null, 'string', german)).toBe('')
  })

  it('defuses text that spreadsheets would run, never numbers', () => {
    for (const text of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx']) {
      expect(exportCell(text, 'string', german).replace(/^"/, '').startsWith("'"), text).toBe(true)
    }
    expect(exportCell('a;b', 'string', german)).toBe('"a;b"')
    expect(exportCell('a,b', 'string', german)).toBe('a,b')
    expect(exportCell('say "hi"', 'string', us)).toBe('"say ""hi"""')
    expect(exportCell('1,5', 'string', german)).toBe('1,5')
  })
})
