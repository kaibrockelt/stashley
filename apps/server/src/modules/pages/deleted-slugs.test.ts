// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEvent, PageDetail } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { setupServer } from '../../test/setup.ts'

describe('deleted pages', () => {
  it('give their address free for a new page', async () => {
    const s = await setupServer()
    const create = () =>
      s.admin.send('POST', '/internal/design/pages', {
        sectionId: null,
        kind: 'dashboard',
        slug: 'uebersicht',
        title: 'Übersicht',
      })
    const first = await create()
    expect(first.statusCode).toBe(201)
    expect((await create()).statusCode).toBe(422)
    const removed = await s.admin.send(
      'DELETE',
      `/internal/design/pages/${first.json<PageDetail>().id}`,
    )
    expect(removed.statusCode).toBe(204)
    const second = await create()
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json<PageDetail>().slug).toBe('uebersicht')
    // The audit log keeps the address the deleted page had.
    const audit = await s.admin.request('GET', '/internal/admin/audit?action=page.deleted')
    expect(audit.json<{ data: AuditEvent[] }>().data[0]?.details).toEqual({ slug: 'uebersicht' })
  })
})
