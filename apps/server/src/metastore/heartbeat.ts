// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'
import type { Database } from './schema.ts'

export const heartbeatIntervalMs = 5_000
export const heartbeatStaleMs = 15_000

/** Records that a server process is running; CLI commands that need a stopped server check it. */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined
  private readonly db: Kysely<Database>
  private readonly now: () => number

  constructor(db: Kysely<Database>, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  async start(): Promise<void> {
    const at = this.now()
    await this.db
      .insertInto('instance_heartbeat')
      .values({ id: 1, pid: process.pid, started_at: at, heartbeat_at: at })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ pid: process.pid, started_at: at, heartbeat_at: at }),
      )
      .execute()
    this.timer = setInterval(() => {
      void this.beat()
    }, heartbeatIntervalMs)
    this.timer.unref()
  }

  private async beat(): Promise<void> {
    await this.db
      .updateTable('instance_heartbeat')
      .set({ heartbeat_at: this.now() })
      .where('id', '=', 1)
      .execute()
  }

  /** Marks the instance as stopped so maintenance commands can run right away. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.db
      .updateTable('instance_heartbeat')
      .set({ heartbeat_at: 0 })
      .where('id', '=', 1)
      .execute()
  }
}

export async function isServerRunning(
  db: Kysely<Database>,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await db
    .selectFrom('instance_heartbeat')
    .select('heartbeat_at')
    .where('id', '=', 1)
    .executeTakeFirst()
  return row !== undefined && now - row.heartbeat_at < heartbeatStaleMs
}
