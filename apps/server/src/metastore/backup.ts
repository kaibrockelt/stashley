// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import type { Metastore } from './db.ts'

export function backupFileName(kind: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${kind}-${stamp}.db`
}

/** Consistent online copy through the SQLite backup API; safe while the server runs. */
export async function backupMetastore(
  store: Metastore,
  backupDir: string,
  fileName: string = backupFileName('backup'),
): Promise<string> {
  mkdirSync(backupDir, { recursive: true })
  const target = path.join(backupDir, fileName)
  await store.sqlite.backup(target)
  return target
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestoreError'
  }
}

export interface RestoreCheck {
  migrations: string[]
}

/** Opens a backup read-only and checks its integrity and schema version. */
export function inspectBackup(file: string, knownMigrations: string[]): RestoreCheck {
  if (!existsSync(file) || !statSync(file).isFile()) throw new RestoreError(`${file} not found`)
  let candidate: SqliteDatabase.Database
  try {
    candidate = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
  } catch {
    throw new RestoreError(`${file} is not a SQLite database`)
  }
  try {
    const integrity = candidate.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') throw new RestoreError(`${file} failed the integrity check`)
    const hasTable = candidate
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'kysely_migration'")
      .get()
    if (hasTable === undefined) throw new RestoreError(`${file} is not a Stashley metadata store`)
    const rows = candidate.prepare('select name from kysely_migration order by name').all() as {
      name: string
    }[]
    const names = rows.map((row) => row.name)
    const unknown = names.filter((name) => !knownMigrations.includes(name))
    if (unknown.length > 0) {
      throw new RestoreError(
        `${file} was written by a newer version (unknown migrations: ${unknown.join(', ')})`,
      )
    }
    return { migrations: names }
  } catch (error) {
    if (error instanceof RestoreError) throw error
    throw new RestoreError(`${file} could not be read`)
  } finally {
    candidate.close()
  }
}

/**
 * Replaces the metadata store with a backup. The server must be stopped. The current
 * store is kept as a pre-restore backup first.
 */
export async function restoreMetastore(options: {
  file: string
  storeFile: string
  backupDir: string
  knownMigrations: string[]
}): Promise<{ previous: string | undefined; check: RestoreCheck }> {
  const check = inspectBackup(options.file, options.knownMigrations)
  let previous: string | undefined
  if (existsSync(options.storeFile)) {
    const current = new SqliteDatabase(options.storeFile)
    try {
      mkdirSync(options.backupDir, { recursive: true })
      previous = path.join(options.backupDir, backupFileName('pre-restore'))
      await current.backup(previous)
      current.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      current.close()
    }
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${options.storeFile}${suffix}`, { force: true })
  mkdirSync(path.dirname(options.storeFile), { recursive: true })
  copyFileSync(options.file, options.storeFile)
  return { previous, check }
}

/** Deletes the oldest automatic backups beyond `keep`. */
export function pruneBackups(backupDir: string, prefix: string, keep: number): string[] {
  if (!existsSync(backupDir)) return []
  const files = readdirSync(backupDir)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.db'))
    .sort()
  const remove = files.slice(0, Math.max(0, files.length - keep))
  for (const name of remove) rmSync(path.join(backupDir, name))
  return remove
}
