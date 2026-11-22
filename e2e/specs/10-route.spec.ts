// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { facts, signIn } from '../support/ui.ts'

// Criterion: the route status page shows the 3 overdue participants with their phone numbers.
test('route status lists the overdue participants with phone numbers', async ({ page }) => {
  await signIn(page, 'orga')
  await page.goto('/pages/streckenlage')
  const overdue = page.getByRole('region', { name: 'Überfällig (über 90 min ohne Stempel)' })
  const rows = overdue.getByRole('row').filter({ has: page.getByRole('cell') })
  await expect(rows).toHaveCount(facts().overdue)
  for (const row of await rows.all()) await expect(row).toContainText(/\+\d+ \d+ \d{7}/)
  await expect(page.getByRole('region', { name: 'Im Ziel', exact: true })).toContainText(
    String(facts().atFinish),
  )
  await expectAccessible(page, 'route status')
})
