// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from './config/env.ts'
import { backupFileName, backupMetastore, pruneBackups } from './metastore/backup.ts'
import { openMetastore, metastorePath, type Metastore } from './metastore/db.ts'
import { Heartbeat } from './metastore/heartbeat.ts'
import { migrateToLatest } from './metastore/migrate.ts'
import { SettingsRepository } from './metastore/settings.ts'
import { registerHealthRoutes, type Readiness } from './modules/system/health.ts'
import {
  createKeyRing,
  decrypt,
  DecryptionError,
  encrypt,
  type KeyRing,
} from './platform/crypto/keys.ts'
import { detectNetworkFilesystem } from './platform/fs-check.ts'
import { createHttpServer } from './platform/http/server.ts'
import { Scheduler, type JobDefinition } from './platform/jobs/scheduler.ts'

const keyCheckPlaintext = 'stashley-key-check'
const keyCheckAad = 'settings:crypto.keyCheck:value'
const day = 24 * 60 * 60 * 1000

export interface Server {
  app: FastifyInstance
  store: Metastore
  keys: KeyRing
  readiness: Readiness
  /** Runs startup steps and starts listening. */
  start(): Promise<void>
  /** Graceful shutdown: refuse new requests, finish running ones, close the store. */
  stop(): Promise<void>
}

export function backupDir(config: Pick<AppConfig, 'dataDir'>): string {
  return path.join(config.dataDir, 'backups')
}

export class KeyMismatchError extends Error {
  constructor() {
    super(
      'APP_SECRET_KEY does not match the key this instance was set up with. ' +
        'Start with the previous key, or rotate keys with `stashley rotate-key`.',
    )
    this.name = 'KeyMismatchError'
  }
}

/** Stores an encrypted known value on first start and verifies it on every later start. */
export async function verifyKey(settings: SettingsRepository, keys: KeyRing): Promise<void> {
  const stored = await settings.get('crypto.keyCheck')
  if (stored === undefined) {
    await settings.set('crypto.keyCheck', encrypt(keys, keyCheckPlaintext, keyCheckAad))
    return
  }
  try {
    if (decrypt(keys, stored, keyCheckAad) === keyCheckPlaintext) return
  } catch (error) {
    if (!(error instanceof DecryptionError)) throw error
  }
  throw new KeyMismatchError()
}

export async function createServer(
  config: AppConfig,
  options: { quiet?: boolean; listen?: boolean } = {},
): Promise<Server> {
  const keys = createKeyRing(config.secretKey)
  const readiness: Readiness = { ready: false }
  const app = await createHttpServer({
    logLevel: config.logLevel,
    trustProxy: config.trustProxy,
    webDir: config.webDir,
    ...(options.quiet !== undefined && { quiet: options.quiet }),
  })
  const store = openMetastore(metastorePath(config.dataDir))
  const settings = new SettingsRepository(store.db)
  const heartbeat = new Heartbeat(store.db)
  const scheduler = new Scheduler(store.db, app.log)

  registerHealthRoutes(app, { db: store.db, readiness })

  const jobs: JobDefinition[] = [
    {
      name: 'backup.automatic',
      intervalMs: day,
      async run() {
        const setting = await settings.get('backup.automatic')
        if (!setting.enabled) return
        const file = await backupMetastore(store, backupDir(config), backupFileName('auto'))
        pruneBackups(backupDir(config), 'auto', setting.retentionDays)
        app.log.info({ file: path.basename(file) }, 'automatic backup written')
      },
    },
  ]

  let stopping: Promise<void> | undefined

  return {
    app,
    store,
    keys,
    readiness,
    async start() {
      const network = await detectNetworkFilesystem(config.dataDir)
      if (network !== undefined) {
        app.log.warn({ filesystem: network }, 'data directory is on a network filesystem')
      }
      const outcome = await migrateToLatest(store, backupDir(config))
      if (outcome.applied.length > 0) {
        app.log.info(
          {
            migrations: outcome.applied,
            backup: outcome.backupFile && path.basename(outcome.backupFile),
          },
          'metadata store migrated',
        )
      }
      await verifyKey(settings, keys)
      await heartbeat.start()
      await scheduler.start(jobs)
      if (options.listen !== false) await app.listen({ host: '0.0.0.0', port: config.port })
      else await app.ready()
      readiness.ready = true
    },
    stop() {
      stopping ??= (async () => {
        readiness.ready = false
        await app.close()
        await scheduler.stop()
        await heartbeat.stop().catch(() => undefined)
        await store.close()
      })()
      return stopping
    },
  }
}
