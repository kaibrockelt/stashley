// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogColumn, CatalogObject, ValueKind } from '@stashley/shared'
import type { Server } from '../app.ts'
import { buildGrantReport } from '../modules/connections/grants.ts'
import { encrypt } from '../platform/crypto/keys.ts'

export const storedConnectionId = '01890000-0000-7000-8000-0000000000c1'

export interface StoredTarget {
  host: string
  port: number
  tls: Record<string, unknown>
}

/**
 * A saved connection with read and write user, written straight to the metadata store, so
 * route tests need no target database. With `objects`, a schema snapshot is stored too.
 */
export async function storeConnection(
  server: Server,
  target: StoredTarget = {
    host: '192.0.2.10',
    port: 3306,
    tls: { mode: 'verify-full', caPem: null, serverName: null },
  },
  options: { objects?: CatalogObject[] } = {},
): Promise<string> {
  const connectionId = storedConnectionId
  const now = Date.now()
  const db = server.store.db
  await db
    .insertInto('connections')
    .values({
      id: connectionId,
      name: 'Saved',
      host: target.host,
      port: target.port,
      database_name: 'wanderverein',
      engine: 'mariadb',
      server_version: '12.3.3',
      tls: JSON.stringify(target.tls),
      timezone: 'Europe/Berlin',
      query_timeout_ms: 10_000,
      created_at: now,
      updated_at: now,
    })
    .execute()
  const grants = {
    read: ['GRANT SELECT, SHOW VIEW ON `wanderverein`.* TO `stashley_read`@`%`'],
    write: ['GRANT SELECT, INSERT, UPDATE, DELETE ON `wanderverein`.* TO `stashley_write`@`%`'],
  }
  for (const [purpose, credentialId] of [
    ['read', '01890000-0000-7000-8000-0000000000d1'],
    ['write', '01890000-0000-7000-8000-0000000000d2'],
  ] as const) {
    const report = buildGrantReport({ purpose, database: 'wanderverein', lines: grants[purpose] })
    await db
      .insertInto('connection_credentials')
      .values({
        id: credentialId,
        connection_id: connectionId,
        purpose,
        username: `stashley_${purpose}`,
        password: encrypt(
          server.keys,
          `${purpose} secret`,
          `connection_credentials:${credentialId}:password`,
        ),
        grant_report: JSON.stringify(report),
        checked_at: now,
      })
      .execute()
  }
  if (options.objects !== undefined) await storeSnapshot(server, options.objects, now)
  return connectionId
}

/** Stores a schema snapshot as the stored connection's current catalog. */
export async function storeSnapshot(
  server: Server,
  objects: CatalogObject[],
  capturedAt = Date.now(),
): Promise<void> {
  await server.store.db
    .insertInto('schema_snapshots')
    .values({
      id: `01890000-0000-7000-8000-${String(capturedAt).padStart(12, '0').slice(-12)}`,
      connection_id: storedConnectionId,
      captured_at: capturedAt,
      content_hash: String(capturedAt),
      content: JSON.stringify(objects),
      trigger: 'manual',
    })
    .execute()
}

/** A catalog column with the defaults of a plain nullable column. */
export function column(name: string, kind: ValueKind, position = 1): CatalogColumn {
  return {
    name,
    position,
    dataType: kind === 'string' ? 'varchar' : kind,
    columnType: kind === 'string' ? 'varchar(80)' : kind,
    kind,
    nullable: name !== 'id',
    defaultValue: null,
    autoIncrement: name === 'id',
    generated: false,
    onUpdate: null,
    maxLength: kind === 'string' ? 80 : null,
    precision: null,
    scale: null,
  }
}

/** A table with a single-column primary key `id`. */
export function table(
  name: string,
  columns: CatalogColumn[],
  foreignKeys: CatalogObject['foreignKeys'] = [],
): CatalogObject {
  return {
    name,
    type: 'table',
    rowEstimate: 0,
    columns: [column('id', 'bigint'), ...columns],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys,
  }
}
