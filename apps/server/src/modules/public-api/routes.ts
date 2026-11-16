// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiOperation } from '@stashley/shared'
import { errorCodes } from '@stashley/shared'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { minute } from '../../platform/clock.ts'
import { AppError, errorHandler, problem, sendProblem } from '../../platform/http/problem.ts'
import type { Actor } from '../audit/audit-log.ts'
import { FailureLimiter } from '../auth/failure-limiter.ts'
import type { AccessService, AuthorizedResource } from '../access/service.ts'
import type { ResourceReader } from '../execution/resource-reader.ts'
import type { RowWriter, WrittenRow } from '../execution/writer.ts'
import type { ApiDocs } from './docs.ts'
import type { ApiEndpoints } from './endpoints.ts'
import { checkBody, onlyParameters, parseCountQuery, parseListQuery } from './query.ts'
import type { ApiPrincipal, ApiTokens } from './tokens.ts'

export interface PublicApiDeps {
  access: AccessService
  endpoints: ApiEndpoints
  tokens: ApiTokens
  reader: ResourceReader
  writer: RowWriter
  docs: ApiDocs
}

declare module 'fastify' {
  interface FastifyRequest {
    apiPrincipal: ApiPrincipal | null
  }
}

const bodyLimit = 1024 * 1024

/** The challenge of a missing or invalid bearer token (RFC 6750). */
function challenge(reply: FastifyReply, invalid: boolean): void {
  void reply.header(
    'www-authenticate',
    invalid ? 'Bearer realm="stashley", error="invalid_token"' : 'Bearer realm="stashley"',
  )
}

/**
 * Errors of the public API: problem documents like the internal API, with two differences
 * (§16, D6): a duplicate key answers 422, and a version conflict is `412` without the current
 * row, because `If-Match` decided it.
 */
function apiErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    if (error.code === 'version_conflict') return sendProblem(reply, problem('precondition_failed'))
    if (error.code === 'unique_violation') {
      return sendProblem(reply, {
        ...problem('unique_violation', {
          ...(error.errors !== undefined && { errors: error.errors }),
        }),
        status: errorCodes.validation_failed.status,
      })
    }
    if (error.code === 'unauthenticated' && !reply.hasHeader('www-authenticate')) {
      challenge(reply, true)
    }
  }
  return errorHandler(error, request, reply)
}

/** `If-Match` (E17): `*`, one strong ETag, or nothing. Weak or several tags are refused. */
function ifMatch(request: FastifyRequest): string | undefined {
  const header = request.headers['if-match']
  if (header === undefined) return undefined
  const value = Array.isArray(header) ? header.join(',') : header
  const trimmed = value.trim()
  if (trimmed === '*') return '*'
  const match = /^"([A-Za-z0-9_-]{1,64})"$/.exec(trimmed)
  if (match === null) {
    throw new AppError('bad_request', { errors: [{ field: 'If-Match', code: 'invalid' }] })
  }
  return match[1]
}

function refuseIfMatch(request: FastifyRequest): void {
  if (request.headers['if-match'] !== undefined) {
    throw new AppError('bad_request', { errors: [{ field: 'If-Match', code: 'not_allowed' }] })
  }
}

function actorOf(request: FastifyRequest, handle: AuthorizedResource): Actor {
  return { kind: 'api_token', id: handle.token.id, label: handle.token.name, ip: request.ip }
}

/**
 * The public REST API (§16): `/api/v1/:resource[/:id]`, `/count`, `/schema`. Bearer tokens
 * only; session cookies are never read here. `STASHLEY_PUBLIC_API=off` leaves it out.
 */
export function registerPublicApi(app: FastifyInstance, deps: PublicApiDeps): void {
  const failures = new FailureLimiter({ threshold: 20, windowMs: minute })
  app.decorateRequest('apiPrincipal', null)

  void app.register(
    (api, _options, done) => {
      api.setErrorHandler(apiErrorHandler)

      api.addHook('onRequest', async (request, reply) => {
        const wait = failures.retryAfter(request.ip)
        if (wait > 0) {
          void reply.header('retry-after', String(Math.ceil(wait / 1000)))
          throw new AppError('rate_limited')
        }
        const header = request.headers.authorization
        const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1]
        if (token === undefined) {
          challenge(reply, header !== undefined)
          throw new AppError('unauthenticated')
        }
        const checked = await deps.tokens.authenticate(token, request.ip)
        if (!checked.ok) {
          if (checked.code === 'unauthenticated') {
            failures.fail(request.ip)
            challenge(reply, true)
          }
          throw new AppError(checked.code)
        }
        const retryAfter = deps.tokens.take(checked.principal)
        if (retryAfter > 0) {
          void reply.header('retry-after', String(retryAfter))
          throw new AppError('rate_limited')
        }
        request.apiPrincipal = checked.principal
      })

      api.addHook('onSend', async (_request, reply) => {
        void reply.header('cache-control', 'no-store')
      })

      const authorize = (request: FastifyRequest, operation: ApiOperation) => {
        const principal = request.apiPrincipal as ApiPrincipal
        const { resource } = request.params as { resource: string }
        return deps.access.authorizeResource({
          alias: resource,
          operation,
          token: { id: principal.tokenId, name: principal.name, grants: principal.grants },
          enabled: (id) => deps.endpoints.enabled(id),
        })
      }

      /** The answer of a write: the row when the token may read it, the key otherwise. */
      const answer = (reply: FastifyReply, handle: AuthorizedResource, written: WrittenRow) => {
        if (written.version !== undefined) void reply.header('etag', `"${written.version}"`)
        return written.values ?? { [handle.resource.keyColumn]: written.key }
      }

      // Without a token this answers 401 like every other route (E21).
      api.get('/docs', async (request) => {
        onlyParameters(request.query, [])
        return deps.docs.forToken(request.apiPrincipal as ApiPrincipal)
      })

      api.get('/v1/:resource', async (request) => {
        const handle = await authorize(request, 'list')
        const page = await deps.reader.list(handle, parseListQuery(request.query, handle.resource))
        return { data: page.data, next_cursor: page.nextCursor }
      })

      api.get('/v1/:resource/count', async (request) => {
        const handle = await authorize(request, 'count')
        const result = await deps.reader.count(
          handle,
          parseCountQuery(request.query, handle.resource),
        )
        return { count: result.count, approximate: result.approximate }
      })

      api.get('/v1/:resource/schema', async (request) => {
        onlyParameters(request.query, [])
        const handle = await authorize(request, 'schema')
        const principal = request.apiPrincipal as ApiPrincipal
        const resource = handle.resource
        const granted = principal.grants.get(resource.tableAccessId) ?? new Set()
        const enabled = await deps.endpoints.enabled(resource.tableAccessId)
        return {
          resource: resource.alias,
          key: resource.keyless ? null : resource.keyColumn,
          operations: resource.available.filter(
            (operation) => enabled.has(operation) && granted.has(operation),
          ),
          upsert_keys: resource.upsertColumns,
          columns: resource.columns.map((column) => ({
            name: column.name,
            type: column.kind,
            column_type: column.columnType,
            nullable: column.nullable,
            required_on_create: column.insertable && column.spec.required,
            writable: { create: column.insertable, update: column.updatable },
            max_length: column.spec.maxLength,
            precision: column.spec.precision,
            scale: column.spec.scale,
            ...(column.spec.enumValues !== undefined && { enum_values: column.spec.enumValues }),
          })),
        }
      })

      api.get('/v1/:resource/:id', async (request, reply) => {
        onlyParameters(request.query, [])
        const handle = await authorize(request, 'get')
        const { id } = request.params as { id: string }
        const row = await deps.reader.get(handle, id)
        if (row === undefined) throw new AppError('not_found')
        const version = deps.writer.resourceVersion(handle.resource, row)
        if (version !== undefined) void reply.header('etag', `"${version}"`)
        return row
      })

      api.post('/v1/:resource', { bodyLimit }, async (request, reply) => {
        onlyParameters(request.query, [])
        refuseIfMatch(request)
        const handle = await authorize(request, 'create')
        const body = checkBody(handle.resource, request.body, 'insertable')
        const written = await deps.writer.createResource(handle, actorOf(request, handle), body)
        void reply
          .code(201)
          .header(
            'location',
            `/api/v1/${encodeURIComponent(handle.resource.alias)}/${encodeURIComponent(String(written.key))}`,
          )
        return answer(reply, handle, written)
      })

      const update = (operation: 'update' | 'replace') =>
        async function (request: FastifyRequest, reply: FastifyReply) {
          onlyParameters(request.query, [])
          const version = ifMatch(request)
          const handle = await authorize(request, operation)
          const { id } = request.params as { id: string }
          const body = checkBody(handle.resource, request.body, 'updatable')
          const written = await deps.writer.updateResource(
            handle,
            actorOf(request, handle),
            id,
            body,
            { version, replace: operation === 'replace' },
          )
          return answer(reply, handle, written)
        }
      api.patch('/v1/:resource/:id', { bodyLimit }, update('update'))
      api.put('/v1/:resource/:id', { bodyLimit }, update('replace'))

      api.put('/v1/:resource', { bodyLimit }, async (request, reply) => {
        const query = onlyParameters(request.query, ['on'])
        refuseIfMatch(request)
        if (typeof query.on !== 'string' || query.on === '') {
          throw new AppError('bad_request', { errors: [{ field: 'on', code: 'required' }] })
        }
        const handle = await authorize(request, 'upsert')
        const body = checkBody(handle.resource, request.body, 'insertable')
        const written = await deps.writer.upsertResource(
          handle,
          actorOf(request, handle),
          body,
          query.on,
        )
        void reply.code(written.created === true ? 201 : 200)
        return answer(reply, handle, written)
      })

      api.delete('/v1/:resource/:id', async (request, reply) => {
        onlyParameters(request.query, [])
        const version = ifMatch(request)
        const handle = await authorize(request, 'delete')
        const { id } = request.params as { id: string }
        await deps.writer.removeResource(handle, actorOf(request, handle), id, version)
        return reply.code(204).send()
      })
      done()
    },
    { prefix: '/api' },
  )
}
