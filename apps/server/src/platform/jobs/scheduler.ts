// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../../metastore/schema.ts'

export interface JobDefinition {
  name: string
  intervalMs: number
  run: () => Promise<void>
}

/**
 * In-process scheduler. The last run of each job is persisted in `job_runs`, so long
 * intervals (daily backup, schema drift) survive restarts.
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Set<Promise<void>>()
  private stopped = false
  private readonly db: Kysely<Database>
  private readonly log: FastifyBaseLogger
  private readonly now: () => number

  constructor(db: Kysely<Database>, log: FastifyBaseLogger, now: () => number = Date.now) {
    this.db = db
    this.log = log
    this.now = now
  }

  async start(jobs: JobDefinition[]): Promise<void> {
    for (const job of jobs) {
      const row = await this.db
        .selectFrom('job_runs')
        .select('last_started_at')
        .where('name', '=', job.name)
        .executeTakeFirst()
      const last = row?.last_started_at ?? null
      const delay = last === null ? 0 : Math.max(0, last + job.intervalMs - this.now())
      this.schedule(job, delay)
    }
  }

  private schedule(job: JobDefinition, delay: number): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      const execution = this.execute(job).finally(() => {
        this.running.delete(execution)
        this.schedule(job, job.intervalMs)
      })
      this.running.add(execution)
    }, delay)
    timer.unref()
    this.timers.set(job.name, timer)
  }

  async execute(job: JobDefinition): Promise<void> {
    const startedAt = this.now()
    await this.record(job.name, { last_started_at: startedAt })
    try {
      await job.run()
      await this.record(job.name, {
        last_finished_at: this.now(),
        last_status: 'succeeded',
        last_error_code: null,
      })
    } catch (error) {
      const code = error instanceof Error ? error.name : 'Error'
      this.log.error({ job: job.name, err: error }, 'job failed')
      await this.record(job.name, {
        last_finished_at: this.now(),
        last_status: 'failed',
        last_error_code: code,
      })
    }
  }

  private async record(
    name: string,
    values: Partial<Omit<Database['job_runs'], 'name'>>,
  ): Promise<void> {
    await this.db
      .insertInto('job_runs')
      .values({
        name,
        last_started_at: null,
        last_finished_at: null,
        last_status: null,
        last_error_code: null,
        ...values,
      })
      .onConflict((oc) => oc.column('name').doUpdateSet(values))
      .execute()
  }

  /** Cancels pending runs and waits for running jobs to finish. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([...this.running])
  }
}
