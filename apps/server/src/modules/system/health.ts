// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../metastore/schema.ts'
import { problem, sendProblem } from '../../platform/http/problem.ts'

export interface Readiness {
  ready: boolean
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: Kysely<Database>; readiness: Readiness },
): void {
  app.get('/healthz', { logLevel: 'warn' }, () => ({ status: 'ok' }))

  app.get('/readyz', { logLevel: 'warn' }, async (request, reply) => {
    if (!deps.readiness.ready) return sendProblem(reply, problem('service_unavailable'))
    try {
      await sql`select 1`.execute(deps.db)
      return { status: 'ready' }
    } catch (error) {
      request.log.error({ err: error }, 'metadata store check failed')
      return sendProblem(reply, problem('service_unavailable'))
    }
  })
}
