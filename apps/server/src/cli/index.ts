#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path'
import { Command, Option } from 'commander'
import { backupDir, createServer } from '../app.ts'
import { ConfigError, loadConfig, type AppConfig } from '../config/env.ts'
import { backupMetastore, restoreMetastore, RestoreError } from '../metastore/backup.ts'
import { metastorePath, openMetastore } from '../metastore/db.ts'
import { isServerRunning } from '../metastore/heartbeat.ts'
import { knownMigrationNames, migrateToLatest } from '../metastore/migrate.ts'

const shutdownGraceMs = 30_000

function config(): AppConfig {
  return loadConfig()
}

async function serve(): Promise<void> {
  const server = await createServer(config())
  const shutdown = (signal: string) => {
    server.app.log.info({ signal }, 'shutting down')
    const force = setTimeout(() => {
      server.app.log.error('shutdown grace period exceeded')
      process.exit(1)
    }, shutdownGraceMs)
    force.unref()
    server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        server.app.log.error({ err: error }, 'shutdown failed')
        process.exit(1)
      },
    )
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
  try {
    await server.start()
  } catch (error) {
    server.app.log.fatal({ err: error }, 'startup failed')
    await server.stop().catch(() => undefined)
    process.exit(1)
  }
}

async function backup(options: { output?: string }): Promise<void> {
  const cfg = config()
  const store = openMetastore(metastorePath(cfg.dataDir))
  try {
    const target = options.output
    const file =
      target === undefined
        ? await backupMetastore(store, backupDir(cfg))
        : await backupMetastore(store, path.dirname(path.resolve(target)), path.basename(target))
    console.log(file)
  } finally {
    await store.close()
  }
}

async function restore(file: string, options: { force?: boolean }): Promise<void> {
  const cfg = config()
  const storeFile = metastorePath(cfg.dataDir)
  const store = openMetastore(storeFile)
  try {
    const running = await isServerRunning(store.db).catch(() => false)
    if (running && options.force !== true) {
      throw new RestoreError('The server is running. Stop it first, or pass --force.')
    }
  } finally {
    await store.close()
  }
  const result = await restoreMetastore({
    file: path.resolve(file),
    storeFile,
    backupDir: backupDir(cfg),
    knownMigrations: knownMigrationNames(),
  })
  if (result.previous !== undefined) console.log(`Previous store saved to ${result.previous}`)
  console.log(`Restored ${file}`)
}

async function migrate(): Promise<void> {
  const cfg = config()
  const store = openMetastore(metastorePath(cfg.dataDir))
  try {
    const outcome = await migrateToLatest(store, backupDir(cfg))
    console.log(
      outcome.applied.length === 0 ? 'Up to date' : `Applied ${outcome.applied.join(', ')}`,
    )
  } finally {
    await store.close()
  }
}

const program = new Command('stashley')
  .description('Dashboards, forms and table views on MariaDB and MySQL databases')
  .showHelpAfterError()

program.command('serve', { isDefault: true }).description('Start the server').action(serve)

program
  .command('backup')
  .description('Write a consistent backup of the metadata store')
  .addOption(new Option('-o, --output <file>', 'backup file (default: /data/backups)'))
  .action(backup)

program
  .command('restore')
  .description('Replace the metadata store with a backup (server must be stopped)')
  .argument('<file>', 'backup file')
  .option('--force', 'skip the running-server check')
  .action(restore)

program.command('migrate').description('Apply pending metadata store migrations').action(migrate)

program.parseAsync().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof RestoreError) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exit(1)
})
