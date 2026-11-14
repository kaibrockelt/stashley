// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  roleInput,
  roleUpdate,
  userRolesInput,
  variableCreate,
  variableUpdate,
} from '@stashley/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse } from '../../platform/http/validation.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import type { VariablesService } from '../variables/service.ts'
import type { RolesService } from './service.ts'

export interface RoleRouteDeps {
  roles: RolesService
  variables: VariablesService
}

const idParams = z.object({ id: z.uuid() })

/** Design routes for roles and instance variables, and the admin route for role assignment. */
export function registerRoleRoutes(app: FastifyInstance, deps: RoleRouteDeps): void {
  const designer = (request: Parameters<typeof requireRole>[0]) =>
    requireRole(request, ['admin', 'manager'])

  app.get('/internal/design/roles', async (request) => {
    designer(request)
    return { data: await deps.roles.list() }
  })

  app.post('/internal/design/roles', async (request, reply) => {
    const auth = designer(request)
    const body = parse(roleInput.strict(), request.body)
    const role = await deps.roles.create(actorOf(request), auth.user.system_role, body)
    return reply.code(201).send(role)
  })

  app.patch('/internal/design/roles/:id', async (request) => {
    const auth = designer(request)
    const { id } = parse(idParams, request.params)
    const body = parse(roleUpdate.strict(), request.body)
    return deps.roles.update(actorOf(request), auth.user.system_role, id, body)
  })

  app.delete('/internal/design/roles/:id', async (request, reply) => {
    const auth = designer(request)
    const { id } = parse(idParams, request.params)
    await deps.roles.remove(actorOf(request), auth.user.system_role, id)
    return reply.code(204).send()
  })

  app.put('/internal/admin/users/:id/roles', async (request) => {
    requireRole(request, ['admin'])
    const { id } = parse(idParams, request.params)
    const { roleIds } = parse(userRolesInput.strict(), request.body)
    return { roleIds: await deps.roles.assign(actorOf(request), id, roleIds) }
  })

  app.get('/internal/design/variables', async (request) => {
    designer(request)
    return { data: await deps.variables.list() }
  })

  app.post('/internal/design/variables', async (request, reply) => {
    designer(request)
    const body = parse(variableCreate.strict(), request.body)
    return reply.code(201).send(await deps.variables.create(actorOf(request), body))
  })

  app.patch('/internal/design/variables/:id', async (request) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    const body = parse(variableUpdate.strict(), request.body)
    return deps.variables.update(actorOf(request), id, body)
  })

  app.delete('/internal/design/variables/:id', async (request, reply) => {
    designer(request)
    const { id } = parse(idParams, request.params)
    await deps.variables.remove(actorOf(request), id)
    return reply.code(204).send()
  })
}
