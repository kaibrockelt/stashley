// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderField } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import {
  buildPayload,
  fromInput,
  initialValues,
  inputToInstant,
  instantToInput,
  parseNumber,
  toInput,
} from './values.ts'

function field(
  column: string,
  kind: RenderField['kind'],
  extra: Partial<RenderField> = {},
): RenderField {
  return {
    id: column,
    column,
    label: null,
    help: null,
    input: 'input',
    widget: 'text',
    kind,
    columnType: kind === 'decimal' ? 'decimal(8,2)' : kind === 'string' ? 'varchar(20)' : kind,
    required: false,
    nullable: true,
    maxLength: kind === 'string' ? 20 : null,
    precision: kind === 'decimal' ? 8 : null,
    scale: kind === 'decimal' ? 2 : null,
    hidden: false,
    create: true,
    update: true,
    ...extra,
  }
}

const german = { locale: 'de-DE', timeZone: 'Europe/Berlin' }
const us = { locale: 'en-US', timeZone: 'Europe/Berlin' }

describe('form values', () => {
  it('read numbers in the user format', () => {
    expect(parseNumber('49,90', 'de-DE')).toBe('49.90')
    expect(parseNumber('1.234,5', 'de-DE')).toBe('1234.5')
    expect(parseNumber('-3', 'de-DE')).toBe('-3')
    expect(parseNumber(',5', 'de-DE')).toBe('0.5')
    expect(parseNumber('49.90', 'en-US')).toBe('49.90')
    expect(parseNumber('1,234.5', 'en-US')).toBe('1234.5')
    for (const bad of ['', '12,34,5', '1.23,4', 'abc', '1,2.3', '1.2', '-']) {
      expect(parseNumber(bad, 'de-DE'), bad).toBeUndefined()
    }
    expect(toInput(field('betrag', 'decimal'), '49.9', german)).toBe('49,9')
    expect(fromInput(field('betrag', 'decimal'), '49,9', german)).toEqual({
      ok: true,
      value: '49.9',
    })
    expect(fromInput(field('anzahl', 'integer'), '12', us)).toEqual({ ok: true, value: 12 })
  })

  it('show date-times as wall times of the instance time zone', () => {
    expect(instantToInput('2026-05-08T16:45:00Z', 'Europe/Berlin')).toBe('2026-05-08T18:45')
    expect(inputToInstant('2026-05-08T18:45', 'Europe/Berlin')).toBe('2026-05-08T16:45:00Z')
    expect(inputToInstant('2026-01-08T18:45', 'Europe/Berlin')).toBe('2026-01-08T17:45:00Z')
    expect(inputToInstant('18:45', 'Europe/Berlin')).toBeUndefined()
    expect(fromInput(field('zeit', 'datetime'), '2026-05-08T18:45', german)).toEqual({
      ok: true,
      value: '2026-05-08T16:45:00Z',
    })
  })

  it('prefill defaults, page filters, URL values and date suggestions', () => {
    const fields = [
      field('station', 'bigint', { default: { kind: 'filter', filterId: 'station' } }),
      field('nr', 'integer', { default: { kind: 'url', name: 'nr' } }),
      field('land', 'string', { default: { kind: 'value', value: 'DE' } }),
      field('eingang', 'date', {
        input: 'generated',
        generator: { kind: 'date', expression: 'today', editable: true },
      }),
      field('aktiv', 'boolean'),
    ]
    expect(
      initialValues(
        fields,
        { filters: { station: '3' }, params: { nr: 17 }, now: Date.parse('2026-05-09T22:30:00Z') },
        german,
      ),
    ).toEqual({ station: '3', nr: '17', land: 'DE', eingang: '2026-05-10', aktiv: false })
  })

  it('build payloads with the shared row schema', () => {
    const fields = [
      field('betrag', 'decimal', { required: true, nullable: false }),
      field('kommentar', 'string'),
      field('nur_neu', 'string', { update: false }),
    ]
    expect(buildPayload(fields, { betrag: '49,90', kommentar: '' }, 'create', german)).toEqual({
      values: { betrag: '49.9' },
      errors: [],
    })
    expect(buildPayload(fields, { betrag: '', kommentar: 'x' }, 'create', german).errors).toEqual([
      { field: 'betrag', code: 'required' },
    ])
    expect(
      buildPayload(fields, { betrag: '1,234', kommentar: '' }, 'create', german).errors,
    ).toEqual([{ field: 'betrag', code: 'too_many_decimals', params: { max: 2 } }])
    expect(buildPayload(fields, { betrag: 'zehn' }, 'create', german).errors).toEqual([
      { field: 'betrag', code: 'invalid' },
    ])
    // Updates send what changed, and never fields only a new record may set.
    expect(
      buildPayload(fields, { betrag: '50,00', kommentar: 'neu', nur_neu: 'x' }, 'update', german, {
        betrag: '50,00',
        kommentar: '',
        nur_neu: '',
      }),
    ).toEqual({ values: { kommentar: 'neu' }, errors: [] })
    expect(
      buildPayload(fields, { betrag: '50,00', kommentar: '' }, 'update', german, {
        betrag: '50,00',
        kommentar: 'alt',
      }).values,
    ).toEqual({ kommentar: null })
  })
})
