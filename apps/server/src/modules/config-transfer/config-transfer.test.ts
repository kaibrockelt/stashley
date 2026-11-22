// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ConfigFile, ConfigImportPlan, Role } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { createUser, problem, setupServer } from '../../test/setup.ts'

describe('configuration transfer', () => {
  it('is for admins only', async () => {
    const s = await setupServer()
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
    expect(problem(await manager.request('GET', '/internal/admin/config/export')).code).toBe(
      'forbidden',
    )
    const file = (await s.admin.request('GET', '/internal/admin/config/export')).json<ConfigFile>()
    expect(
      problem(
        await manager.send('POST', '/internal/admin/config/import/preview', {
          file,
          connections: {},
        }),
      ).code,
    ).toBe('forbidden')
  })

  it('rejects files of another format', async () => {
    const s = await setupServer()
    const response = await s.admin.send('POST', '/internal/admin/config/import/preview', {
      file: { format: 'something-else' },
      connections: {},
    })
    expect(problem(response).code).toBe('validation_failed')
  })

  it('moves roles and variables between instances and detects names taken', async () => {
    const source = await setupServer()
    const role = (
      await source.admin.send('POST', '/internal/design/roles', {
        name: 'Kasse',
        description: 'Zahlungen',
        homePageId: null,
      })
    ).json<Role>()
    await source.admin.send('POST', '/internal/design/variables', {
      name: 'current_event_id',
      type: 'integer',
      value: 13,
      description: '',
    })
    const exported = await source.admin.request('GET', '/internal/admin/config/export')
    const file = exported.json<ConfigFile>()
    expect(file.roles).toEqual([
      { id: role.id, name: 'Kasse', description: 'Zahlungen', homePageId: null },
    ])

    const target = await setupServer()
    await target.admin.send('POST', '/internal/design/roles', {
      name: 'kasse',
      description: '',
      homePageId: null,
    })
    const preview = (
      await target.admin.send('POST', '/internal/admin/config/import/preview', {
        file,
        connections: {},
      })
    ).json<ConfigImportPlan>()
    expect(preview.items).toEqual([
      expect.objectContaining({ kind: 'variable', status: 'new' }),
      expect.objectContaining({
        kind: 'role',
        status: 'conflict',
        conflicts: [{ code: 'name_taken', detail: 'Kasse' }],
      }),
    ])

    const clean = await setupServer()
    const plan = (
      await clean.admin.send('POST', '/internal/admin/config/import/preview', {
        file,
        connections: {},
      })
    ).json<ConfigImportPlan>()
    expect(plan.counts).toEqual({ new: 2, changed: 0, unchanged: 0, conflict: 0 })
    const applied = await clean.admin.send('POST', '/internal/admin/config/import', {
      file,
      connections: {},
      fingerprint: plan.fingerprint,
    })
    expect(applied.statusCode).toBe(200)
    const roles = (await clean.admin.request('GET', '/internal/design/roles')).json<{
      data: Role[]
    }>()
    expect(roles.data.map((entry) => entry.id)).toEqual([role.id])
    const variables = (await clean.admin.request('GET', '/internal/design/variables')).json<{
      data: { name: string; value: unknown }[]
    }>()
    expect(variables.data).toEqual([
      expect.objectContaining({ name: 'current_event_id', value: 13 }),
    ])
  })
})
