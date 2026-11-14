// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { checkParamList, checkParamValue, isUserContextParam } from './params.ts'

describe('parameter values', () => {
  it('keep integers exact and canonical', () => {
    expect(checkParamValue('integer', 42)).toEqual({ ok: true, value: 42 })
    expect(checkParamValue('integer', '42')).toEqual({ ok: true, value: 42 })
    expect(checkParamValue('integer', '9007199254740993')).toEqual({
      ok: true,
      value: '9007199254740993',
    })
    expect(checkParamValue('integer', 1.5)).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('integer', '01')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('integer', '1e3')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('integer', true)).toEqual({ ok: false, code: 'invalid' })
  })

  it('keep decimals as strings', () => {
    expect(checkParamValue('decimal', '49.90')).toEqual({ ok: true, value: '49.90' })
    expect(checkParamValue('decimal', 12.5)).toEqual({ ok: true, value: '12.5' })
    expect(checkParamValue('decimal', '1,5')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('decimal', Number.NaN)).toEqual({ ok: false, code: 'invalid' })
  })

  it('accept only real dates and UTC instants', () => {
    expect(checkParamValue('date', '2024-02-29')).toEqual({ ok: true, value: '2024-02-29' })
    expect(checkParamValue('date', '2025-02-29')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('date', '2025-13-01')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('date', '0000-01-01')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('datetime', '2026-05-01T12:30:00+02:00')).toEqual({
      ok: true,
      value: '2026-05-01T10:30:00.000Z',
    })
    expect(checkParamValue('datetime', '2026-05-01T12:30Z')).toEqual({
      ok: true,
      value: '2026-05-01T12:30:00.000Z',
    })
    expect(checkParamValue('datetime', '2026-05-01 12:30:00')).toEqual({
      ok: false,
      code: 'invalid',
    })
    expect(checkParamValue('datetime', '2026-02-30T00:00:00Z')).toEqual({
      ok: false,
      code: 'invalid',
    })
    expect(checkParamValue('datetime', 5)).toEqual({ ok: false, code: 'invalid' })
  })

  it('check strings and booleans', () => {
    expect(checkParamValue('string', 'x')).toEqual({ ok: true, value: 'x' })
    expect(checkParamValue('string', 'x'.repeat(1001))).toEqual({ ok: false, code: 'too_long' })
    expect(checkParamValue('string', 5)).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('boolean', false)).toEqual({ ok: true, value: false })
    expect(checkParamValue('boolean', 'true')).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamValue('date', 20260101)).toEqual({ ok: false, code: 'invalid' })
  })

  it('check lists item by item', () => {
    expect(checkParamList('integer', [1, '2'])).toEqual({ ok: true, values: [1, 2] })
    expect(checkParamList('integer', [1, 'x'])).toEqual({ ok: false, code: 'invalid' })
    expect(checkParamList('integer', 1)).toEqual({ ok: false, code: 'invalid' })
    expect(
      checkParamList(
        'integer',
        Array.from({ length: 1001 }, () => 1),
      ),
    ).toEqual({
      ok: false,
      code: 'too_big',
    })
  })

  it('know the reserved user context', () => {
    expect(isUserContextParam('current_user_id')).toBe(true)
    expect(isUserContextParam('current_event_id')).toBe(false)
  })
})
