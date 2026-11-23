// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ConfigFile, ConfigImportPlan, PageDetail, Role } from '@stashley/shared'
import { v7 as uuidv7 } from 'uuid'
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
    // Refused before the body is read: a body above the limit is not even measured.
    const large = await manager.send('POST', '/internal/admin/config/import', {
      file: { padding: 'x'.repeat(21 * 1024 * 1024) },
      connections: {},
      fingerprint: '0'.repeat(64),
    })
    expect(problem(large).code).toBe('forbidden')
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

  const importFile = async (
    s: Awaited<ReturnType<typeof setupServer>>,
    file: ConfigFile,
    fingerprint?: string,
  ) => {
    const plan = (
      await s.admin.send('POST', '/internal/admin/config/import/preview', { file, connections: {} })
    ).json<ConfigImportPlan>()
    const applied = await s.admin.send('POST', '/internal/admin/config/import', {
      file,
      connections: {},
      fingerprint: fingerprint ?? plan.fingerprint,
    })
    return { plan, applied }
  }

  it('reports what a file has twice instead of failing', async () => {
    const s = await setupServer()
    const file = (await s.admin.request('GET', '/internal/admin/config/export')).json<ConfigFile>()
    file.roles = [
      { id: uuidv7(), name: 'Kasse', description: '', homePageId: null },
      { id: uuidv7(), name: 'kasse', description: '', homePageId: null },
    ]
    const { plan, applied } = await importFile(s, file)
    expect(plan.counts.conflict).toBe(2)
    expect(plan.items.flatMap((item) => item.conflicts.map((conflict) => conflict.code))).toEqual([
      'duplicate',
      'duplicate',
    ])
    expect(problem(applied).code).toBe('conflict')
  })

  it('brings back a page deleted on the target', async () => {
    const s = await setupServer()
    const page = (
      await s.admin.send('POST', '/internal/design/pages', {
        sectionId: null,
        kind: 'dashboard',
        slug: 'station',
        title: 'Station',
      })
    ).json<PageDetail>()
    const file = (await s.admin.request('GET', '/internal/admin/config/export')).json<ConfigFile>()
    expect((await s.admin.request('DELETE', `/internal/design/pages/${page.id}`)).statusCode).toBe(
      204,
    )
    const { plan, applied } = await importFile(s, file)
    expect(plan.items).toEqual([
      expect.objectContaining({ kind: 'page', status: 'new', restored: true, conflicts: [] }),
    ])
    expect(applied.statusCode, applied.body).toBe(200)
    const detail = (
      await s.admin.request('GET', `/internal/design/pages/${page.id}`)
    ).json<PageDetail>()
    expect(detail.slug).toBe('station')
    const again = (
      await s.admin.send('POST', '/internal/admin/config/import/preview', { file, connections: {} })
    ).json<ConfigImportPlan>()
    expect(again.counts).toEqual({ new: 0, changed: 0, unchanged: 1, conflict: 0 })
  })

  it('refuses a preview that no longer matches the target', async () => {
    const source = await setupServer()
    await source.admin.send('POST', '/internal/design/roles', {
      name: 'Kasse',
      description: 'Zahlungen',
      homePageId: null,
    })
    const file = (
      await source.admin.request('GET', '/internal/admin/config/export')
    ).json<ConfigFile>()
    const target = await setupServer()
    await importFile(target, file)
    const role = file.roles[0] as ConfigFile['roles'][number]
    const changed = structuredClone(file)
    ;(changed.roles[0] as ConfigFile['roles'][number]).description = 'Aus der Datei'
    const plan = (
      await target.admin.send('POST', '/internal/admin/config/import/preview', {
        file: changed,
        connections: {},
      })
    ).json<ConfigImportPlan>()
    expect(plan.counts.changed).toBe(1)
    // A manager edits the role after the preview; the status stays "changed".
    await target.admin.send('PATCH', `/internal/design/roles/${role.id}`, {
      description: 'Von Hand',
    })
    const { applied } = await importFile(target, changed, plan.fingerprint)
    expect(problem(applied).code).toBe('conflict')
    expect(applied.json<{ detail: string }>().detail).toBe('preview_outdated')
  })
})
