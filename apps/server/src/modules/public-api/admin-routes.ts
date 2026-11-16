// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { apiEndpointsUpdate, apiTokenCreate, apiTokenUpdate } from '@stashley/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse } from '../../platform/http/validation.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import type { ApiEndpoints } from './endpoints.ts'
import type { ApiTokens } from './tokens.ts'

export interface ApiAdminRouteDeps {
  endpoints: ApiEndpoints
  tokens: ApiTokens
}

const tableAccessParams = z.object({ tableAccessId: z.uuid() })
const idParams = z.object({ id: z.uuid() })

/** Admin routes of the public API: endpoints per table access and tokens (§15). */
export function registerApiAdminRoutes(app: FastifyInstance, deps: ApiAdminRouteDeps): void {
  const admin = (request: Parameters<typeof requireRole>[0]) => requireRole(request, ['admin'])

  app.get('/internal/admin/api/endpoints', async (request) => {
    admin(request)
    return { data: await deps.endpoints.list() }
  })

  app.put('/internal/admin/api/endpoints/:tableAccessId', async (request) => {
    admin(request)
    const { tableAccessId } = parse(tableAccessParams, request.params)
    return deps.endpoints.update(
      actorOf(request),
      tableAccessId,
      parse(apiEndpointsUpdate.strict(), request.body),
    )
  })

  app.get('/internal/admin/api/tokens', async (request) => {
    admin(request)
    return { data: await deps.tokens.list() }
  })

  app.post('/internal/admin/api/tokens', async (request, reply) => {
    admin(request)
    const body = parse(apiTokenCreate.strict(), request.body)
    return reply.code(201).send(await deps.tokens.create(actorOf(request), body))
  })

  app.put('/internal/admin/api/tokens/:id', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return deps.tokens.update(actorOf(request), id, parse(apiTokenUpdate.strict(), request.body))
  })

  app.post('/internal/admin/api/tokens/:id/revoke', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return deps.tokens.revoke(actorOf(request), id)
  })
}
