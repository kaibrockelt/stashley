// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CatalogColumn } from '../api/connections.ts'
import { valueKind } from './column-kinds.ts'
import {
  buildRowSchema,
  checkField,
  checkRow,
  columnRequired,
  fieldSpec,
  type FieldSpec,
} from './row-schema.ts'

function column(
  name: string,
  columnType: string,
  extra: Partial<CatalogColumn> = {},
): CatalogColumn {
  const dataType = /^[a-z]+/.exec(columnType)?.[0] ?? columnType
  const length = /^(?:var)?char\((\d+)\)/.exec(columnType)
  const numeric = /^decimal\((\d+),(\d+)\)/.exec(columnType)
  return {
    name,
    position: 1,
    dataType,
    columnType,
    kind: valueKind(dataType, columnType),
    nullable: true,
    defaultValue: null,
    autoIncrement: false,
    generated: false,
    maxLength: length ? Number(length[1]) : null,
    precision: numeric ? Number(numeric[1]) : null,
    scale: numeric ? Number(numeric[2]) : null,
    ...extra,
  }
}

const spec = (columnType: string, extra: Partial<CatalogColumn> = {}) =>
  fieldSpec(column('f', columnType, extra))
const check = (columnType: string, value: unknown, extra: Partial<CatalogColumn> = {}) =>
  checkField(spec(columnType, extra), value)

describe('field values (§9.5)', () => {
  it('check integers against the column range', () => {
    expect(check('int', 42)).toEqual({ ok: true, value: 42 })
    expect(check('int', '42')).toEqual({ ok: true, value: 42 })
    expect(check('tinyint(4)', 128)).toMatchObject({ ok: false, code: 'out_of_range' })
    expect(check('tinyint unsigned', 255)).toEqual({ ok: true, value: 255 })
    expect(check('int unsigned', -1)).toMatchObject({
      ok: false,
      code: 'out_of_range',
      params: { min: '0', max: '4294967295' },
    })
    expect(check('int', 1.5)).toEqual({ ok: false, code: 'invalid' })
    expect(check('int', '01')).toEqual({ ok: false, code: 'invalid' })
    expect(check('bigint', '9223372036854775807')).toEqual({
      ok: true,
      value: '9223372036854775807',
    })
    expect(check('bigint', 12)).toEqual({ ok: true, value: '12' })
    expect(check('bigint', '9223372036854775808')).toMatchObject({ code: 'out_of_range' })
    expect(check('bigint unsigned', '18446744073709551615')).toMatchObject({ ok: true })
  })

  it('check decimals against precision and scale', () => {
    expect(check('decimal(8,2)', '49.90')).toEqual({ ok: true, value: '49.9' })
    expect(check('decimal(8,2)', 49.9)).toEqual({ ok: true, value: '49.9' })
    expect(check('decimal(8,2)', '007.50')).toEqual({ ok: true, value: '7.5' })
    expect(check('decimal(8,2)', '-0.00')).toEqual({ ok: true, value: '0' })
    expect(check('decimal(8,2)', '123456.78')).toEqual({ ok: true, value: '123456.78' })
    expect(check('decimal(8,2)', '1234567.8')).toMatchObject({
      code: 'out_of_range',
      params: { min: '-999999.99', max: '999999.99' },
    })
    expect(check('decimal(8,2)', '1.234')).toEqual({
      ok: false,
      code: 'too_many_decimals',
      params: { max: 2 },
    })
    expect(check('decimal(8,2)', '1,5')).toEqual({ ok: false, code: 'invalid' })
    expect(check('decimal(8,2)', 1e21)).toEqual({ ok: false, code: 'invalid' })
    expect(check('decimal(8,2) unsigned', '-1')).toMatchObject({ code: 'out_of_range' })
  })

  it('check dates, times and years', () => {
    expect(check('date', '2024-02-29')).toEqual({ ok: true, value: '2024-02-29' })
    expect(check('date', '2025-02-29')).toEqual({ ok: false, code: 'invalid' })
    expect(check('date', '0999-12-31')).toEqual({ ok: false, code: 'invalid' })
    expect(check('datetime', '2026-07-04T14:30:00+02:00')).toEqual({
      ok: true,
      value: '2026-07-04T12:30:00Z',
    })
    expect(check('datetime', '2026-07-04T14:30:00.250Z')).toEqual({
      ok: true,
      value: '2026-07-04T14:30:00.250Z',
    })
    expect(check('datetime', '2026-07-04 14:30:00')).toEqual({ ok: false, code: 'invalid' })
    expect(check('datetime', '9999-12-31T23:30:00-01:00')).toMatchObject({ code: 'out_of_range' })
    expect(check('timestamp', '2038-01-19T03:14:07Z')).toMatchObject({ ok: true })
    expect(check('timestamp', '2038-01-19T03:14:08Z')).toMatchObject({ code: 'out_of_range' })
    expect(check('timestamp', '1970-01-01T00:00:00Z')).toMatchObject({ code: 'out_of_range' })
    expect(check('time', '9:05')).toEqual({ ok: true, value: '09:05:00' })
    expect(check('time', '-838:59:59')).toEqual({ ok: true, value: '-838:59:59' })
    expect(check('time', '838:30:00')).toEqual({ ok: true, value: '838:30:00' })
    expect(check('time', '839:00:00')).toMatchObject({ code: 'out_of_range' })
    expect(check('time', '12:60')).toEqual({ ok: false, code: 'invalid' })
    expect(check('year', 2026)).toEqual({ ok: true, value: 2026 })
    expect(check('year', 1900)).toMatchObject({ code: 'out_of_range' })
  })

  it('check text length in characters, enums and sets', () => {
    expect(check('varchar(3)', 'abc')).toEqual({ ok: true, value: 'abc' })
    expect(check('varchar(3)', '😀😀😀')).toEqual({ ok: true, value: '😀😀😀' })
    expect(check('varchar(3)', 'abcd')).toEqual({ ok: false, code: 'too_long', params: { max: 3 } })
    expect(check('varchar(3)', 3)).toEqual({ ok: false, code: 'invalid' })
    const status = { enumValues: ['angemeldet', 'storniert'] }
    expect(check("enum('angemeldet','storniert')", 'storniert', status)).toMatchObject({ ok: true })
    expect(check("enum('angemeldet','storniert')", 'bezahlt', status)).toEqual({
      ok: false,
      code: 'not_allowed',
    })
    const days = { enumValues: ['mo', 'di', 'mi'] }
    expect(check("set('mo','di','mi')", ['mi', 'mo', 'mi'], days)).toEqual({
      ok: true,
      value: ['mo', 'mi'],
    })
    expect(check("set('mo','di','mi')", ['so'], days)).toEqual({ ok: false, code: 'not_allowed' })
    expect(check('tinyint(1)', true)).toEqual({ ok: true, value: true })
    expect(check('tinyint(1)', 1)).toEqual({ ok: false, code: 'invalid' })
    expect(check('json', '{}')).toEqual({ ok: false, code: 'field_not_writable' })
  })

  it('handle null and required fields', () => {
    expect(check('varchar(10)', null)).toEqual({ ok: true, value: null })
    expect(check('varchar(10)', null, { nullable: false })).toEqual({ ok: false, code: 'required' })
    expect(check('varchar(10)', '', { nullable: false })).toEqual({ ok: false, code: 'required' })
    // Optional text may be empty; NOT NULL with a default is not required.
    expect(check('varchar(10)', '', { nullable: false, defaultValue: 'x' })).toEqual({
      ok: true,
      value: '',
    })
    expect(columnRequired(column('id', 'bigint', { nullable: false, autoIncrement: true }))).toBe(
      false,
    )
    expect(columnRequired(column('g', 'int', { nullable: false, generated: true }))).toBe(false)
    expect(columnRequired(column('n', 'int', { nullable: false }))).toBe(true)
    expect(fieldSpec(column('n', 'int'), { required: true }).required).toBe(true)
  })

  it('keep canonical values unchanged (idempotent)', () => {
    const specs: [string, fc.Arbitrary<unknown>][] = [
      ['int', fc.integer({ min: -2147483648, max: 2147483647 })],
      ['bigint', fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map(String)],
      [
        'decimal(10,3)',
        fc
          .tuple(fc.integer({ min: -9999999, max: 9999999 }), fc.integer({ min: 0, max: 999 }))
          .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(3, '0')}`),
      ],
      [
        'date',
        fc
          .date({ min: new Date('1000-01-01'), max: new Date('9999-12-31'), noInvalidDate: true })
          .map((d) => d.toISOString().slice(0, 10)),
      ],
      [
        'datetime',
        fc
          .date({ min: new Date('1000-01-01'), max: new Date('9999-12-31'), noInvalidDate: true })
          .map((d) => d.toISOString()),
      ],
    ]
    for (const [type, values] of specs) {
      fc.assert(
        fc.property(values, (value) => {
          const first = check(type, value)
          expect(first.ok, `${type} ${String(value)}`).toBe(true)
          if (first.ok) expect(check(type, first.value)).toEqual(first)
        }),
      )
    }
  })
})

describe('row schema (§11 step 2)', () => {
  const fields: FieldSpec[] = [
    fieldSpec(column('anmeldung_id', 'bigint', { nullable: false })),
    fieldSpec(column('betrag', 'decimal(8,2)', { nullable: false })),
    fieldSpec(column('kommentar', 'varchar(200)')),
  ]

  it('requires required fields on create and accepts partial updates', () => {
    expect(checkRow(fields, 'create', { anmeldung_id: 7, betrag: '49.90' })).toEqual({
      ok: true,
      values: { anmeldung_id: '7', betrag: '49.9' },
    })
    expect(checkRow(fields, 'create', { betrag: '49.90' })).toEqual({
      ok: false,
      errors: [{ field: 'anmeldung_id', code: 'required' }],
    })
    expect(checkRow(fields, 'update', { kommentar: null })).toEqual({
      ok: true,
      values: { kommentar: null },
    })
    expect(checkRow(fields, 'update', { betrag: null })).toEqual({
      ok: false,
      errors: [{ field: 'betrag', code: 'required' }],
    })
  })

  it('rejects fields that are not writable and payloads that are not objects', () => {
    expect(checkRow(fields, 'update', { id: 1, eingang_am: 'x', kommentar: 'ok' })).toEqual({
      ok: false,
      errors: [
        { field: 'id', code: 'field_not_writable' },
        { field: 'eingang_am', code: 'field_not_writable' },
      ],
    })
    expect(checkRow(fields, 'create', [])).toEqual({
      ok: false,
      errors: [{ field: '_', code: 'invalid' }],
    })
    // Inherited keys do not count as fields.
    expect(checkRow(fields, 'update', Object.create({ kommentar: 'x' }))).toEqual({
      ok: true,
      values: {},
    })
  })

  it('reports the same errors as a Zod schema', () => {
    const schema = buildRowSchema(fields, 'create')
    expect(schema.parse({ anmeldung_id: '3', betrag: 1 })).toEqual({
      anmeldung_id: '3',
      betrag: '1',
    })
    const result = schema.safeParse({ betrag: '1.234', extra: true })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['extra', 'field_not_writable'],
      ['anmeldung_id', 'required'],
      ['betrag', 'too_many_decimals'],
    ])
  })
})
