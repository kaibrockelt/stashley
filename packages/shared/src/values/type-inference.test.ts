// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { CellFormat } from './csv-values.ts'
import {
  addValue,
  checkNewColumnType,
  emptyStats,
  suggestType,
  textType,
} from './type-inference.ts'

const format: CellFormat = {
  decimalSeparator: ',',
  thousandsSeparator: '',
  dateFormat: 'DD.MM.YYYY',
  dateTimeFormat: 'DD.MM.YYYY HH:mm:ss',
  trueValues: ['ja', 'true', '1', 'x'],
  falseValues: ['nein', 'false', '0'],
  emptyValues: [''],
  timeZone: 'Europe/Berlin',
}

function suggest(values: string[]) {
  const stats = emptyStats()
  for (const value of values) addValue(stats, value, format)
  return { type: suggestType(stats), stats }
}

describe('type suggestions', () => {
  it('pick the narrowest numeric type', () => {
    expect(suggest(['1', '42', '-7']).type).toEqual({ type: 'int' })
    expect(suggest(['2147483648']).type).toEqual({ type: 'bigint' })
    expect(suggest(['99999999999999999999']).type).toEqual({
      type: 'decimal',
      precision: 20,
      scale: 0,
    })
    expect(suggest(['12,50', '3,9', '100']).type).toEqual({
      type: 'decimal',
      precision: 5,
      scale: 2,
    })
    expect(suggest(['0', '1', '1']).type).toEqual({ type: 'int' })
  })

  it('keep values with leading zeros as text', () => {
    expect(suggest(['01234', '80331']).type).toEqual({ type: 'varchar', length: 32 })
  })

  it('recognize dates, date-times and true/false words', () => {
    expect(suggest(['31.01.2026', '01.02.2026']).type).toEqual({ type: 'date' })
    expect(suggest(['31.01.2026 14:30', '01.02.2026']).type).toEqual({ type: 'datetime' })
    expect(suggest(['ja', 'nein', '']).type).toEqual({ type: 'boolean' })
    expect(suggest(['x', '']).type).toEqual({ type: 'boolean' })
  })

  it('give text headroom and switch to TEXT beyond 255 characters', () => {
    expect(textType(10)).toEqual({ type: 'varchar', length: 32 })
    expect(textType(30)).toEqual({ type: 'varchar', length: 64 })
    expect(textType(100)).toEqual({ type: 'varchar', length: 255 })
    expect(textType(200)).toEqual({ type: 'varchar', length: 255 })
    expect(textType(256)).toEqual({ type: 'text' })
    expect(suggest(['Anna', 'Bernd']).type).toEqual({ type: 'varchar', length: 32 })
    expect(suggest([]).type).toEqual({ type: 'varchar', length: 255 })
  })

  it('count empty values and characters, not bytes', () => {
    const { stats } = suggest(['Grüße', '', 'a'])
    expect(stats.empty).toBe(1)
    expect(stats.values).toBe(2)
    expect(stats.maxLength).toBe(5)
  })

  it('check edited types', () => {
    expect(checkNewColumnType({ type: 'varchar', length: 100 })).toBeUndefined()
    expect(checkNewColumnType({ type: 'varchar' })).toBe('length')
    expect(checkNewColumnType({ type: 'varchar', length: 20000 })).toBe('length')
    expect(checkNewColumnType({ type: 'decimal', precision: 10, scale: 2 })).toBeUndefined()
    expect(checkNewColumnType({ type: 'decimal', precision: 66, scale: 2 })).toBe('precision')
    expect(checkNewColumnType({ type: 'decimal', precision: 4, scale: 5 })).toBe('scale')
    expect(checkNewColumnType({ type: 'int' })).toBeUndefined()
    expect(checkNewColumnType({ type: 'int', length: 5 })).toBe('type')
  })
})
