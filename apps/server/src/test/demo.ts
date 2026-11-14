// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, TableAccess, TableOp, ValueKind } from '@stashley/shared'
import { expect } from 'vitest'
import { column, storeConnection } from './connections.ts'
import type { TestSetup } from './setup.ts'

/**
 * The demo schema (`wanderverein`) as the catalog records it, for route tests that need no
 * target database. Integration tests read the real one.
 */
function col(name: string, kind: ValueKind, position: number, nullable = true) {
  return { ...column(name, kind, position), nullable: name === 'id' ? false : nullable }
}

function demoTable(
  name: string,
  columns: [string, ValueKind][],
  foreignKeys: [string, string][] = [],
): CatalogObject {
  return {
    name,
    type: 'table',
    rowEstimate: 100,
    columns: [
      col('id', 'bigint', 1, false),
      ...columns.map(([columnName, kind], index) => col(columnName, kind, index + 2)),
    ],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: foreignKeys.map(([source, target]) => ({
      name: `${name}_${source}_fk`,
      columns: [source],
      targetObject: target,
      targetColumns: ['id'],
    })),
  }
}

function demoView(
  name: string,
  columns: [string, ValueKind][],
  baseTables: string[],
): CatalogObject {
  return {
    name,
    type: 'view',
    rowEstimate: null,
    columns: columns.map(([columnName, kind], index) => col(columnName, kind, index + 1)),
    primaryKey: [],
    uniqueKeys: [],
    foreignKeys: [],
    baseTables,
    keyCandidates: [],
    dependenciesKnown: true,
  }
}

export const demoObjects: CatalogObject[] = [
  demoTable('person', [
    ['vorname', 'string'],
    ['nachname', 'string'],
    ['email', 'string'],
    ['land', 'string'],
    ['telefon', 'string'],
  ]),
  demoTable('event', [
    ['jahr', 'integer'],
    ['name', 'string'],
    ['datum', 'date'],
  ]),
  demoTable(
    'anmeldung',
    [
      ['person_id', 'bigint'],
      ['event_id', 'bigint'],
      ['status', 'enum'],
      ['startnummer', 'integer'],
      ['betrag_soll', 'decimal'],
      ['angemeldet_am', 'datetime'],
    ],
    [
      ['person_id', 'person'],
      ['event_id', 'event'],
    ],
  ),
  demoTable('hotel', [
    ['name', 'string'],
    ['ort', 'string'],
    ['kontakt_email', 'string'],
  ]),
  demoTable(
    'hotel_kontingent',
    [
      ['event_id', 'bigint'],
      ['hotel_id', 'bigint'],
      ['zimmerart', 'string'],
    ],
    [
      ['event_id', 'event'],
      ['hotel_id', 'hotel'],
    ],
  ),
  demoTable(
    'hotelbuchung',
    [
      ['anmeldung_id', 'bigint'],
      ['hotel_kontingent_id', 'bigint'],
      ['anreise', 'date'],
      ['eingecheckt_am', 'datetime'],
    ],
    [
      ['anmeldung_id', 'anmeldung'],
      ['hotel_kontingent_id', 'hotel_kontingent'],
    ],
  ),
  demoTable(
    'zahlung',
    [
      ['anmeldung_id', 'bigint'],
      ['betrag', 'decimal'],
      ['eingang_am', 'date'],
    ],
    [['anmeldung_id', 'anmeldung']],
  ),
  demoTable('ehrung', [['person_id', 'bigint']], [['person_id', 'person']]),
  demoView(
    'v_zahlungsstatus',
    [
      ['anmeldung_id', 'bigint'],
      ['event_id', 'bigint'],
      ['offen', 'decimal'],
      ['status', 'string'],
    ],
    ['anmeldung', 'hotelbuchung', 'zahlung'],
  ),
]

export const demoCeilings: Record<string, TableOp[]> = {
  person: ['read', 'create', 'update'],
  event: ['read', 'create', 'update'],
  anmeldung: ['read', 'create', 'update'],
  hotel: ['read', 'create', 'update'],
  hotel_kontingent: ['read', 'create', 'update'],
  hotelbuchung: ['read', 'create', 'update', 'delete'],
  zahlung: ['read', 'create', 'update'],
  ehrung: ['create'],
  v_zahlungsstatus: ['read'],
}

export interface Demo {
  connectionId: string
  access: Map<string, TableAccess>
}

/**
 * A stored connection with the demo catalog, every demo object exposed with its ceiling and
 * `hotel.kontakt_email` excluded for everyone.
 */
export async function setupDemo(s: TestSetup): Promise<Demo> {
  const connectionId = await storeConnection(s.server, undefined, { objects: demoObjects })
  const access = new Map<string, TableAccess>()
  for (const object of demoObjects) {
    const created = await s.admin.send('POST', '/internal/admin/table-access', {
      connectionId,
      objectName: object.name,
      ops: demoCeilings[object.name],
      keyColumn: object.type === 'view' ? 'anmeldung_id' : null,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: object.name === 'hotel' ? [{ column: 'kontakt_email', scope: 'all' }] : [],
    })
    expect(created.statusCode, object.name).toBe(201)
    access.set(object.name, created.json<TableAccess>())
  }
  return { connectionId, access }
}
