// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  componentId,
  componentQuery,
  filterOptionsQuery,
  pageModes,
  rowQuery,
} from '@stashley/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import type { AccessService, Viewer } from '../access/service.ts'
import { requireActive } from '../auth/context.ts'
import type { ComponentInput, ComponentReader } from '../execution/component-reader.ts'

const componentParams = z.object({ pageId: z.uuid(), componentId }).strict()
const rowParams = componentParams.extend({ key: z.string().min(1).max(200) }).strict()
const filterParams = z.object({ pageId: z.uuid(), filterId: componentId }).strict()
const slugParams = z.object({ slug: z.string().min(1).max(63) }).strict()
const pageQuery = z
  .object({ mode: z.enum(pageModes).optional(), roles: z.string().max(2000).optional() })
  .strict()

/** Manual refresh: once per 10 s per user and component (§12, §14.6). */
export const refreshIntervalMs = 10_000

function rolesOf(value: string | undefined): string[] {
  if (value === undefined || value === '') return []
  const roles = value.split(',')
  if (roles.length > 50 || !roles.every((role) => z.uuid().safeParse(role).success)) {
    throw new AppError('validation_failed', { errors: [{ field: 'roles', code: 'invalid' }] })
  }
  return roles
}

function inputOf(body: z.infer<typeof componentQuery>, refresh = false): ComponentInput {
  return {
    filters: body.filters ?? {},
    params: body.params ?? {},
    sort: body.sort,
    search: body.search,
    columnFilters: body.columnFilters?.map((filter) => ({
      columnId: filter.columnId,
      operator: filter.operator,
      ...(filter.value !== undefined && { value: filter.value }),
    })),
    cursor: body.cursor,
    pageSize: body.pageSize,
    refresh,
  }
}

/**
 * Workspace routes (§15): navigation, page render models and the component endpoints. The
 * internal API offers no generic table access; it runs stored components only, addressed by
 * page and component ID, after `access` authorized them.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  deps: { access: AccessService; reader: ComponentReader; clock?: () => number },
): void {
  const { access, reader } = deps
  const clock = deps.clock ?? Date.now
  const refreshed = new Map<string, number>()
  const viewer = (request: FastifyRequest): Promise<Viewer> => access.viewer(requireActive(request))

  app.get('/internal/navigation', async (request) => access.navigation(await viewer(request)))

  app.get('/internal/pages/:slug', async (request) => {
    const { slug } = parse(slugParams, request.params)
    const query = parse(pageQuery, request.query)
    return access.renderPage(
      await viewer(request),
      slug,
      query.mode ?? 'runtime',
      rolesOf(query.roles),
    )
  })

  const authorize = async (
    request: FastifyRequest,
    body: { mode?: (typeof pageModes)[number] | undefined; roles?: string[] | undefined },
  ) => {
    const { pageId, componentId: id } = parse(componentParams, request.params)
    return access.authorizeComponent(
      await viewer(request),
      pageId,
      id,
      'read',
      body.mode ?? 'runtime',
      body.roles ?? [],
    )
  }

  app.post('/internal/pages/:pageId/components/:componentId/query', async (request) => {
    const body = parse(componentQuery, request.body ?? {})
    return reader.read(await authorize(request, body), inputOf(body))
  })

  app.post('/internal/pages/:pageId/components/:componentId/count', async (request) => {
    const body = parse(componentQuery, request.body ?? {})
    return reader.count(await authorize(request, body), inputOf(body))
  })

  app.post('/internal/pages/:pageId/components/:componentId/refresh', async (request, reply) => {
    const body = parse(componentQuery, request.body ?? {})
    const handle = await authorize(request, body)
    const key = `${handle.user.id}:${handle.page.pageId}:${handle.component.id}`
    const now = clock()
    const last = refreshed.get(key)
    if (last !== undefined && now - last < refreshIntervalMs) {
      void reply.header('retry-after', String(Math.ceil((refreshIntervalMs - (now - last)) / 1000)))
      throw new AppError('rate_limited')
    }
    refreshed.set(key, now)
    if (refreshed.size > 10_000) {
      for (const [entry, at] of refreshed) {
        if (now - at >= refreshIntervalMs) refreshed.delete(entry)
      }
    }
    return reader.read(handle, inputOf(body, true))
  })

  app.get('/internal/pages/:pageId/components/:componentId/rows/:key', async (request) => {
    const { pageId, componentId: id, key } = parse(rowParams, request.params)
    const query = parse(rowQuery, request.query)
    const handle = await access.authorizeComponent(
      await viewer(request),
      pageId,
      id,
      'read',
      query.mode ?? 'runtime',
      rolesOf(query.roles),
    )
    return reader.row(handle, key)
  })

  app.post('/internal/pages/:pageId/filters/:filterId/options', async (request) => {
    const { pageId, filterId } = parse(filterParams, request.params)
    const body = parse(filterOptionsQuery, request.body ?? {})
    const handle = await access.authorizeFilter(
      await viewer(request),
      pageId,
      filterId,
      body.mode ?? 'runtime',
      body.roles ?? [],
    )
    return reader.options(handle, { search: body.search, cursor: body.cursor })
  })
}
