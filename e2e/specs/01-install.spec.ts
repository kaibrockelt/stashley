// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test'
import { expectAccessible, visit } from '../support/axe.ts'
import { env } from '../support/env.ts'
import { signInWithForm } from '../support/ui.ts'

// Criterion: the instance installs from the image with the values of `.env.example`, and the
// first admin signs in. The environment starts both instances like `docker compose up`.
test('the first admin signs in', async ({ page }) => {
  const health = await page.request.get('/readyz')
  expect(health.status()).toBe(200)

  await visit(page, '/sign-in')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.locator('img[src="/brand/stashley-icon.svg"]').first()).toBeVisible()

  await signInWithForm(page, env.adminEmail, env.a.adminPassword)
  await expect(page.getByRole('navigation', { name: /./ })).toContainText('Databases')
  await expectAccessible(page, 'home of the first admin')

  // The account footer opens a menu with the profile, the about dialog and sign-out.
  const account = page.locator('aside button[aria-haspopup="true"]')
  await account.click()
  await expect(account).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menuitem')).toHaveText(['Profile', 'About', 'Sign out'])
  await expectAccessible(page, 'account menu')
  await page.keyboard.press('Escape')
  await expect(account).toHaveAttribute('aria-expanded', 'false')
  await expect(account).toBeFocused()

  await account.click()
  await page.getByRole('menuitem', { name: 'About' }).click()
  await expect(page.getByRole('dialog')).toContainText('GNU Affero General Public License')
  await expectAccessible(page, 'about dialog')
})
