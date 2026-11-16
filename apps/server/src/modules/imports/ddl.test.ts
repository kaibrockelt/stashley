// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { NewTableColumn, NewTableDefinition } from '@stashley/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../platform/http/problem.ts'
import { createTableStatement } from './ddl.ts'

const column = (name: string, extra: Partial<NewTableColumn> = {}): NewTableColumn => ({
  name,
  source: null,
  type: 'varchar',
  // Only VARCHAR has a length.
  ...((extra.type ?? 'varchar') === 'varchar' && { length: 64 }),
  required: false,
  unique: false,
  default: null,
  ...extra,
})

const base: NewTableDefinition = {
  connectionId: '018f0000-0000-7000-8000-000000000000',
  name: 'mitglieder',
  columns: [],
  primaryKey: { kind: 'added', name: 'id' },
}

describe('CREATE TABLE', () => {
  it('writes every type, key and default from fixed pieces', () => {
    const statement = createTableStatement(
      {
        ...base,
        columns: [
          column('email', { length: 254, required: true, unique: true }),
          column('name', { default: { kind: 'value', value: "O'Brien" } }),
          column('nummer', { type: 'int', default: { kind: 'value', value: '-7' } }),
          column('gross', { type: 'bigint' }),
          column('betrag', {
            type: 'decimal',
            precision: 8,
            scale: 2,
            default: { kind: 'value', value: '0.50' },
          }),
          column('aktiv', {
            type: 'boolean',
            required: true,
            default: { kind: 'value', value: 'true' },
          }),
          column('geboren', { type: 'date', default: { kind: 'value', value: '2000-01-31' } }),
          column('angelegt', { type: 'datetime', default: { kind: 'now' } }),
          column('notiz', { type: 'text' }),
        ],
      },
      { taken: [] },
    )
    expect(statement).toBe(
      [
        'CREATE TABLE `mitglieder` (',
        '  `id` BIGINT NOT NULL AUTO_INCREMENT,',
        '  `email` VARCHAR(254) NOT NULL,',
        "  `name` VARCHAR(64) NULL DEFAULT 'O''Brien',",
        '  `nummer` INT NULL DEFAULT -7,',
        '  `gross` BIGINT NULL,',
        '  `betrag` DECIMAL(8,2) NULL DEFAULT 0.50,',
        '  `aktiv` BOOLEAN NOT NULL DEFAULT 1,',
        "  `geboren` DATE NULL DEFAULT '2000-01-31',",
        '  `angelegt` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,',
        '  `notiz` TEXT NULL,',
        '  PRIMARY KEY (`id`),',
        '  UNIQUE KEY `uq_email` (`email`)',
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
      ].join('\n'),
    )
  })

  it('makes an existing column the primary key, never nullable', () => {
    const statement = createTableStatement(
      {
        ...base,
        primaryKey: { kind: 'column', column: 'email' },
        columns: [column('email', { unique: true }), column('name')],
      },
      { taken: [] },
    )
    expect(statement).toContain('`email` VARCHAR(64) NOT NULL,')
    expect(statement).toContain('PRIMARY KEY (`email`)')
    expect(statement).not.toContain('UNIQUE KEY')
  })

  it('refuses names, types and defaults that could leave their place in the statement', () => {
    const refused = (definition: Partial<NewTableDefinition>) => {
      try {
        createTableStatement(
          { ...base, columns: [column('a')], ...definition },
          { taken: ['person'] },
        )
      } catch (error) {
        expect(error).toBeInstanceOf(AppError)
        return (error as AppError).errors?.map((entry) => entry.code)
      }
      return []
    }
    expect(refused({ name: 'x` (a INT); DROP TABLE person; --' })).toEqual(['invalid_name'])
    expect(refused({ name: 'person' })).toEqual(['taken'])
    expect(refused({ columns: [column('a b')] })).toEqual(['invalid_name'])
    expect(
      refused({
        columns: [
          column('a', { default: { kind: 'value', value: "x\\'; DROP TABLE person; --" } }),
        ],
      }),
    ).toEqual(['invalid'])
    expect(
      refused({
        columns: [
          column('a', { type: 'int', default: { kind: 'value', value: '1); DROP TABLE person' } }),
        ],
      }),
    ).toEqual(['invalid'])
    expect(refused({ columns: [column('a', { length: 0 })] })).toEqual(['invalid'])
    expect(refused({ primaryKey: { kind: 'added', name: 'id`' } })).toEqual(['invalid_name'])
  })

  it('keeps any accepted text default inside one quoted literal', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (text) => {
        let statement: string
        try {
          statement = createTableStatement(
            {
              ...base,
              columns: [column('a', { length: 255, default: { kind: 'value', value: text } })],
            },
            { taken: [] },
          )
        } catch {
          return
        }
        const literal = /DEFAULT '((?:[^']|'')*)',\n/.exec(statement)
        expect(literal?.[1]?.replace(/''/g, "'")).toBe(text)
        expect(text).not.toMatch(/\\/)
      }),
      { numRuns: 2000 },
    )
  })
})
