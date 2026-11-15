// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  navigationOrder,
  pageCreate,
  pageDocument,
  pageUpdate,
  sectionInput,
  sectionUpdate,
} from '@stashley/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError, problem } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import type { AccessService } from '../access/service.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import { DraftConflict, type PagesService } from './service.ts'

const idParams = z.object({ id: z.uuid() })
const versionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() })
const permissionQuery = z
  .object({ object: z.string().max(64), role: z.string().max(64), page: z.uuid() })
  .partial()
  .strict()

/** `If-Match: "<revision>"`; drafts are saved only against the revision the editor loaded. */
function revisionOf(request: FastifyRequest, required: boolean): number | undefined {
  const header = request.headers['if-match']
  if (header === undefined) {
    if (required)
      throw new AppError('bad_request', { errors: [{ field: 'if-match', code: 'required' }] })
    return undefined
  }
  const match = /^"?(\d{1,9})"?$/.exec(String(header).trim())
  if (match === null)
    throw new AppError('bad_request', { errors: [{ field: 'if-match', code: 'invalid' }] })
  return Number(match[1])
}

/** A draft conflict answers with the current draft, so the editor can show both (§13.2). */
function conflict(reply: FastifyReply, error: DraftConflict): FastifyReply {
  return reply
    .code(409)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ ...problem('conflict'), current: error.current })
}

/** Design routes for sections and pages (M4 API; the editor follows in M5). */
export function registerPageRoutes(
  app: FastifyInstance,
  deps: { pages: PagesService; access: AccessService },
): void {
  const designer = (request: FastifyRequest) => requireRole(request, ['admin', 'manager'])
  const { pages, access } = deps

  app.get('/internal/design/sections', async (request) => {
    designer(request)
    return { data: await pages.sections() }
  })

  app.post('/internal/design/sections', async (request, reply) => {
    designer(request)
    const { name } = parse(sectionInput, request.body)
    return reply.code(201).send(await pages.createSection(actorOf(request), name))
  })

  app.patch('/internal/design/sections/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return pages.updateSection(actorOf(request), id, parse(sectionUpdate, request.body))
  })

  app.delete('/internal/design/sections/:id', async (request, reply) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    await pages.removeSection(actorOf(request), id)
    return reply.code(204).send()
  })

  app.get('/internal/design/pages', async (request) => {
    designer(request)
    return { data: await pages.list() }
  })

  app.post('/internal/design/pages', async (request, reply) => {
    designer(request)
    const body = parse(pageCreate, request.body)
    return reply.code(201).send(await pages.create(actorOf(request), body))
  })

  app.get('/internal/design/pages/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return pages.get(id)
  })

  app.patch('/internal/design/pages/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return pages.update(actorOf(request), id, parse(pageUpdate, request.body))
  })

  app.delete('/internal/design/pages/:id', async (request, reply) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    await pages.remove(actorOf(request), id)
    return reply.code(204).send()
  })

  app.put('/internal/design/pages/:id/draft', async (request, reply) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    const revision = revisionOf(request, true) as number
    const document = parse(pageDocument, request.body)
    try {
      return await pages.saveDraft(actorOf(request), id, revision, document)
    } catch (error) {
      if (error instanceof DraftConflict) return conflict(reply, error)
      throw error
    }
  })

  app.post('/internal/design/pages/:id/publish', async (request, reply) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    try {
      return await pages.publish(actorOf(request), id, revisionOf(request, false))
    } catch (error) {
      if (error instanceof DraftConflict) return conflict(reply, error)
      throw error
    }
  })

  app.put('/internal/design/navigation', async (request, reply) => {
    designer(request)
    await pages.reorder(actorOf(request), parse(navigationOrder, request.body))
    return reply.code(204).send()
  })

  app.get('/internal/design/pages/:id/versions', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    return { data: await pages.versions(id) }
  })

  app.get('/internal/design/pages/:id/versions/:version', async (request) => {
    designer(request)
    const { id, version } = parse(versionParams, request.params)
    return pages.version(id, version)
  })

  /** Restores a version into the draft; `If-Match` names the draft revision it replaces. */
  app.post('/internal/design/pages/:id/versions/:version/restore', async (request, reply) => {
    designer(request)
    const { id, version } = parse(versionParams, request.params)
    const revision = revisionOf(request, true) as number
    try {
      return await pages.restore(actorOf(request), id, version, revision)
    } catch (error) {
      if (error instanceof DraftConflict) return conflict(reply, error)
      throw error
    }
  })

  app.get('/internal/design/issues', async (request) => {
    designer(request)
    return { data: await access.issues() }
  })

  app.get('/internal/admin/permissions', async (request) => {
    requireRole(request, ['admin'])
    const query = parse(permissionQuery, request.query)
    return {
      data: await access.overview({
        ...(query.object !== undefined && { object: query.object }),
        ...(query.role !== undefined && { principal: query.role }),
        ...(query.page !== undefined && { pageId: query.page }),
      }),
    }
  })
}
