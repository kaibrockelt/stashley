// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { expectAccessible, visit } from '../support/axe.ts'
import { runDirectory } from '../support/env.ts'
import { signIn } from '../support/ui.ts'

// The demo configuration (packages/demo) brings the scenario's roles, queries and pages. The
// manager criterion, building every page through the UI, has its own spec (17).
test('the admin imports the demo configuration', async ({ page }) => {
  await signIn(page, 'admin')
  await visit(page, '/admin/configuration')
  await page
    .locator('input[type="file"]')
    .setInputFiles(path.join(runDirectory, 'demo-config.json'))
  // The connection of the same name is mapped already.
  await expect(page.getByRole('button', { name: /Connection “wanderverein”/ })).toContainText(
    'wanderverein',
  )
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByText(/· 0 conflicts$/)).toBeVisible()
  await expectAccessible(page, 'import preview')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByText('Configuration imported.')).toBeVisible()

  await page.goto('/')
  const navigation = page.getByRole('navigation')
  for (const title of ['Übersicht', 'Kasse', 'Check-in', 'Station', 'Streckenlage', 'Ehrung']) {
    await expect(navigation.getByRole('link', { name: title, exact: true })).toBeVisible()
  }
})
