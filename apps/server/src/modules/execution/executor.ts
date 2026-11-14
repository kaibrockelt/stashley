// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Engine } from '@stashley/shared'
import { performance } from 'node:perf_hooks'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import type { ExecuteResult, TargetPools, TargetSpec, TargetUser } from '../../target/pools.ts'
import type { ConnectionsService } from '../connections/service.ts'
import type { Statement } from '../queries/sql-guard/executable.ts'
import { translateReadError } from './errors.ts'

/** Where reads of a connection go: the read user and the connection's time zone. */
export interface ReadTarget {
  connectionId: string
  spec: TargetSpec
  reader: TargetUser
  engine: Engine
  database: string
  timeZone: string
}

export interface RawResult extends ExecuteResult {
  durationMs: number
  timeZone: string
}

/**
 * Runs reads on the read pool (§10.5): every statement inside `START TRANSACTION READ ONLY`
 * and `COMMIT`, as a prepared statement with bound values. Errors become stable codes.
 */
export class ReadExecutor {
  private readonly connections: ConnectionsService
  private readonly pools: TargetPools
  private readonly targets = new Map<string, Promise<ReadTarget>>()

  constructor(deps: { connections: ConnectionsService; pools: TargetPools; events: EventBus }) {
    this.connections = deps.connections
    this.pools = deps.pools
    deps.events.on('connection.changed', ({ connectionId }) => this.targets.delete(connectionId))
  }

  /** The decrypted read target, held in memory until the connection changes. */
  target(connectionId: string): Promise<ReadTarget> {
    let target = this.targets.get(connectionId)
    if (target === undefined) {
      target = this.connections.resolve(connectionId).then((resolved) => {
        const reader = resolved.users.read
        if (reader === undefined) throw new AppError('target_unavailable')
        return {
          connectionId,
          spec: resolved.spec,
          reader,
          engine: resolved.row.engine ?? 'mysql',
          database: resolved.row.database_name,
          timeZone: resolved.row.timezone,
        }
      })
      target.catch(() => this.targets.delete(connectionId))
      this.targets.set(connectionId, target)
    }
    return target
  }

  async execute(connectionId: string, statement: Statement): Promise<RawResult> {
    const target = await this.target(connectionId)
    const started = performance.now()
    try {
      const result = await this.pools.run(
        connectionId,
        target.spec,
        target.reader,
        async (session) => {
          await session.query('START TRANSACTION READ ONLY')
          const rows = await session.execute(statement.sql, statement.values)
          await session.query('COMMIT')
          return rows
        },
      )
      return { ...result, durationMs: performance.now() - started, timeZone: target.timeZone }
    } catch (error) {
      throw translateReadError(error)
    }
  }
}
