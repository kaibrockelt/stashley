// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { enumValues, valueKind } from './column-kinds.ts'

describe('valueKind', () => {
  it('maps column types to value kinds', () => {
    expect(valueKind('tinyint', 'tinyint(1)')).toBe('boolean')
    expect(valueKind('tinyint', 'tinyint(4)')).toBe('integer')
    expect(valueKind('TINYINT', 'tinyint unsigned')).toBe('integer')
    expect(valueKind('bigint', 'bigint(20) unsigned')).toBe('bigint')
    expect(valueKind('decimal', 'decimal(10,2)')).toBe('decimal')
    expect(valueKind('datetime', 'datetime(3)')).toBe('datetime')
    expect(valueKind('varchar', 'varchar(80)')).toBe('string')
    expect(valueKind('set', "set('a','b')")).toBe('set')
    expect(valueKind('blob', 'blob')).toBe('unsupported')
    expect(valueKind('geometry', 'geometry')).toBe('unsupported')
  })

  it('reads enum and set values', () => {
    expect(enumValues("enum('offen','bezahlt','storniert')")).toEqual([
      'offen',
      'bezahlt',
      'storniert',
    ])
    expect(enumValues("set('it''s','a,b')")).toEqual(["it's", 'a,b'])
    expect(enumValues('varchar(10)')).toEqual([])
  })
})
