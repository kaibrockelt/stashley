// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { NewTableColumn, NewTableDefinition } from '../api/imports.ts'
import { checkNewDefault, checkNewTable, newTableCatalog } from './new-table.ts'

const column = (name: string, extra: Partial<NewTableColumn> = {}): NewTableColumn => ({
  name,
  source: null,
  type: 'varchar',
  length: 64,
  required: false,
  unique: false,
  default: null,
  ...extra,
})

const definition = (extra: Partial<NewTableDefinition> = {}): NewTableDefinition => ({
  connectionId: '018f0000-0000-7000-8000-000000000000',
  name: 'mitglieder',
  columns: [column('vorname'), column('email', { unique: true, required: true })],
  primaryKey: { kind: 'added', name: 'id' },
  ...extra,
})

describe('new table checks', () => {
  it('accept a plain definition', () => {
    expect(checkNewTable(definition(), { taken: ['person'] })).toEqual([])
  })

  it('refuse unsafe, reserved, duplicate and taken names', () => {
    expect(
      checkNewTable(
        definition({
          name: 'person',
          columns: [
            column('vorname'),
            column('VORNAME'),
            column('order'),
            column('x-y'),
            column('id'),
          ],
        }),
        { taken: ['person'] },
      ),
    ).toEqual([
      { field: 'name', code: 'taken' },
      { field: 'columns.1.name', code: 'invalid_name' },
      { field: 'columns.2.name', code: 'invalid_name' },
      { field: 'columns.3.name', code: 'invalid_name' },
      { field: 'columns.4.name', code: 'duplicate' },
    ])
    expect(checkNewTable(definition({ name: 'a`b' }), { taken: [] })).toEqual([
      { field: 'name', code: 'invalid_name' },
    ])
    expect(
      checkNewTable(definition({ primaryKey: { kind: 'added', name: 'select' } }), { taken: [] }),
    ).toEqual([{ field: 'primaryKey.name', code: 'invalid_name' }])
  })

  it('refuse keys that cannot be indexed and rows that are too large', () => {
    expect(
      checkNewTable(
        definition({
          columns: [
            column('notiz', { type: 'text', length: undefined, unique: true }),
            column('lang', { length: 1000, unique: true }),
            column('code', { length: 768, unique: true }),
          ],
        }),
        { taken: [] },
      ),
    ).toEqual([
      { field: 'columns.0.type', code: 'not_indexable' },
      { field: 'columns.1.length', code: 'too_long_for_key', params: { max: 768 } },
    ])
    const wide = Array.from({ length: 20 }, (_, index) =>
      column(`spalte_${index}`, { length: 1000 }),
    )
    expect(checkNewTable(definition({ columns: wide }), { taken: [] })).toEqual([
      { field: 'columns', code: 'row_too_large' },
    ])
  })

  it('check the primary key column and CSV sources', () => {
    expect(
      checkNewTable(
        definition({
          primaryKey: { kind: 'column', column: 'nummer' },
          columns: [
            column('email', { source: 0 }),
            column('name', { source: 0 }),
            column('x', { source: 7 }),
          ],
        }),
        { taken: [], sourceCount: 3 },
      ),
    ).toEqual([
      { field: 'columns.1.source', code: 'duplicate' },
      { field: 'columns.2.source', code: 'invalid' },
      { field: 'primaryKey.column', code: 'unknown_column' },
    ])
  })

  it('check defaults by type and keep quotes and backslashes out', () => {
    const check = (extra: Partial<NewTableColumn>) => checkNewDefault(column('c', extra))
    expect(check({ type: 'int', default: { kind: 'value', value: '42' } })).toBeUndefined()
    expect(check({ type: 'int', default: { kind: 'value', value: '2147483648' } })).toBe(
      'out_of_range',
    )
    expect(check({ type: 'int', default: { kind: 'value', value: '1 OR 1' } })).toBe('invalid')
    expect(
      check({
        type: 'decimal',
        precision: 5,
        scale: 2,
        default: { kind: 'value', value: '123.45' },
      }),
    ).toBeUndefined()
    expect(
      check({
        type: 'decimal',
        precision: 5,
        scale: 2,
        default: { kind: 'value', value: '1234.5' },
      }),
    ).toBe('out_of_range')
    expect(check({ type: 'boolean', default: { kind: 'value', value: 'true' } })).toBeUndefined()
    expect(check({ type: 'date', default: { kind: 'value', value: '2026-02-30' } })).toBe('invalid')
    expect(
      check({ type: 'datetime', default: { kind: 'value', value: '2026-05-09 14:30:00' } }),
    ).toBeUndefined()
    expect(check({ type: 'datetime', default: { kind: 'now' } })).toBeUndefined()
    expect(check({ type: 'date', default: { kind: 'now' } })).toBe('not_supported')
    expect(check({ default: { kind: 'value', value: "O'Brien" } })).toBeUndefined()
    expect(check({ default: { kind: 'value', value: 'a\\b' } })).toBe('invalid')
    expect(check({ default: { kind: 'value', value: 'a\nb' } })).toBe('invalid')
    // C1 controls are control characters as well.
    expect(check({ default: { kind: 'value', value: 'a\u0085b' } })).toBe('invalid')
    expect(check({ default: { kind: 'value', value: 'Straße ü' } })).toBeUndefined()
    expect(check({ length: 3, default: { kind: 'value', value: 'abcd' } })).toBe('too_long')
    expect(check({ type: 'text', default: { kind: 'value', value: 'x' } })).toBe('not_supported')
  })

  it('describe the table as the catalog will', () => {
    const columns = newTableCatalog(
      definition({
        columns: [
          column('aktiv', { type: 'boolean', default: { kind: 'value', value: 'true' } }),
          column('betrag', { type: 'decimal', precision: 8, scale: 2, required: true }),
        ],
      }),
    )
    expect(
      columns.map((entry) => [entry.name, entry.kind, entry.nullable, entry.autoIncrement]),
    ).toEqual([
      ['id', 'bigint', false, true],
      ['aktiv', 'boolean', true, false],
      ['betrag', 'decimal', false, false],
    ])
    expect(columns[1]?.defaultValue).toBe('1')
  })
})
