// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { CatalogColumn, CatalogObject } from '../api/connections.ts'
import type { ValueKind } from './column-kinds.ts'
import { lockStrategy } from './lock.ts'

function table(columns: [string, ValueKind, Partial<CatalogColumn>?][]): CatalogObject {
  return {
    name: 't',
    type: 'table',
    rowEstimate: 1,
    columns: columns.map(([name, kind, extra], index) => ({
      name,
      position: index + 1,
      dataType: kind,
      columnType: kind,
      kind,
      nullable: false,
      defaultValue: null,
      autoIncrement: name === 'id',
      generated: false,
      maxLength: null,
      precision: null,
      scale: null,
      ...extra,
    })),
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: [],
  }
}

const none = new Set<string>()
const auto = { mode: 'auto' } as const

describe('lock strategy (E7)', () => {
  it('detects a version column first, then updated_at', () => {
    const both = table([
      ['id', 'bigint'],
      ['Version', 'integer'],
      ['updated_at', 'timestamp', { onUpdate: 'current_timestamp()' }],
    ])
    expect(lockStrategy(both, none, auto)).toEqual({
      strategy: { kind: 'version', column: 'Version' },
    })
    const stamp = table([
      ['id', 'bigint'],
      ['updated_at', 'datetime', { onUpdate: 'CURRENT_TIMESTAMP' }],
    ])
    expect(lockStrategy(stamp, none, auto)).toEqual({
      strategy: { kind: 'timestamp', column: 'updated_at', setByServer: false },
    })
    const plain = table([
      ['id', 'bigint'],
      ['updated_at', 'datetime'],
    ])
    expect(lockStrategy(plain, none, auto).strategy).toEqual({
      kind: 'timestamp',
      column: 'updated_at',
      setByServer: true,
    })
  })

  it('skips excluded, generated and unsuitable columns', () => {
    const object = table([
      ['id', 'bigint'],
      ['version', 'string'],
      ['updated_at', 'datetime', { generated: true }],
    ])
    expect(lockStrategy(object, none, auto)).toEqual({ strategy: { kind: 'values' } })
    const excluded = table([
      ['id', 'bigint'],
      ['version', 'integer'],
    ])
    expect(lockStrategy(excluded, new Set(['VERSION']), auto)).toEqual({
      strategy: { kind: 'values' },
    })
  })

  it('uses a named column or none, and says why a named one does not fit', () => {
    const object = table([
      ['id', 'bigint'],
      ['rev', 'integer'],
      ['geaendert', 'timestamp'],
      ['name', 'string'],
    ])
    expect(lockStrategy(object, none, { mode: 'column', column: 'rev' })).toEqual({
      strategy: { kind: 'version', column: 'rev' },
    })
    expect(lockStrategy(object, none, { mode: 'column', column: 'geaendert' }).strategy).toEqual({
      kind: 'timestamp',
      column: 'geaendert',
      setByServer: true,
    })
    expect(lockStrategy(object, none, { mode: 'none' })).toEqual({ strategy: { kind: 'values' } })
    for (const [column, problem] of [
      ['name', 'unsuitable_column'],
      ['id', 'unsuitable_column'],
      ['fehlt', 'unknown_column'],
    ] as const) {
      expect(lockStrategy(object, none, { mode: 'column', column })).toEqual({
        strategy: { kind: 'values' },
        problem,
      })
    }
    expect(lockStrategy(object, new Set(['rev']), { mode: 'column', column: 'rev' })).toEqual({
      strategy: { kind: 'values' },
      problem: 'excluded_column',
    })
    expect(lockStrategy({ ...object, type: 'view' }, none, auto)).toEqual({
      strategy: { kind: 'values' },
    })
  })
})
