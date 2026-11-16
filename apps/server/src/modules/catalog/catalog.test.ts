// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogColumn, CatalogObject } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { defaultTemplate, placeholders } from '../table-access/templates.ts'
import { diffSnapshots, isEmptyDiff } from './diff.ts'
import { impactOf } from './impact.ts'
import { viewTables } from './view-deps.ts'

function col(name: string, overrides: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name,
    position: 1,
    dataType: 'varchar',
    columnType: 'varchar(80)',
    kind: 'string',
    nullable: false,
    defaultValue: null,
    autoIncrement: false,
    generated: false,
    maxLength: 80,
    precision: null,
    scale: null,
    ...overrides,
  }
}

function table(name: string, columns: CatalogColumn[]): CatalogObject {
  return {
    name,
    type: 'table',
    rowEstimate: 0,
    columns,
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: [],
  }
}

const id = col('id', { dataType: 'bigint', columnType: 'bigint(20)', kind: 'bigint' })

describe('schema diff', () => {
  it('lists added, removed and changed objects and columns', () => {
    const before = [table('person', [id, col('vorname'), col('telefon')]), table('alt', [id])]
    const after = [
      table('person', [id, col('vorname', { columnType: 'varchar(120)' }), col('email')]),
      table('neu', [id]),
    ]
    const diff = diffSnapshots(before, after)
    expect(diff.addedObjects).toEqual(['neu'])
    expect(diff.removedObjects).toEqual(['alt'])
    expect(diff.changedObjects).toEqual([
      {
        object: 'person',
        addedColumns: ['email'],
        removedColumns: ['telefon'],
        changedColumns: [{ column: 'vorname', fields: ['columnType'] }],
        keysChanged: false,
      },
    ])
    expect(isEmptyDiff(diffSnapshots(after, after))).toBe(true)
  })

  it('compare foreign key actions only where both snapshots have them', () => {
    const key = {
      name: 'fk',
      columns: ['person_id'],
      targetObject: 'person',
      targetColumns: ['id'],
    }
    const withKey = (rules: object) => ({
      ...table('anmeldung', [id]),
      foreignKeys: [{ ...key, ...rules }],
    })
    const old = withKey({})
    const restrict = withKey({ onDelete: 'restrict', onUpdate: 'restrict' })
    const cascade = withKey({ onDelete: 'cascade', onUpdate: 'restrict' })
    // A snapshot from before the actions were read reports no change.
    expect(isEmptyDiff(diffSnapshots([old], [restrict]))).toBe(true)
    expect(diffSnapshots([restrict], [cascade]).changedObjects).toMatchObject([
      { object: 'anmeldung', keysChanged: true },
    ])
  })

  it('collects affected access, exclusions, templates and relations', () => {
    const diff = diffSnapshots(
      [table('person', [id, col('vorname'), col('telefon')]), table('hotel', [id])],
      [table('person', [id, col('vorname', { nullable: true })])],
    )
    const impact = impactOf(diff, {
      accesses: [
        {
          id: 'a1',
          objectName: 'person',
          keyColumn: 'id',
          displayTemplate: '{vorname}',
          exclusions: ['telefon'],
        },
        { id: 'a2', objectName: 'hotel', keyColumn: 'id', displayTemplate: null, exclusions: [] },
      ],
      relations: [
        {
          id: 'r1',
          sourceObject: 'buchung',
          sourceColumn: 'hotel_id',
          targetObject: 'hotel',
          targetColumn: 'id',
        },
      ],
    })
    expect(impact.map((item) => `${item.kind}:${item.id}:${item.reason}`)).toEqual([
      'column_exclusion:a1:column_removed',
      'table_access:a2:object_removed',
      'display_template:a1:column_changed',
      'relation:r1:object_removed',
    ])
  })

  it('compares ON UPDATE, but not against snapshots taken before it was recorded', () => {
    const older = table('person', [id, col('updated_at')])
    const before = table('person', [id, col('updated_at', { onUpdate: null })])
    const after = table('person', [id, col('updated_at', { onUpdate: 'current_timestamp()' })])
    expect(isEmptyDiff(diffSnapshots([older], [after]))).toBe(true)
    expect(diffSnapshots([before], [after]).changedObjects[0]?.changedColumns).toEqual([
      { column: 'updated_at', fields: ['onUpdate'] },
    ])
  })

  it('reports a table replaced by a view', () => {
    const diff = diffSnapshots(
      [table('zahlung', [id])],
      [{ ...table('zahlung', [id]), type: 'view', primaryKey: [] }],
    )
    const impact = impactOf(diff, {
      accesses: [
        { id: 'a1', objectName: 'zahlung', keyColumn: 'id', displayTemplate: null, exclusions: [] },
      ],
      relations: [],
    })
    expect(impact).toEqual([
      { kind: 'table_access', id: 'a1', label: 'zahlung', reason: 'type_changed' },
    ])
  })
})

describe('display templates', () => {
  it('parses placeholders and picks a default', () => {
    expect(placeholders('{startnummer} – {person.vorname} {person.nachname}')).toEqual([
      { column: 'startnummer' },
      { relation: 'person', column: 'vorname' },
      { relation: 'person', column: 'nachname' },
    ])
    expect(defaultTemplate(table('person', [id, col('vorname')]), 'id')).toBe('{vorname}')
    expect(defaultTemplate(table('zahl', [id]), 'id')).toBe('{id}')
  })
})

describe('view dependencies', () => {
  it('reads tables from a MariaDB view definition', () => {
    const definition =
      'select `wanderverein`.`a`.`id` AS `anmeldung_id`,sum(`z`.`betrag`) AS `bezahlt` from (`wanderverein`.`anmeldung` `a` left join `wanderverein`.`zahlung` `z` on(`z`.`anmeldung_id` = `a`.`id`)) group by `a`.`id`'
    expect(viewTables(definition, 'wanderverein')).toEqual(['anmeldung', 'zahlung'])
    // MariaDB's stored form with nested joins, which the parser rejects.
    const nested =
      'select `a`.`id` AS `anmeldung_id` from ((`wanderverein`.`anmeldung` `a` left join (select `wanderverein`.`hotelbuchung`.`anmeldung_id` AS `anmeldung_id` from `wanderverein`.`hotelbuchung` group by `wanderverein`.`hotelbuchung`.`anmeldung_id`) `h` on(`h`.`anmeldung_id` = `a`.`id`)) left join `wanderverein`.`zahlung` `z` on(`z`.`anmeldung_id` = `a`.`id`))'
    expect(viewTables(nested, 'wanderverein')).toEqual(['anmeldung', 'hotelbuchung', 'zahlung'])
    expect(viewTables('not sql at all (', 'wanderverein')).toEqual([])
  })
})
