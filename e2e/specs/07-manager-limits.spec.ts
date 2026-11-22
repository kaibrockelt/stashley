// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { demoIds } from '@stashley/demo'
import type { PageDetail } from '@stashley/shared'
import { expect, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { as, choose, dialog } from '../support/ui.ts'

// Criterion: a manager cannot grant rights above a ceiling. Saving SQL with UPDATE, DROP,
// multiple statements or tables without table access is rejected.
test.describe('the limits of a manager', () => {
  test('SQL that writes, drops, chains or reads unshared tables is rejected', async ({
    browser,
  }) => {
    const { context, page } = await as(browser, 'manager')
    await page.goto('/design/queries/new')
    await choose(page, 'Build the query with', 'SQL editor')
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Nicht erlaubt')
    const editor = page.locator('.cm-content')
    const rejected: [string, RegExp][] = [
      ["UPDATE person SET land = 'DE'", /Only a single SELECT/],
      ['DROP TABLE person', /Only a single SELECT/],
      ['SELECT id FROM person; SELECT id FROM event', /Only one statement is allowed/],
      ['SELECT * FROM mysql.user', /System schemas/],
      ['SELECT * FROM interne_notizen', /not shared|does not exist/],
    ]
    for (const [statement, message] of rejected) {
      // The completion list may cover the editor; focus it without a pointer.
      await editor.focus()
      await page.keyboard.press('Escape')
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.press('Delete')
      await page.keyboard.type(statement)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText(message).first()).toBeVisible()
    }
    await expectAccessible(page, 'SQL editor with a rejected statement')
    await page.goto('/design/queries')
    await expect(page.getByText('Nicht erlaubt')).toHaveCount(0)
    await context.close()
  })

  test('rights stop at the ceiling, in the editor and through the API', async ({ browser }) => {
    const { context, page, api } = await as(browser, 'manager')
    await page.goto('/pages/ehrung')
    await page.getByRole('button', { name: 'Edit page' }).click()
    await page.getByRole('button', { name: 'Edit Ehrung erfassen' }).click()
    const block = dialog(page, /Ehrung erfassen/)
    const rights = block.getByRole('group', { name: 'Rights' })
    await expect(rights.getByRole('checkbox', { name: 'Create', exact: true })).toBeVisible()
    // The ceiling of ehrung is read and create: update and delete are not offered.
    await expect(rights.getByRole('checkbox', { name: 'Change', exact: true })).toHaveCount(0)
    await expect(rights.getByRole('checkbox', { name: /^Change/ })).toHaveCount(0)
    await expect(rights.getByRole('checkbox', { name: 'Delete', exact: true })).toHaveCount(0)
    await expectAccessible(page, 'block dialog with rights')
    await block.getByRole('button', { name: 'Cancel' }).click()

    // Saving a draft that grants more than the ceiling is refused.
    const pageId = demoIds.page('ehrung')
    const detail = await api.json<PageDetail>('GET', `/internal/design/pages/${pageId}`)
    const draft = structuredClone(detail.draft)
    // Widen Orga's grant on the awards table (read and create) by update and delete.
    const grant = draft.access.grants.find(
      (entry) => entry.principal === demoIds.role('orga') && entry.source.startsWith('table:'),
    )
    if (grant === undefined) throw new Error('the awards page has no table grant')
    grant.ops = ['create', 'update', 'delete']
    const saved = await api.send('PUT', `/internal/design/pages/${pageId}/draft`, draft, {
      'if-match': `"${String(detail.draftRevision)}"`,
    })
    expect(saved.status()).toBe(422)
    expect(await saved.text()).toContain('exceeds_ceiling')
    await context.close()
  })
})
