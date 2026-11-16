// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  formatDate,
  isDateFormat,
  isDateTimeFormat,
  isEmptyCell,
  localeFormats,
  readCell,
  readDate,
  readNumber,
  suggestFormats,
  type CellFormat,
} from './csv-values.ts'

const german: CellFormat = {
  decimalSeparator: ',',
  thousandsSeparator: '.',
  dateFormat: 'DD.MM.YYYY',
  dateTimeFormat: 'DD.MM.YYYY HH:mm:ss',
  trueValues: ['ja', 'x'],
  falseValues: ['nein'],
  emptyValues: ['', '-'],
  timeZone: 'Europe/Berlin',
}

describe('date formats', () => {
  it('accept tokens with separators and reject the rest', () => {
    expect(isDateFormat('DD.MM.YYYY')).toBe(true)
    expect(isDateFormat('YYYY-MM-DD')).toBe(true)
    expect(isDateFormat('M/D/YY')).toBe(true)
    expect(isDateFormat('DD.MM')).toBe(false)
    expect(isDateFormat('DD.MM.YYYY HH:mm')).toBe(false)
    expect(isDateFormat('DD.DD.YYYY')).toBe(false)
    expect(isDateFormat('DD#MM#YYYY')).toBe(false)
    expect(isDateTimeFormat('DD.MM.YYYY HH:mm')).toBe(true)
    expect(isDateTimeFormat('YYYY-MM-DDTHH:mm:ss')).toBe(true)
    expect(isDateTimeFormat('DD.MM.YYYY')).toBe(false)
  })

  it('read German dates and refuse impossible ones', () => {
    expect(readDate('31.01.2026', 'DD.MM.YYYY', false)).toMatchObject({
      year: 2026,
      month: 1,
      day: 31,
    })
    expect(readDate('1.2.26', 'D.M.YY', false)).toMatchObject({ year: 2026, month: 2, day: 1 })
    expect(readDate('1.2.99', 'D.M.YY', false)).toMatchObject({ year: 1999 })
    expect(readDate('29.02.2025', 'DD.MM.YYYY', false)).toBeUndefined()
    expect(readDate('2026-01-31', 'DD.MM.YYYY', false)).toBeUndefined()
    expect(readDate('31.01.2026 25:00', 'DD.MM.YYYY HH:mm', true)).toBeUndefined()
  })

  it('let seconds be missing in date-times', () => {
    expect(readDate('31.01.2026 14:30', 'DD.MM.YYYY HH:mm:ss', true)).toMatchObject({
      hour: 14,
      minute: 30,
      second: 0,
    })
    expect(readDate('31.01.2026 14:30:15', 'DD.MM.YYYY HH:mm:ss', true)).toMatchObject({
      second: 15,
    })
  })

  it('read what they write, for any date and format', () => {
    const formats = ['DD.MM.YYYY HH:mm:ss', 'YYYY-MM-DD HH:mm:ss', 'M/D/YYYY H:mm:ss']
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1000-01-01T00:00:00Z'),
          max: new Date('9999-12-31T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.constantFrom(...formats),
        (date, format) => {
          const wall = {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
            second: date.getUTCSeconds(),
          }
          expect(readDate(formatDate(wall, format), format, true)).toEqual(wall)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('numbers', () => {
  it('read decimal commas and thousands separators between groups of three', () => {
    const format = { decimalSeparator: ',', thousandsSeparator: '.' } as const
    expect(readNumber('1.234,56', format)).toBe('1234.56')
    expect(readNumber('-12,5', format)).toBe('-12.5')
    expect(readNumber('+7', format)).toBe('7')
    expect(readNumber('1234,56', format)).toBe('1234.56')
    expect(readNumber('12.34,5', format)).toBeUndefined()
    expect(readNumber('1,2,3', format)).toBeUndefined()
    expect(readNumber('1.5', { decimalSeparator: '.', thousandsSeparator: '' })).toBe('1.5')
    expect(readNumber('1 234.5', { decimalSeparator: '.', thousandsSeparator: ' ' })).toBe('1234.5')
    expect(readNumber('1\u00a0234', { decimalSeparator: ',', thousandsSeparator: ' ' })).toBe(
      '1234',
    )
    expect(readNumber('abc', format)).toBeUndefined()
    expect(readNumber('', format)).toBeUndefined()
    expect(readNumber('-0', format)).toBe('0')
  })

  it('read numbers formatted by Intl in German and English', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), fc.nat(99), (whole, cents) => {
        const value = whole + Math.sign(whole || 1) * (cents / 100)
        const de = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2 }).format(value)
        const en = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(value)
        const expected = value.toFixed(2)
        expect(readNumber(de, { decimalSeparator: ',', thousandsSeparator: '.' })).toBe(expected)
        expect(readNumber(en, { decimalSeparator: '.', thousandsSeparator: ',' })).toBe(expected)
      }),
      { numRuns: 300 },
    )
  })
})

describe('cells', () => {
  it('read every kind into its JSON form', () => {
    expect(readCell('1.234', 'integer', german)).toEqual({ ok: true, value: 1234 })
    expect(readCell('007', 'integer', german)).toEqual({ ok: true, value: 7 })
    expect(readCell('9.007.199.254.740.993', 'bigint', german)).toEqual({
      ok: true,
      value: '9007199254740993',
    })
    expect(readCell('12,50', 'decimal', german)).toEqual({ ok: true, value: '12.50' })
    expect(readCell('1,5', 'float', german)).toEqual({ ok: true, value: 1.5 })
    expect(readCell('1,5', 'integer', german)).toEqual({ ok: false, code: 'invalid' })
    expect(readCell('Ja', 'boolean', german)).toEqual({ ok: true, value: true })
    expect(readCell('nein', 'boolean', german)).toEqual({ ok: true, value: false })
    expect(readCell('vielleicht', 'boolean', german)).toEqual({ ok: false, code: 'invalid' })
    expect(readCell('31.01.2026', 'date', german)).toEqual({ ok: true, value: '2026-01-31' })
    expect(readCell('  Müller ', 'string', german)).toEqual({ ok: true, value: '  Müller ' })
    expect(readCell(' 14:30 ', 'time', german)).toEqual({ ok: true, value: '14:30' })
    expect(readCell('ROT', 'enum', german, ['rot', 'grün'])).toEqual({ ok: true, value: 'rot' })
    expect(readCell('blau', 'enum', german, ['rot'])).toEqual({ ok: false, code: 'not_in_list' })
    expect(readCell('a, b,a', 'set', german, ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] })
    expect(readCell('{}', 'json', german)).toEqual({ ok: false, code: 'not_importable' })
  })

  it('read wall times in the instance zone and keep instants with an offset', () => {
    // 14:30 in Berlin is 13:30 UTC in winter and 12:30 UTC in summer.
    expect(readCell('31.01.2026 14:30', 'datetime', german)).toEqual({
      ok: true,
      value: '2026-01-31T13:30:00Z',
    })
    expect(readCell('01.07.2026 14:30:00', 'datetime', german)).toEqual({
      ok: true,
      value: '2026-07-01T12:30:00Z',
    })
    expect(readCell('01.07.2026', 'timestamp', german)).toEqual({
      ok: true,
      value: '2026-06-30T22:00:00Z',
    })
    expect(readCell('2026-07-01T12:30:00+02:00', 'datetime', german)).toEqual({
      ok: true,
      value: '2026-07-01T10:30:00Z',
    })
  })

  it('treat the configured values as empty', () => {
    expect(isEmptyCell('', german)).toBe(true)
    expect(isEmptyCell(' - ', german)).toBe(true)
    expect(isEmptyCell('0', german)).toBe(false)
  })
})

describe('suggested formats', () => {
  it('follow the format locale', () => {
    expect(localeFormats('de-DE')).toMatchObject({
      decimalSeparator: ',',
      dateFormat: 'DD.MM.YYYY',
    })
    expect(localeFormats('en-US')).toMatchObject({
      decimalSeparator: '.',
      dateFormat: 'MM/DD/YYYY',
    })
    expect(localeFormats('en-GB')).toMatchObject({ dateFormat: 'DD/MM/YYYY' })
    expect(localeFormats('sv-SE')).toMatchObject({ dateFormat: 'YYYY-MM-DD' })
  })

  it('follow the data where it is unambiguous', () => {
    expect(suggestFormats([['12,50', '3,99']], 'en-US')).toMatchObject({ decimalSeparator: ',' })
    expect(suggestFormats([['1.234,50']], 'en-US')).toMatchObject({
      decimalSeparator: ',',
      thousandsSeparator: '.',
    })
    expect(suggestFormats([['12.50']], 'de-DE')).toMatchObject({ decimalSeparator: '.' })
    expect(suggestFormats([['7']], 'de-DE')).toMatchObject({ decimalSeparator: ',' })
    expect(suggestFormats([['2026-01-31']], 'de-DE')).toMatchObject({ dateFormat: 'YYYY-MM-DD' })
    expect(suggestFormats([['31.01.2026 14:30']], 'en-US')).toMatchObject({
      dateFormat: 'DD.MM.YYYY',
      dateTimeFormat: 'DD.MM.YYYY HH:mm:ss',
    })
    // Both readings fit; the locale decides.
    expect(suggestFormats([['01/02/2026']], 'en-GB')).toMatchObject({ dateFormat: 'DD/MM/YYYY' })
    expect(suggestFormats([['01/02/2026']], 'en-US')).toMatchObject({ dateFormat: 'MM/DD/YYYY' })
    expect(suggestFormats([['13/02/2026']], 'en-US')).toMatchObject({ dateFormat: 'DD/MM/YYYY' })
    // Most values decide; a single impossible date does not.
    expect(suggestFormats([['31.01.1980', '01.02.1990', '29.02.2001']], 'en-US')).toMatchObject({
      dateFormat: 'DD.MM.YYYY',
    })
  })
})
