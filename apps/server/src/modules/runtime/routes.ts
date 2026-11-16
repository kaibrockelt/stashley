// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  componentId,
  componentQuery,
  fieldOptionsQuery,
  filterOptionsQuery,
  pageModes,
  rowDelete,
  rowQuery,
  rowWrite,
  type TableOp,
} from '@stashley/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { exportCell, exportFormat, exportRow } from '../../platform/csv.ts'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import type { AccessService, Viewer } from '../access/service.ts'
import { actorOf, requireActive } from '../auth/context.ts'
import type { ComponentInput, ComponentReader } from '../execution/component-reader.ts'
import type { RowWriter } from '../execution/writer.ts'
import type { AuditLog } from '../audit/audit-log.ts'

const componentParams = z.object({ pageId: z.uuid(), componentId }).strict()
const rowParams = componentParams.extend({ key: z.string().min(1).max(200) }).strict()
const filterParams = z.object({ pageId: z.uuid(), filterId: componentId }).strict()
const fieldParams = componentParams.extend({ fieldId: componentId }).strict()
/** Writes per user and minute; a station stamps a few per minute at most (§14.6). */
const writeLimit = { rateLimit: { max: 300, timeWindow: '1 minute' } }
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
  deps: {
    access: AccessService
    reader: ComponentReader
    writer: RowWriter
    audit: AuditLog
    /** `APP_TIMEZONE`, for date-times in exports. */
    timeZone: string
    clock?: () => number
  },
): void {
  const { access, reader, writer } = deps
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
    op: TableOp | readonly TableOp[] = 'read',
  ) => {
    // Row routes carry a key as well; it is parsed by the route.
    const params = request.params as Record<string, unknown>
    const { pageId, componentId: id } = parse(componentParams, {
      pageId: params.pageId,
      componentId: params.componentId,
    })
    return access.authorizeComponent(
      await viewer(request),
      pageId,
      id,
      op,
      body.mode ?? 'runtime',
      body.roles ?? [],
    )
  }

  /**
   * CSV export of a table with the current filters (§ Tabellenseiten, E12), while the user may
   * read it. Every export is audited with user, page and row count.
   */
  app.post(
    '/internal/pages/:pageId/components/:componentId/export',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parse(componentQuery, request.body ?? {})
      const handle = await authorize(request, body)
      const { columns, rows } = await reader.exportRows(handle, inputOf(body))
      const auth = requireActive(request)
      const format = exportFormat(
        auth.user.format_locale ?? auth.user.locale ?? 'en-US',
        deps.timeZone,
      )
      const actor = actorOf(request)
      const audit = deps.audit
      const page = handle.page
      async function* csv(): AsyncGenerator<string> {
        // A byte order mark, so spreadsheets read UTF-8.
        yield `\uFEFF${exportRow(
          columns.map((column) => exportCell(column.label, 'string', format)),
          format,
        )}`
        let count = 0
        for await (const row of rows) {
          count++
          yield exportRow(
            row.map((value, index) => exportCell(value, columns[index]?.kind ?? 'string', format)),
            format,
          )
        }
        await audit.record(actor, {
          action: 'table.exported',
          subject: {
            kind: 'component',
            id: handle.component.id,
            label: handle.component.block.title,
          },
          pageId: page.pageId,
          componentId: handle.component.id,
          details: { rows: count, page: page.document.title },
        })
      }
      const name = `${page.slug}-${handle.component.id}.csv`
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`)
      return reply.send(Readable.from(csv()))
    },
  )

  // Writes (§11). Forms create, update or upsert by their mode; tables by their editing.
  app.post(
    '/internal/pages/:pageId/components/:componentId/rows',
    { config: writeLimit },
    async (request, reply) => {
      const body = parse(rowWrite, request.body)
      const handle = await authorize(request, body, ['create', 'update'])
      const block = handle.component.block
      const input = { values: body.values, filters: body.filters, params: body.params }
      const written =
        block.type === 'form' && block.mode === 'upsert'
          ? await writer.upsert(handle, actorOf(request), input)
          : await writer.create(handle, actorOf(request), input)
      return reply.code(written.created === false ? 200 : 201).send(written)
    },
  )

  app.patch(
    '/internal/pages/:pageId/components/:componentId/rows/:key',
    { config: writeLimit },
    async (request) => {
      const { key } = parse(rowParams, request.params)
      const body = parse(rowWrite, request.body)
      // Updates from the UI always say which state they change (§11 lock strategy).
      if (body.version === undefined) {
        throw new AppError('validation_failed', {
          errors: [{ field: 'version', code: 'required' }],
        })
      }
      const handle = await authorize(request, body, 'update')
      return writer.update(handle, actorOf(request), key, {
        values: body.values,
        version: body.version,
        filters: body.filters,
        params: body.params,
      })
    },
  )

  app.delete(
    '/internal/pages/:pageId/components/:componentId/rows/:key',
    { config: writeLimit },
    async (request) => {
      const { key } = parse(rowParams, request.params)
      const body = parse(rowDelete, request.body ?? {})
      const handle = await authorize(request, body, 'delete')
      return writer.remove(handle, actorOf(request), key, { version: body.version })
    },
  )

  /** The record of a form in edit mode or a row edited inline, with its version token. */
  app.get('/internal/pages/:pageId/components/:componentId/rows/:key/edit', async (request) => {
    const { pageId, componentId: id, key } = parse(rowParams, request.params)
    const query = parse(rowQuery, request.query)
    const handle = await access.authorizeComponent(
      await viewer(request),
      pageId,
      id,
      'update',
      query.mode ?? 'runtime',
      rolesOf(query.roles),
    )
    return writer.current(handle, key)
  })

  app.post(
    '/internal/pages/:pageId/components/:componentId/fields/:fieldId/options',
    async (request) => {
      const { pageId, componentId: id, fieldId } = parse(fieldParams, request.params)
      const body = parse(fieldOptionsQuery, request.body ?? {})
      // Option lists use the right of their component (D12): whoever may write the field.
      const handle = await access.authorizeComponent(
        await viewer(request),
        pageId,
        id,
        ['create', 'update'],
        body.mode ?? 'runtime',
        body.roles ?? [],
      )
      return reader.fieldOptions(handle, fieldId, {
        search: body.search,
        cursor: body.cursor,
        values: body.values,
        filters: body.filters ?? {},
        params: body.params ?? {},
      })
    },
  )

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
    return reader.options(handle, { search: body.search, cursor: body.cursor, values: body.values })
  })
}
