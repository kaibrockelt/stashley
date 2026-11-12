// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMetastore } from '../../metastore/db.ts'
import { migrateToLatest } from '../../metastore/migrate.ts'
import { tempDir } from '../../test/helpers.ts'
import { Scheduler } from './scheduler.ts'

const silent = { error() {}, warn() {}, info() {} } as never

describe('scheduler', () => {
  it('records successful and failed runs', async () => {
    const store = openMetastore(path.join(tempDir(), 'stashley.db'))
    await migrateToLatest(store, undefined)
    const scheduler = new Scheduler(store.db, silent, () => 42)
    await scheduler.execute({ name: 'ok', intervalMs: 1000, run: async () => {} })
    await scheduler.execute({
      name: 'bad',
      intervalMs: 1000,
      run: () => Promise.reject(new RangeError('x')),
    })
    const rows = await store.db.selectFrom('job_runs').selectAll().orderBy('name').execute()
    expect(rows).toEqual([
      {
        name: 'bad',
        last_started_at: 42,
        last_finished_at: 42,
        last_status: 'failed',
        last_error_code: 'RangeError',
      },
      {
        name: 'ok',
        last_started_at: 42,
        last_finished_at: 42,
        last_status: 'succeeded',
        last_error_code: null,
      },
    ])
    await scheduler.stop()
    await store.close()
  })

  it('runs due jobs on start and stops cleanly', async () => {
    const store = openMetastore(path.join(tempDir(), 'stashley.db'))
    await migrateToLatest(store, undefined)
    const scheduler = new Scheduler(store.db, silent)
    let runs = 0
    const done = new Promise<void>((resolve) => {
      void scheduler.start([
        {
          name: 'due',
          intervalMs: 60_000,
          run: () => {
            runs += 1
            resolve()
            return Promise.resolve()
          },
        },
      ])
    })
    await done
    await scheduler.stop()
    expect(runs).toBe(1)
    await store.close()
  })
})
