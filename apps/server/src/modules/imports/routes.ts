// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Readable } from 'node:stream'
import { importSettings } from '@stashley/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import { actorOf, requireActive } from '../auth/context.ts'
import type { ImportService, ImportUser } from './service.ts'

export interface ImportRouteDeps {
  imports: ImportService
  maxBytes: number
}

const idParams = z.object({ id: z.uuid() }).strict()
const targetParams = z.object({ id: z.uuid(), tableAccessId: z.uuid() }).strict()
const uploadQuery = z.object({ fileName: z.string().trim().min(1).max(255) }).strict()

function perUser(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) =>
        request.auth === null ? `ip:${request.ip}` : `user:${request.auth.user.id}`,
    },
  }
}

function userOf(request: FastifyRequest): ImportUser {
  const auth = requireActive(request)
  return {
    id: auth.user.id,
    email: auth.user.email,
    systemRole: auth.user.system_role,
    formatLocale: auth.user.format_locale ?? auth.user.locale ?? 'en',
  }
}

/**
 * CSV import (§15, §17): managers and admins. The upload is the raw `text/csv` body (D1),
 * streamed to disk; everything else is JSON.
 */
export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDeps): void {
  const { imports } = deps

  void app.register((scope, _options, done) => {
    // The upload body stays a stream; its size is checked while it is written.
    scope.addContentTypeParser('text/csv', (_request, payload, next) => next(null, payload))

    scope.post('/internal/imports', { config: perUser(10) }, async (request, reply) => {
      const user = userOf(request)
      const { fileName } = parse(uploadQuery, request.query)
      const length = Number(request.headers['content-length'] ?? 0)
      if (length > deps.maxBytes) throw new AppError('payload_too_large')
      if (!(request.headers['content-type'] ?? '').startsWith('text/csv')) {
        throw new AppError('unsupported_media_type')
      }
      const job = await imports.upload(user, request.body as Readable, fileName)
      return reply.code(201).send(job)
    })
    done()
  })

  app.get('/internal/imports', async (request) => ({ data: await imports.list(userOf(request)) }))

  app.get('/internal/imports/targets', async (request) => ({
    data: await imports.targets(userOf(request)),
  }))

  app.get('/internal/imports/:id', async (request) => {
    const { id } = parse(idParams, request.params)
    return imports.get(userOf(request), id)
  })

  app.get('/internal/imports/:id/targets/:tableAccessId', async (request) => {
    const { id, tableAccessId } = parse(targetParams, request.params)
    return imports.target(userOf(request), id, tableAccessId)
  })

  app.get('/internal/imports/:id/preview', async (request) => {
    const { id } = parse(idParams, request.params)
    return imports.preview(userOf(request), id)
  })

  app.put('/internal/imports/:id', async (request) => {
    const { id } = parse(idParams, request.params)
    return imports.configure(userOf(request), id, parse(importSettings, request.body))
  })

  app.post('/internal/imports/:id/dry-run', { config: perUser(20) }, async (request) => {
    const { id } = parse(idParams, request.params)
    return imports.dryRun(userOf(request), id)
  })

  app.post('/internal/imports/:id/run', { config: perUser(10) }, async (request) => {
    const { id } = parse(idParams, request.params)
    return imports.run(userOf(request), actorOf(request), id)
  })

  app.post('/internal/imports/:id/cancel', async (request) => {
    const { id } = parse(idParams, request.params)
    return imports.cancel(userOf(request), id)
  })

  app.get('/internal/imports/:id/errors', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const csv = await imports.errorList(userOf(request), id)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="import-errors.csv"')
      .send(csv)
  })

  app.delete('/internal/imports/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    await imports.remove(userOf(request), id)
    return reply.code(204).send()
  })
}
