// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogColumn, CatalogObject, LockStrategy, ValueKind } from '@stashley/shared'
import { toMask } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import type { ConnectionFacts, ObjectFacts } from './facts.ts'
import { buildResourceModel } from './resource.ts'

function col(name: string, kind: ValueKind, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name,
    position: 1,
    dataType: kind,
    columnType: kind === 'string' ? 'varchar(80)' : kind === 'decimal' ? 'decimal(8,2)' : kind,
    kind,
    nullable: true,
    defaultValue: null,
    autoIncrement: false,
    generated: false,
    onUpdate: null,
    maxLength: kind === 'string' ? 80 : null,
    precision: kind === 'decimal' ? 8 : null,
    scale: kind === 'decimal' ? 2 : null,
    ...extra,
  }
}

const zahlung: CatalogObject = {
  name: 'zahlung',
  type: 'table',
  rowEstimate: 0,
  columns: [
    col('id', 'bigint', { nullable: false, autoIncrement: true }),
    col('anmeldung_id', 'bigint', { nullable: false }),
    col('betrag', 'decimal', { nullable: false }),
    col('beleg', 'string'),
    col('intern', 'string'),
    col('summe', 'decimal', { generated: true }),
    col('daten', 'json'),
    col('bild', 'unsupported'),
    col('version', 'integer', { nullable: false, defaultValue: '1' }),
  ],
  primaryKey: ['id'],
  uniqueKeys: [['beleg'], ['anmeldung_id', 'betrag']],
  foreignKeys: [],
}
const person: CatalogObject = {
  name: 'person',
  type: 'table',
  rowEstimate: 0,
  columns: [
    col('email', 'string', { nullable: false }),
    col('name', 'string'),
    col('geheim', 'string', { nullable: false }),
  ],
  primaryKey: ['email'],
  uniqueKeys: [],
  foreignKeys: [],
}
const medaille: CatalogObject = {
  name: 'v_medaille',
  type: 'view',
  rowEstimate: 0,
  columns: [col('person', 'string'), col('anzahl', 'integer')],
  primaryKey: [],
  uniqueKeys: [],
  foreignKeys: [],
}

function facts(overrides: Record<string, Partial<ObjectFacts>> = {}): ConnectionFacts {
  const objects = [zahlung, person, medaille]
  const version: LockStrategy = { kind: 'version', column: 'version' }
  const access = new Map<string, ObjectFacts>(
    objects.map((object) => [
      object.name,
      {
        tableAccessId: `${object.name}-id`,
        objectName: object.name,
        objectType: object.type,
        apiResource: `${object.name}s`,
        ceiling: toMask(object.type === 'view' ? ['read'] : ['read', 'create', 'update', 'delete']),
        dbGrants: toMask(['read', 'create', 'update', 'delete']),
        excluded: new Set(
          object.name === 'zahlung' ? ['intern'] : object.name === 'person' ? ['geheim'] : [],
        ),
        mcpExcluded: new Set(),
        mcpEnabled: false,
        active: true,
        keyColumn: object.primaryKey[0] ?? null,
        effectiveTemplate: '{id}',
        writable: { create: null, update: null },
        lock: object.name === 'zahlung' ? version : { kind: 'values' },
        ...overrides[object.name],
      },
    ]),
  )
  return {
    connectionId: 'c',
    engine: 'mariadb',
    database: 'wanderverein',
    timeZone: 'Europe/Berlin',
    catalog: new Map(objects.map((object) => [object.name, object])),
    relations: [],
    objects: access,
    access: (name) => access.get(name),
  }
}

function model(object: string, overrides: Record<string, Partial<ObjectFacts>> = {}) {
  const connection = facts(overrides)
  return buildResourceModel(connection, connection.access(object) as ObjectFacts, `${object}s`)
}

describe('resource models', () => {
  it('read every column not excluded, and write only what clients may write (E16)', () => {
    const resource = model('zahlung')
    expect(resource?.columns.map((column) => column.name)).toEqual([
      'id',
      'anmeldung_id',
      'betrag',
      'beleg',
      'summe',
      'daten',
      'version',
    ])
    const writable = (op: 'insertable' | 'updatable') =>
      resource?.columns.filter((column) => column[op]).map((column) => column.name)
    // Not the auto-increment key, the generated column, JSON or the lock column.
    expect(writable('insertable')).toEqual(['anmeldung_id', 'betrag', 'beleg'])
    expect(writable('updatable')).toEqual(['anmeldung_id', 'betrag', 'beleg'])
    expect(resource?.read.columns.map((column) => column.id)).toContain('summe')
    expect(resource?.write?.payload.create.map((spec) => spec.column)).toEqual([
      'anmeldung_id',
      'betrag',
      'beleg',
    ])
    expect(resource?.write?.row).toBe(resource?.read)
    expect(resource?.available).toEqual([
      'list',
      'get',
      'count',
      'schema',
      'create',
      'update',
      'replace',
      'upsert',
      'delete',
    ])
    // A single-column unique key, never the auto-increment key (E18).
    expect(resource?.upsertColumns).toEqual(['beleg'])
  })

  it('write the key of tables without auto-increment and upsert on it', () => {
    const resource = model('person')
    expect(resource?.columns.map((column) => column.name)).toEqual(['email', 'name'])
    expect(resource?.columns.find((column) => column.name === 'email')).toMatchObject({
      insertable: true,
      updatable: false,
    })
    expect(resource?.upsertColumns).toEqual(['email'])
  })

  it('withhold create when an excluded column is required, and keep updating', () => {
    const resource = model('person', {})
    // `geheim` is NOT NULL without default and excluded: no row can be created (E16).
    expect(resource?.available).toEqual([
      'list',
      'get',
      'count',
      'schema',
      'update',
      'replace',
      'delete',
    ])
  })

  it('follow column grants and database grants', () => {
    const resource = model('zahlung', {
      zahlung: {
        writable: {
          create: new Set(['anmeldung_id', 'betrag', 'beleg', 'version']),
          update: new Set(['beleg']),
        },
        dbGrants: toMask(['read', 'create', 'update']),
      },
    })
    expect(resource?.columns.filter((column) => column.updatable).map((c) => c.name)).toEqual([
      'beleg',
    ])
    // Updates increment `version`, which the column grants leave out.
    expect(resource?.available).toEqual(['list', 'get', 'count', 'schema', 'create'])
  })

  it('read views, with position paging where they have no key', () => {
    const resource = model('v_medaille')
    expect(resource).toMatchObject({ keyless: true, keyColumn: 'person', write: null })
    expect(resource?.available).toEqual(['list', 'count', 'schema'])
    expect(model('v_medaille', { v_medaille: { keyColumn: 'person' } })?.available).toEqual([
      'list',
      'get',
      'count',
      'schema',
    ])
  })

  it('serve nothing for inactive or unreadable objects', () => {
    expect(model('zahlung', { zahlung: { active: false } })).toBeUndefined()
    expect(model('zahlung', { zahlung: { ceiling: toMask(['create']) } })).toBeUndefined()
  })
})
