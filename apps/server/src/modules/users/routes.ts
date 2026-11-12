// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  auditQuery,
  identityProviderInput,
  instanceSettingsUpdate,
  userInvite,
  userStatuses,
  userUpdate,
} from '@stashley/shared'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import type { AuditLog } from '../audit/audit-log.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import type { OidcService } from '../auth/oidc.ts'
import type { InstanceSettingsService } from '../system/instance-settings.ts'
import type { UsersRepository } from './repository.ts'
import type { UsersService } from './service.ts'

export interface AdminRouteDeps {
  users: UsersRepository
  usersService: UsersService
  oidc: OidcService
  instanceSettings: InstanceSettingsService
  audit: AuditLog
}

const idParams = z.object({ id: z.uuid() })
const identityParams = z.object({ id: z.uuid(), identityId: z.uuid() })
const userListQuery = z.object({
  status: z.enum(userStatuses).optional(),
  q: z.string().max(100).optional(),
})

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const admin = (request: Parameters<typeof requireRole>[0]) => requireRole(request, ['admin'])

  // Users

  app.get('/internal/admin/users', async (request) => {
    admin(request)
    const query = parse(userListQuery, request.query)
    return {
      data: await deps.users.list({
        ...(query.status !== undefined && { status: query.status }),
        ...(query.q !== undefined && { query: query.q }),
      }),
    }
  })

  app.post('/internal/admin/users', async (request, reply) => {
    admin(request)
    const body = parse(userInvite, request.body)
    return reply.code(201).send(await deps.usersService.invite(actorOf(request), body))
  })

  app.patch('/internal/admin/users/:id', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return deps.usersService.update(actorOf(request), id, parse(userUpdate.strict(), request.body))
  })

  app.post('/internal/admin/users/:id/password-reset', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return deps.usersService.sendPasswordReset(actorOf(request), id)
  })

  app.post('/internal/admin/users/:id/invitation', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return deps.usersService.resendInvitation(actorOf(request), id)
  })

  app.post('/internal/admin/users/:id/mfa/reset', async (request, reply) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await deps.usersService.resetMfa(actorOf(request), id)
    return reply.code(204).send()
  })

  app.delete('/internal/admin/users/:id/identities/:identityId', async (request, reply) => {
    admin(request)
    const { id, identityId } = parse(identityParams, request.params)
    await deps.usersService.removeIdentity(actorOf(request), id, identityId)
    return reply.code(204).send()
  })

  // Identity providers

  app.get('/internal/admin/identity-providers', async (request) => {
    admin(request)
    return { data: await deps.oidc.list() }
  })

  app.post('/internal/admin/identity-providers', async (request, reply) => {
    admin(request)
    const body = parse(identityProviderInput, request.body)
    return reply.code(201).send(await deps.oidc.create(actorOf(request), body))
  })

  app.put('/internal/admin/identity-providers/:id', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    return deps.oidc.update(actorOf(request), id, parse(identityProviderInput, request.body))
  })

  app.delete('/internal/admin/identity-providers/:id', async (request, reply) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    await deps.oidc.remove(actorOf(request), id)
    return reply.code(204).send()
  })

  // Instance settings

  app.get('/internal/admin/settings', async (request) => {
    admin(request)
    return deps.instanceSettings.get()
  })

  app.patch('/internal/admin/settings', async (request) => {
    admin(request)
    const body = parse(instanceSettingsUpdate.strict(), request.body)
    return deps.instanceSettings.update(actorOf(request), body)
  })

  // Audit log

  const auditFilter = (query: z.infer<typeof auditQuery>) => ({
    ...(query.from !== undefined && { from: Date.parse(query.from) }),
    ...(query.to !== undefined && { to: Date.parse(query.to) }),
    ...(query.action !== undefined && { action: query.action }),
    ...(query.actor !== undefined && { actor: query.actor }),
  })

  app.get('/internal/admin/audit', async (request) => {
    admin(request)
    const query = parse(auditQuery, request.query)
    return deps.audit.query(auditFilter(query), query.limit ?? 100, query.cursor)
  })

  app.get('/internal/admin/audit/export', async (request, reply) => {
    admin(request)
    const query = parse(auditQuery, request.query)
    await deps.audit.record(actorOf(request), {
      action: 'audit.exported',
      details: { filter: auditFilter(query) },
    })
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="stashley-audit.csv"')
    return reply.send(Readable.from(deps.audit.exportCsv(auditFilter(query))))
  })

  app.get('/internal/admin/users/:id', async (request) => {
    admin(request)
    const { id } = parse(idParams, request.params)
    const user = await deps.users.getAdminUser(id)
    if (user === undefined) throw new AppError('not_found')
    return user
  })
}
