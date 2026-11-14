// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { FieldInfo } from '../../target/pools.ts'
import { fieldKind, inferRole, normalizeResult, resultColumns } from './results.ts'

const field = (name: string, columnType: number, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  columnType,
  flags: 0,
  characterSet: 224,
  columnLength: 11,
  ...extra,
})

describe('result normalization', () => {
  it('derives value kinds from protocol types', () => {
    const cases: [FieldInfo, string][] = [
      [field('b', 1, { columnLength: 1 }), 'boolean'],
      [field('t', 1, { columnLength: 4 }), 'integer'],
      [field('s', 2), 'integer'],
      [field('i', 3), 'integer'],
      [field('m', 9), 'integer'],
      [field('l', 8), 'bigint'],
      [field('y', 13), 'year'],
      [field('d', 246), 'decimal'],
      [field('d0', 0), 'decimal'],
      [field('f', 4), 'float'],
      [field('g', 5), 'float'],
      [field('date', 10), 'date'],
      [field('nd', 14), 'date'],
      [field('dt', 12), 'datetime'],
      [field('ts', 7), 'timestamp'],
      [field('time', 11), 'time'],
      [field('j', 245), 'json'],
      [field('n', 6), 'string'],
      [field('e', 247), 'enum'],
      [field('st', 248), 'set'],
      [field('v', 253), 'string'],
      [field('c', 254, { flags: 256 }), 'enum'],
      [field('c2', 254, { flags: 2048 }), 'set'],
      [field('blob', 252, { characterSet: 63 }), 'unsupported'],
      [field('text', 252), 'string'],
      [field('vs', 15), 'string'],
      [field('bit', 16), 'unsupported'],
      [field('geo', 255), 'unsupported'],
    ]
    for (const [input, kind] of cases) expect(fieldKind(input), input.name).toBe(kind)
  })

  it('infers column roles', () => {
    expect(inferRole('id', 'bigint', false)).toBe('identifier')
    expect(inferRole('person_id', 'integer', false)).toBe('identifier')
    expect(inferRole('nummer', 'integer', true)).toBe('identifier')
    expect(inferRole('betrag', 'decimal', false)).toBe('measure')
    expect(inferRole('eingang_am', 'date', false)).toBe('time')
    expect(inferRole('status', 'enum', false)).toBe('category')
  })

  it('keeps duplicate column names apart', () => {
    expect(resultColumns([field('id', 8), field('id', 8, { flags: 1 })])).toEqual([
      { name: 'id', type: 'BIGINT', kind: 'bigint', nullable: true, role: 'identifier' },
      { name: 'id_2', type: 'BIGINT', kind: 'bigint', nullable: false, role: 'identifier' },
    ])
    expect(resultColumns([field('x', 99)])[0]?.type).toBe('UNKNOWN')
  })

  it('encodes values, drops binary data, flags invalid dates and marks truncation', () => {
    const fields = [
      field('id', 8),
      field('am', 12),
      field('data', 252, { characterSet: 63 }),
      field('d', 10),
    ]
    const result = normalizeResult(
      [
        ['1', '2026-05-01 10:00:00', Buffer.from('x'), '2026-05-01'],
        ['2', '0000-00-00 00:00:00', null, '2025-02-30'],
        ['3', null, null, null],
      ],
      fields,
      2,
      'Europe/Berlin',
    )
    expect(result.rows).toEqual([
      { id: '1', am: '2026-05-01T08:00:00Z', data: null, d: '2026-05-01' },
      { id: '2', am: null, data: null, d: null },
    ])
    expect(result.truncated).toBe(true)
    expect(result.invalidRows).toEqual([1])
    expect(result.size).toBeGreaterThan(0)
    expect(normalizeResult([], fields, 2, 'UTC')).toMatchObject({ rows: [], truncated: false })
  })
})
