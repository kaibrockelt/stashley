// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Migrator } from 'kysely/migration'
import { backupMetastore, backupFileName } from './backup.ts'
import type { Metastore } from './db.ts'
import { migrations } from './migrations/index.ts'

export function createMigrator(store: Metastore): Migrator {
  return new Migrator({
    db: store.db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  })
}

export interface MigrationOutcome {
  applied: string[]
  backupFile: string | undefined
}

export async function pendingMigrations(store: Metastore): Promise<string[]> {
  const list = await createMigrator(store).getMigrations()
  return list.filter((m) => m.executedAt === undefined).map((m) => m.name)
}

/**
 * Applies pending migrations. When the store already holds applied migrations, an online
 * backup is written to `backupDir` first, so a failed upgrade can be restored.
 */
export async function migrateToLatest(
  store: Metastore,
  backupDir: string | undefined,
): Promise<MigrationOutcome> {
  const migrator = createMigrator(store)
  const list = await migrator.getMigrations()
  const pending = list.filter((m) => m.executedAt === undefined)
  if (pending.length === 0) return { applied: [], backupFile: undefined }

  const applied = list.filter((m) => m.executedAt !== undefined)
  let backupFile: string | undefined
  if (applied.length > 0 && backupDir !== undefined) {
    const from = applied.at(-1)?.name ?? 'empty'
    const to = pending.at(-1)?.name ?? 'latest'
    backupFile = await backupMetastore(
      store,
      backupDir,
      backupFileName(`pre-migration-${from}-${to}`),
    )
  }

  const { error, results } = await migrator.migrateToLatest()
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown'
    throw new Error(`Migration ${failed} failed`, { cause: error })
  }
  return {
    applied: (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName),
    backupFile,
  }
}

export function knownMigrationNames(): string[] {
  return Object.keys(migrations).sort()
}
