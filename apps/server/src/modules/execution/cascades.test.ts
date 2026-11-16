// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogForeignKey, CatalogObject } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { affectedObjects } from './cascades.ts'

function table(name: string, foreignKeys: CatalogForeignKey[] = []): CatalogObject {
  return {
    name,
    type: 'table',
    rowEstimate: 0,
    columns: [],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys,
  }
}

const fk = (
  target: string,
  column: string,
  rules: Pick<CatalogForeignKey, 'onDelete' | 'onUpdate'>,
  targetColumn = 'id',
): CatalogForeignKey => ({
  name: `${column}_fk`,
  columns: [column],
  targetObject: target,
  targetColumns: [targetColumn],
  ...rules,
})

const catalog = new Map(
  [
    table('person'),
    table('anmeldung', [
      fk('person', 'person_id', { onDelete: 'cascade', onUpdate: 'cascade' }),
      fk('person', 'email', { onDelete: 'set_null', onUpdate: 'cascade' }, 'email'),
    ]),
    table('zahlung', [fk('anmeldung', 'anmeldung_id', { onDelete: 'cascade' })]),
    table('ehrung', [fk('person', 'person_id', { onDelete: 'restrict', onUpdate: 'restrict' })]),
    table('alt', [fk('person', 'person_id', {})]),
  ].map((entry) => [entry.name, entry]),
)

describe('tables changed by foreign key actions (N6)', () => {
  it('follow delete cascades and count unknown actions, but not restricting ones', () => {
    expect(affectedObjects(catalog, 'person', 'delete', []).sort()).toEqual([
      'alt',
      'anmeldung',
      'person',
      'zahlung',
    ])
  })

  it('follow update actions only for changed referenced columns', () => {
    expect(affectedObjects(catalog, 'person', 'update', ['nachname']).sort()).toEqual(['person'])
    expect(affectedObjects(catalog, 'person', 'update', ['EMAIL']).sort()).toEqual([
      'anmeldung',
      'person',
    ])
  })

  it('leave inserts to the written table', () => {
    expect(affectedObjects(catalog, 'person', null, ['id'])).toEqual(['person'])
  })
})
