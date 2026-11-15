// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { queryCreate, queryTestRun, queryUpdate, queryValidate } from '@stashley/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import type { QueriesService } from './service.ts'

const idParams = z.object({ id: z.uuid() })
const versionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() })
const listQuery = z.object({ connectionId: z.uuid().optional() }).strict()
/** Test runs reach target databases; the limit keeps the editor from flooding them. */
const testRunLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } }

/** Query library routes of the design area (§10.1, §15). */
export function registerQueryRoutes(app: FastifyInstance, deps: { queries: QueriesService }) {
  const designer = (request: Parameters<typeof requireRole>[0]) =>
    requireRole(request, ['admin', 'manager'])
  const { queries } = deps

  app.get('/internal/design/connections', async (request) => {
    designer(request)
    return { data: await queries.designConnections() }
  })

  app.get('/internal/design/catalog/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return queries.designCatalog(id)
  })

  app.get('/internal/design/queries', async (request) => {
    designer(request)
    const { connectionId } = parse(listQuery, request.query)
    return { data: await queries.list(connectionId) }
  })

  app.post('/internal/design/queries', async (request, reply) => {
    designer(request)
    const body = parse(queryCreate, request.body)
    return reply.code(201).send(await queries.create(actorOf(request), body))
  })

  app.post('/internal/design/queries/validate', async (request) => {
    designer(request)
    const body = parse(queryValidate, request.body)
    const { sql, builder } = await queries.toSql(body.connectionId, body, body.parameters)
    const { analysis, executable } = await queries.validate(body.connectionId, sql, body.parameters)
    return { sql, analysis, limit: executable.limit, notes: builder?.notes ?? [] }
  })

  app.post('/internal/design/queries/run', { config: testRunLimit }, async (request) => {
    const auth = designer(request)
    const body = parse(queryTestRun, request.body)
    return queries.testRun({ id: auth.user.id, email: auth.user.email }, body)
  })

  app.get('/internal/design/queries/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return queries.get(id)
  })

  app.patch('/internal/design/queries/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return queries.update(actorOf(request), id, parse(queryUpdate, request.body))
  })

  app.delete('/internal/design/queries/:id', async (request, reply) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    await queries.remove(actorOf(request), id)
    return reply.code(204).send()
  })

  app.get('/internal/design/queries/:id/versions', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return { data: await queries.versions(id) }
  })

  app.get('/internal/design/queries/:id/versions/:version', async (request) => {
    designer(request)
    const { id, version } = parse(versionParams, request.params)
    const found = (await queries.versions(id)).find((entry) => entry.version === version)
    if (found === undefined) throw new AppError('not_found')
    return found
  })
}
