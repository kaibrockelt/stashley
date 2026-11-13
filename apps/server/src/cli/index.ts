#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Command, Option } from 'commander'
import { backupDir, createServer } from '../app.ts'
import { ConfigError, loadConfig, type AppConfig } from '../config/env.ts'
import {
  backupFileName,
  backupMetastore,
  restoreMetastore,
  RestoreError,
} from '../metastore/backup.ts'
import { metastorePath, openMetastore } from '../metastore/db.ts'
import { isServerRunning } from '../metastore/heartbeat.ts'
import { knownMigrationNames, migrateToLatest } from '../metastore/migrate.ts'
import { cliActor } from '../modules/audit/audit-log.ts'
import { AppError } from '../platform/http/problem.ts'
import { createKeyRing } from '../platform/crypto/keys.ts'
import { createServices, type Services } from '../services.ts'
import { keyCheckAad, keyCheckPlaintext, KeyMismatchError, verifyKey } from '../app.ts'
import { rotateSecrets } from '../modules/system/rotate-key.ts'

const shutdownGraceMs = 30_000

/** A failed command whose message is meant for the operator. */
class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

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

async function rotateKey(options: { newKeyFile: string; force?: boolean }): Promise<void> {
  const cfg = config()
  const newKey = readFileSync(options.newKeyFile === '-' ? 0 : options.newKeyFile, 'utf8').replace(
    /\r?\n$/,
    '',
  )
  if (Buffer.byteLength(newKey, 'utf8') < 32) {
    throw new CliError('The new key must be at least 32 bytes.')
  }
  if (newKey === cfg.secretKey) throw new CliError('The new key equals the current key.')
  const store = openMetastore(metastorePath(cfg.dataDir))
  try {
    const running = await isServerRunning(store.db).catch(() => false)
    if (running && options.force !== true) {
      throw new CliError('The server is running. Stop it first, or pass --force.')
    }
    await migrateToLatest(store, backupDir(cfg))
    const current = createKeyRing(cfg.secretKey)
    const services = createServices(cfg, store, current, cliLog)
    await verifyKey(services.settings, current)
    const backup = await backupMetastore(store, backupDir(cfg), backupFileName('pre-rotate-key'))
    console.log(`Backup written to ${backup}`)
    const result = await rotateSecrets(store.db, current, createKeyRing(newKey), {
      plaintext: keyCheckPlaintext,
      aad: keyCheckAad,
    })
    await services.audit.record(cliActor, {
      action: 'settings.key_rotated',
      details: { secrets: result.secrets, sessions: result.sessions },
    })
    console.log(`Re-encrypted ${result.secrets} secrets and ended ${result.sessions} sessions.`)
    console.log(
      'Next: set APP_SECRET_KEY (or APP_SECRET_KEY_FILE) to the new key and start the server.',
    )
  } finally {
    await store.close()
  }
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

const cliLog = {
  level: 'warn',
  fatal: console.error,
  error: console.error,
  warn: console.warn,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child() {
    return cliLog
  },
} as unknown as Parameters<typeof createServices>[3]

/** Opens the store, applies migrations and runs `fn` with the application services. */
async function withServices<T>(fn: (services: Services) => Promise<T>): Promise<T> {
  const cfg = config()
  const store = openMetastore(metastorePath(cfg.dataDir))
  try {
    await migrateToLatest(store, backupDir(cfg))
    const keys = createKeyRing(cfg.secretKey)
    const services = createServices(cfg, store, keys, cliLog)
    await verifyKey(services.settings, keys)
    return await fn(services)
  } finally {
    await store.close()
  }
}

function readPassword(file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  return readFileSync(file === '-' ? 0 : file, 'utf8').replace(/\r?\n$/, '')
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

program
  .command('rotate-key')
  .description('Re-encrypt stored secrets with a new APP_SECRET_KEY (server must be stopped)')
  .requiredOption('--new-key-file <file>', 'file with the new key, or - for stdin')
  .option('--force', 'skip the running-server check')
  .action(rotateKey)

const user = program.command('user').description('Manage accounts')

user
  .command('create')
  .description('Create an account')
  .requiredOption('--email <email>', 'email address')
  .requiredOption('--admin', 'create the account with the admin system role')
  .option('--name <name>', 'display name')
  .requiredOption('--password-file <file>', 'file with the password, or - for stdin')
  .action(async (options: { email: string; name?: string; passwordFile: string }) => {
    const password = readPassword(options.passwordFile) ?? ''
    await withServices(async (services) => {
      await services.usersService.createAdmin(cliActor, options.email, password, options.name)
    })
    console.log(`Created admin ${options.email}`)
  })

user
  .command('reset-password')
  .description('Set a new password, or print a reset link when no password file is given')
  .requiredOption('--email <email>', 'email address')
  .option('--password-file <file>', 'file with the new password, or - for stdin')
  .action(async (options: { email: string; passwordFile?: string }) => {
    const result = await withServices((services) =>
      services.usersService.resetPassword(
        cliActor,
        options.email,
        readPassword(options.passwordFile),
      ),
    )
    console.log(result.link === null ? `Password reset for ${options.email}` : result.link)
  })

user
  .command('reset-mfa')
  .description('Turn off two-factor authentication of an account and end its sessions')
  .requiredOption('--email <email>', 'email address')
  .action(async (options: { email: string }) => {
    await withServices((services) => services.usersService.resetMfaByEmail(cliActor, options.email))
    console.log(`Two-factor authentication reset for ${options.email}`)
  })

program
  .command('auth')
  .description('Sign-in settings')
  .command('enable-local')
  .description('Turn password sign-in back on')
  .action(async () => {
    const changed = await withServices((services) =>
      services.instanceSettings.enableLocalLogin(cliActor),
    )
    console.log(changed ? 'Password sign-in enabled' : 'Password sign-in was already enabled')
  })

program.parseAsync().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof RestoreError ||
    error instanceof CliError ||
    error instanceof KeyMismatchError
  ) {
    console.error(error.message)
  } else if (error instanceof AppError) {
    const fields = error.errors?.map((e) => `${e.field}: ${e.code}`).join(', ')
    console.error(
      fields === undefined || fields === '' ? error.message : `${error.message} (${fields})`,
    )
  } else {
    console.error(error)
  }
  process.exit(1)
})
