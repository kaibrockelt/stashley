// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../test/helpers.ts'
import {
  backupMetastore,
  inspectBackup,
  pruneBackups,
  restoreMetastore,
  RestoreError,
} from './backup.ts'
import { openMetastore, writeTransaction } from './db.ts'
import { Heartbeat, isServerRunning } from './heartbeat.ts'
import { knownMigrationNames, migrateToLatest, pendingMigrations } from './migrate.ts'
import { SettingsRepository } from './settings.ts'

async function freshStore(dir = tempDir()) {
  const store = openMetastore(path.join(dir, 'stashley.db'))
  await migrateToLatest(store, path.join(dir, 'backups'))
  return store
}

describe('migrations', () => {
  it('applies all migrations to an empty store without a backup', async () => {
    const dir = tempDir()
    const store = openMetastore(path.join(dir, 'stashley.db'))
    const outcome = await migrateToLatest(store, path.join(dir, 'backups'))
    expect(outcome.applied).toEqual(knownMigrationNames())
    expect(outcome.backupFile).toBeUndefined()
    expect(await pendingMigrations(store)).toEqual([])
    expect(store.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(store.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    await store.close()
  })

  it('is a no-op when up to date', async () => {
    const store = await freshStore()
    expect(await migrateToLatest(store, undefined)).toEqual({ applied: [], backupFile: undefined })
    await store.close()
  })
})

describe('settings', () => {
  it('returns defaults and stores validated values', async () => {
    const store = await freshStore()
    const settings = new SettingsRepository(store.db)
    expect(await settings.get('backup.automatic')).toEqual({ enabled: false, retentionDays: 14 })
    await settings.set('backup.automatic', { enabled: true, retentionDays: 7 }, 'user-1')
    expect(await settings.get('backup.automatic')).toEqual({ enabled: true, retentionDays: 7 })
    await expect(
      settings.set('backup.automatic', { enabled: true, retentionDays: 0 }),
    ).rejects.toThrow()
    await store.close()
  })
})

describe('write transactions', () => {
  it('commits on success and rolls back on failure', async () => {
    const store = await freshStore()
    const settings = () => store.db.selectFrom('settings').selectAll().execute()
    await writeTransaction(store.db, (trx) =>
      trx
        .insertInto('settings')
        .values({ key: 'a', value: '1', updated_at: 1, updated_by: null })
        .execute(),
    )
    await expect(
      writeTransaction(store.db, async (trx) => {
        await trx
          .insertInto('settings')
          .values({ key: 'b', value: '1', updated_at: 1, updated_by: null })
          .execute()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await settings()).map((row) => row.key)).toEqual(['a'])
    await store.close()
  })
})

describe('heartbeat', () => {
  it('reports a running server until stopped or stale', async () => {
    const store = await freshStore()
    let now = 1_000_000
    const heartbeat = new Heartbeat(store.db, () => now)
    expect(await isServerRunning(store.db, now)).toBe(false)
    await heartbeat.start()
    expect(await isServerRunning(store.db, now + 1_000)).toBe(true)
    expect(await isServerRunning(store.db, now + 60_000)).toBe(false)
    now += 1_000
    await heartbeat.stop()
    expect(await isServerRunning(store.db, now)).toBe(false)
    await store.close()
  })
})

describe('backup and restore', () => {
  it('backs up online and restores, keeping the previous store', async () => {
    const dir = tempDir()
    const store = await freshStore(dir)
    const settings = new SettingsRepository(store.db)
    await settings.set('backup.automatic', { enabled: true, retentionDays: 3 })
    const file = await backupMetastore(store, path.join(dir, 'backups'), 'manual.db')
    await settings.set('backup.automatic', { enabled: false, retentionDays: 9 })
    await store.close()

    const result = await restoreMetastore({
      file,
      storeFile: store.file,
      backupDir: path.join(dir, 'backups'),
      knownMigrations: knownMigrationNames(),
    })
    expect(result.previous).toBeDefined()
    expect(existsSync(result.previous ?? '')).toBe(true)

    const reopened = openMetastore(store.file)
    expect(await new SettingsRepository(reopened.db).get('backup.automatic')).toEqual({
      enabled: true,
      retentionDays: 3,
    })
    await reopened.close()
  })

  it('rejects files that are not Stashley stores or come from newer versions', async () => {
    const dir = tempDir()
    const junk = path.join(dir, 'junk.db')
    writeFileSync(junk, 'not a database')
    expect(() => inspectBackup(junk, knownMigrationNames())).toThrow(RestoreError)
    expect(() => inspectBackup(path.join(dir, 'missing.db'), [])).toThrow('not found')

    const store = await freshStore(dir)
    const file = await backupMetastore(store, path.join(dir, 'backups'), 'b.db')
    await store.close()
    expect(() => inspectBackup(file, [])).toThrow('newer version')
    expect(inspectBackup(file, knownMigrationNames()).migrations).toEqual(knownMigrationNames())
  })

  it('prunes old automatic backups', () => {
    const dir = tempDir()
    for (const day of ['01', '02', '03', '04'])
      writeFileSync(path.join(dir, `auto-2026-11-${day}.db`), '')
    writeFileSync(path.join(dir, 'manual.db'), '')
    expect(pruneBackups(dir, 'auto', 2)).toEqual(['auto-2026-11-01.db', 'auto-2026-11-02.db'])
    expect(readdirSync(dir).sort()).toEqual([
      'auto-2026-11-03.db',
      'auto-2026-11-04.db',
      'manual.db',
    ])
  })
})
