// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AdminUser,
  AuditEvent,
  InstanceVariable,
  Role,
  SessionResponse,
} from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { createUser, problem, setupServer } from '../../test/setup.ts'

describe('roles', () => {
  it('are created by managers unless admins turned that off', async () => {
    const s = await setupServer()
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
    const { client: user } = await createUser(s, 'uwe@example.com', 'user')

    const created = await manager.send('POST', '/internal/design/roles', {
      name: 'Kasse',
      description: 'Payments',
      homePageId: null,
    })
    expect(created.statusCode).toBe(201)
    const role = created.json<Role>()
    expect(role).toMatchObject({ name: 'Kasse', position: 0, userCount: 0 })

    const duplicate = await manager.send('POST', '/internal/design/roles', {
      name: 'kasse',
      description: '',
      homePageId: null,
    })
    expect(problem(duplicate).errors).toEqual([{ field: 'name', code: 'taken' }])
    expect(problem(await user.request('GET', '/internal/design/roles')).code).toBe('forbidden')
    expect(
      problem(
        await user.send('POST', '/internal/design/roles', {
          name: 'X',
          description: '',
          homePageId: null,
        }),
      ).code,
    ).toBe('forbidden')

    const off = await s.admin.send('PATCH', '/internal/admin/settings', {
      managersCreateRoles: false,
    })
    expect(off.json()).toMatchObject({ managersCreateRoles: false })
    const blocked = await manager.send('POST', '/internal/design/roles', {
      name: 'Orga',
      description: '',
      homePageId: null,
    })
    expect(problem(blocked).code).toBe('forbidden')
    expect(
      problem(await manager.send('PATCH', `/internal/design/roles/${role.id}`, { name: 'Till' }))
        .code,
    ).toBe('forbidden')
    expect(problem(await manager.send('DELETE', `/internal/design/roles/${role.id}`)).code).toBe(
      'forbidden',
    )
    // Managers still list roles, for granting rights.
    const listed = await manager.request('GET', '/internal/design/roles')
    expect(listed.json<{ data: Role[] }>().data.map((entry) => entry.name)).toEqual(['Kasse'])

    const admin = await s.admin.send('POST', '/internal/design/roles', {
      name: 'Orga',
      description: '',
      homePageId: null,
    })
    expect(admin.json<Role>().position).toBe(1)
    const renamed = await s.admin.send('PATCH', `/internal/design/roles/${role.id}`, {
      name: 'Cashier',
    })
    expect(renamed.json<Role>().name).toBe('Cashier')
    expect((await s.admin.send('DELETE', `/internal/design/roles/${role.id}`)).statusCode).toBe(204)
  })

  it('are assigned to users by admins only, audited, and shown in the session', async () => {
    const s = await setupServer()
    const kasse = (
      await s.admin.send('POST', '/internal/design/roles', {
        name: 'Kasse',
        description: '',
        homePageId: null,
      })
    ).json<Role>()
    const orga = (
      await s.admin.send('POST', '/internal/design/roles', {
        name: 'Orga',
        description: '',
        homePageId: null,
      })
    ).json<Role>()
    const { user, client } = await createUser(s, 'jonas@example.com', 'user')
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')

    const denied = await manager.send('PUT', `/internal/admin/users/${user.id}/roles`, {
      roleIds: [kasse.id],
    })
    expect(problem(denied).code).toBe('forbidden')
    const unknown = await s.admin.send('PUT', `/internal/admin/users/${user.id}/roles`, {
      roleIds: [kasse.id, '01890000-0000-7000-8000-00000000ffff'],
    })
    expect(problem(unknown).errors).toEqual([{ field: 'roleIds.1', code: 'not_found' }])

    const assigned = await s.admin.send('PUT', `/internal/admin/users/${user.id}/roles`, {
      roleIds: [orga.id, kasse.id],
    })
    expect(assigned.json()).toEqual({ roleIds: [orga.id, kasse.id] })
    const session = (await client.request('GET', '/internal/session')).json<SessionResponse>()
    expect(session.user?.roles).toEqual([
      { id: kasse.id, name: 'Kasse' },
      { id: orga.id, name: 'Orga' },
    ])
    const listed = await s.admin.request('GET', `/internal/admin/users/${user.id}`)
    expect(listed.json<AdminUser>().roleIds).toEqual([kasse.id, orga.id])
    const roles = (await s.admin.request('GET', '/internal/design/roles')).json<{ data: Role[] }>()
    expect(roles.data.map((role) => role.userCount)).toEqual([1, 1])

    const audit = await s.admin.request('GET', '/internal/admin/audit?action=user.roles_changed')
    expect(audit.json<{ data: AuditEvent[] }>().data[0]?.changes).toEqual({
      roles: [[], ['Kasse', 'Orga']],
    })

    // Deleting a role removes its assignments.
    await s.admin.send('DELETE', `/internal/design/roles/${kasse.id}`)
    const after = (await client.request('GET', '/internal/session')).json<SessionResponse>()
    expect(after.user?.roles).toEqual([{ id: orga.id, name: 'Orga' }])
  })
})

describe('instance variables', () => {
  it('are typed, audited and keep their name', async () => {
    const s = await setupServer()
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
    const { client: user } = await createUser(s, 'uwe@example.com', 'user')
    const changed: string[] = []
    s.server.services.events.on('variable.changed', ({ name }) => changed.push(name))

    const created = await manager.send('POST', '/internal/design/variables', {
      name: 'current_event_id',
      type: 'integer',
      value: 14,
      description: 'Event of the current year',
    })
    expect(created.statusCode).toBe(201)
    const variable = created.json<InstanceVariable>()
    expect(variable).toMatchObject({ name: 'current_event_id', type: 'integer', value: 14 })
    expect(await s.server.services.variables.current()).toEqual(
      new Map([['current_event_id', { type: 'integer', value: 14 }]]),
    )

    const bad = await manager.send('POST', '/internal/design/variables', {
      name: 'cutoff',
      type: 'date',
      value: '2026-02-30',
      description: '',
    })
    expect(problem(bad).errors).toEqual([{ field: 'value', code: 'invalid' }])
    const reserved = await manager.send('POST', '/internal/design/variables', {
      name: 'current_user_id',
      type: 'integer',
      value: 1,
      description: '',
    })
    expect(problem(reserved).errors).toEqual([{ field: 'name', code: 'reserved' }])
    const rename = await manager.send('PATCH', `/internal/design/variables/${variable.id}`, {
      name: 'other',
    })
    expect(problem(rename).errors).toEqual([{ field: 'name', code: 'not_allowed' }])
    expect(problem(await user.request('GET', '/internal/design/variables')).code).toBe('forbidden')

    const updated = await manager.send('PATCH', `/internal/design/variables/${variable.id}`, {
      value: '13',
    })
    expect(updated.json<InstanceVariable>().value).toBe(13)
    expect(await s.server.services.variables.current()).toEqual(
      new Map([['current_event_id', { type: 'integer', value: 13 }]]),
    )
    const audit = await s.admin.request('GET', '/internal/admin/audit?action=variable.updated')
    expect(audit.json<{ data: AuditEvent[] }>().data[0]?.changes).toEqual({ value: [14, 13] })
    // A description change does not touch caches.
    await manager.send('PATCH', `/internal/design/variables/${variable.id}`, {
      description: 'Current event',
    })
    expect(changed).toEqual(['current_event_id', 'current_event_id'])

    s.server.services.variables.addUsage((name) => Promise.resolve(name === 'current_event_id'))
    const inUse = await manager.send('DELETE', `/internal/design/variables/${variable.id}`)
    expect(problem(inUse).code).toBe('in_use')
  })
})
