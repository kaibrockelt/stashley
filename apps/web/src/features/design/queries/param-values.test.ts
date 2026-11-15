// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { parameterNames, syncDefinitions, testValue } from './param-values.ts'

describe('query parameters in the editor', () => {
  it('finds named parameters outside strings and comments', () => {
    expect(
      parameterNames(
        'SELECT \':no\', `:no`, "x:no" FROM t -- :no\nWHERE a = :station AND b IN (:ids) /* :no */ AND c = :station AND d::int # :no',
      ),
    ).toEqual(['station', 'ids'])
  })

  it('keeps used definitions and adds new ones', () => {
    const kept = {
      name: 'a',
      type: 'integer' as const,
      list: true,
      required: true,
      defaultValue: null,
    }
    expect(syncDefinitions([kept], ['b', 'a'])).toEqual([
      { name: 'b', type: 'string', list: false, required: false, defaultValue: null },
      kept,
    ])
  })

  it('types test values', () => {
    const base = { name: 'x', list: false, required: false, defaultValue: null }
    expect(testValue({ ...base, type: 'integer' }, ' 12 ')).toBe(12)
    expect(testValue({ ...base, type: 'integer' }, '1.5')).toBe('1.5')
    expect(testValue({ ...base, type: 'decimal' }, '49,90')).toBe('49.90')
    expect(testValue({ ...base, type: 'boolean' }, 'true')).toBe(true)
    expect(testValue({ ...base, type: 'datetime' }, '2026-06-13T14:30:00Z')).toBe(
      '2026-06-13T14:30:00.000Z',
    )
    expect(testValue({ ...base, type: 'string' }, '')).toBeUndefined()
    expect(testValue({ ...base, type: 'integer', list: true }, '1, 2,x')).toEqual([1, 2, 'x'])
  })
})
