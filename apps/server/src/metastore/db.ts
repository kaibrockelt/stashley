// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import type { Database } from './schema.ts'

export interface Metastore {
  readonly db: Kysely<Database>
  /** Raw handle, used only for online backups and pragmas. */
  readonly sqlite: SqliteDatabase.Database
  readonly file: string
  close(): Promise<void>
}

export function metastorePath(dataDir: string): string {
  return path.join(dataDir, 'stashley.db')
}

export function openMetastore(file: string): Metastore {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new SqliteDatabase(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  let closed = false
  return {
    db,
    sqlite,
    file,
    async close() {
      if (closed) return
      closed = true
      if (file !== ':memory:') sqlite.pragma('wal_checkpoint(TRUNCATE)')
      await db.destroy()
    },
  }
}

/**
 * Runs a write transaction that takes the write lock up front (`BEGIN IMMEDIATE`), so
 * concurrent writers wait on `busy_timeout` instead of failing on a lock upgrade.
 */
export async function writeTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.connection().execute(async (conn) => {
    await sql`begin immediate`.execute(conn)
    try {
      const result = await fn(conn)
      await sql`commit`.execute(conn)
      return result
    } catch (error) {
      await sql`rollback`.execute(conn)
      throw error
    }
  })
}
