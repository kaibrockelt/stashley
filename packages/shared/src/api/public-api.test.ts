// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { aliasExposesName, apiOperationsFor, apiResourcePattern } from './public-api.ts'

describe('API operations', () => {
  it('follow the ceiling of a table', () => {
    expect(
      apiOperationsFor({ objectType: 'table', keyColumn: 'id', ceiling: ['read', 'create'] }),
    ).toEqual(['list', 'get', 'count', 'schema', 'create'])
    expect(
      apiOperationsFor({
        objectType: 'table',
        keyColumn: 'id',
        ceiling: ['read', 'create', 'update', 'delete'],
      }),
    ).toEqual(['list', 'get', 'count', 'schema', 'create', 'update', 'replace', 'upsert', 'delete'])
    // Upsert needs create and update.
    expect(
      apiOperationsFor({ objectType: 'table', keyColumn: 'id', ceiling: ['read', 'update'] }),
    ).toEqual(['list', 'get', 'count', 'schema', 'update', 'replace'])
  })

  it('need a single-column key on tables and never write views', () => {
    expect(apiOperationsFor({ objectType: 'table', keyColumn: null, ceiling: ['read'] })).toEqual(
      [],
    )
    expect(apiOperationsFor({ objectType: 'view', keyColumn: null, ceiling: ['read'] })).toEqual([
      'list',
      'count',
      'schema',
    ])
    expect(
      apiOperationsFor({ objectType: 'view', keyColumn: 'id', ceiling: ['read', 'create'] }),
    ).toEqual(['list', 'get', 'count', 'schema'])
  })

  it('accept only aliases that differ from the object name', () => {
    expect(aliasExposesName('zahlung', 'zahlung')).toBe(true)
    expect(aliasExposesName('Zahlung', 'zahlung')).toBe(true)
    expect(aliasExposesName('payments', 'zahlung')).toBe(false)
    expect(apiResourcePattern.test('payments')).toBe(true)
    expect(apiResourcePattern.test('hotel-bookings')).toBe(true)
    expect(apiResourcePattern.test('Payments')).toBe(false)
    expect(apiResourcePattern.test('1payments')).toBe(false)
    expect(apiResourcePattern.test('a/b')).toBe(false)
  })
})
