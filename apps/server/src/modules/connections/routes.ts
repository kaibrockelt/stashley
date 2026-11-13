// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  connectionInput,
  relationInput,
  tableAccessCreate,
  tableAccessUpdate,
} from '@stashley/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import type { CatalogService } from '../catalog/service.ts'
import type { TableAccessService } from '../table-access/service.ts'
import type { ConnectionsService } from './service.ts'

export interface DataRouteDeps {
  connections: ConnectionsService
  catalog: CatalogService
  tableAccess: TableAccessService
}

const idParams = z.object({ id: z.uuid() })
const driftParams = z.object({ id: z.uuid(), driftId: z.uuid() })
const connectionQuery = z.object({ connectionId: z.uuid() })
const testBody = connectionInput.extend({ connectionId: z.uuid().optional() })
/** These open connections to other hosts; the limit keeps them from becoming a port scanner. */
const outbound = { rateLimit: { max: 20, timeWindow: '1 minute' } }

/** Admin routes for connections, schema, table access and relations (M3). */
export function registerDataRoutes(app: FastifyInstance, deps: DataRouteDeps): void {
  const admin = (request: Parameters<typeof requireRole>[0]) => requireRole(request, ['admin'])
  const { connections, catalog, tableAccess } = deps

  app.get('/internal/admin/connections', async (request) => {
    admin(request)
    return { data: await connections.list() }
  })

  app.post('/internal/admin/connections/test', { config: outbound }, async (request) => {
    admin(request)
    const { connectionId, ...input } = parse(testBody.strict(), request.body)
    return connections.test(actorOf(request), input, connectionId)
  })

  app.post('/internal/admin/connections', { config: outbound }, async (request, reply) => {
    admin(request)
    const actor = actorOf(request)
    const created = await connections.create(actor, parse(connectionInput.strict(), request.body))
    try {
      await catalog.refresh(actor, created.id, 'manual')
    } catch (error) {
      // The connection is saved; the schema can be read again from its page.
      const code = error instanceof AppError ? error.code : 'internal_error'
      request.log.warn({ connectionId: created.id, code }, 'initial schema read failed')
    }
    return reply.code(201).send(await connections.get(created.id))
  })

  app.get('/internal/admin/connections/:id', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return connections.get(id)
  })

  app.put('/internal/admin/connections/:id', { config: outbound }, async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return connections.update(actorOf(request), id, parse(connectionInput.strict(), request.body))
  })

  app.delete('/internal/admin/connections/:id', async (request, reply) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await connections.remove(actorOf(request), id)
    return reply.code(204).send()
  })

  app.post('/internal/admin/connections/:id/grants', { config: outbound }, async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return connections.recheckGrants(actorOf(request), id)
  })

  app.get('/internal/admin/connections/:id/schema', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await connections.get(id)
    const snapshot = await catalog.current(id)
    if (snapshot === undefined) throw new AppError('not_found')
    return snapshot
  })

  app.post(
    '/internal/admin/connections/:id/schema/refresh',
    { config: outbound },
    async (request) => {
      admin(request)
      const { id } = parse(idParams, request.params)
      await connections.get(id)
      return catalog.refresh(actorOf(request), id, 'manual')
    },
  )

  app.get('/internal/admin/connections/:id/schema/drifts', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await connections.get(id)
    return { data: await catalog.drifts(id) }
  })

  app.post(
    '/internal/admin/connections/:id/schema/drifts/:driftId/acknowledge',
    async (request, reply) => {
      admin(request)
      const { id, driftId } = parse(driftParams, request.params)
      await catalog.acknowledge(actorOf(request), id, driftId)
      return reply.code(204).send()
    },
  )

  // Table access

  app.get('/internal/admin/table-access', async (request) => {
    admin(request)
    const { connectionId } = parse(connectionQuery, request.query)
    return { data: await tableAccess.list(connectionId) }
  })

  app.post('/internal/admin/table-access', async (request, reply) => {
    admin(request)
    const body = parse(tableAccessCreate.strict(), request.body)
    return reply.code(201).send(await tableAccess.create(actorOf(request), body))
  })

  app.put('/internal/admin/table-access/:id', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return tableAccess.update(actorOf(request), id, parse(tableAccessUpdate.strict(), request.body))
  })

  app.delete('/internal/admin/table-access/:id', async (request, reply) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await tableAccess.remove(actorOf(request), id)
    return reply.code(204).send()
  })

  // Relations

  app.get('/internal/admin/relations', async (request) => {
    admin(request)
    const { connectionId } = parse(connectionQuery, request.query)
    await connections.get(connectionId)
    return { data: await tableAccess.relations(connectionId) }
  })

  app.post('/internal/admin/relations', async (request, reply) => {
    admin(request)
    const body = parse(relationInput.strict(), request.body)
    return reply.code(201).send(await tableAccess.createRelation(actorOf(request), body))
  })

  app.delete('/internal/admin/relations/:id', async (request, reply) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await tableAccess.removeRelation(actorOf(request), id)
    return reply.code(204).send()
  })
}
