// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { as } from '../support/ui.ts'

/** Pages an admin can open; each is checked in German for untranslated keys. */
const paths = [
  '/pages/uebersicht',
  '/pages/anmeldungen',
  '/design/pages',
  '/design/queries',
  '/design/imports',
  '/design/roles',
  '/design/variables',
  '/admin/connections',
  '/admin/api',
  '/admin/users',
  '/admin/permissions',
  '/admin/identity-providers',
  '/admin/settings',
  '/admin/configuration',
  '/admin/audit',
  '/profile',
]

// Criterion: the UI is complete in English and German. The catalogs have the same keys (CI
// checks them); here the German UI is opened page by page: lang is set and no message ID
// shows instead of a text.
test('the UI is complete in German', async ({ browser }) => {
  const { context, page } = await as(browser, 'admin', { locale: 'de-DE' })
  for (const path of paths) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    const text = await page.locator('body').innerText()
    // Message IDs look like `admin.connections.title`: two dots, no spaces.
    expect(text, path).not.toMatch(/(^|\s)[a-z]+\.[a-z][a-zA-Z]*\.[a-zA-Z.]+(\s|$)/)
    await expectAccessible(page, `${path} in German`)
  }
  await page.goto('/admin/connections')
  await expect(page.getByRole('heading', { name: 'Datenbanken' })).toBeVisible()
  await context.close()
})

test('the UI is in English for English browsers', async ({ browser }) => {
  const { context, page } = await as(browser, 'admin', { locale: 'en-GB' })
  await page.goto('/admin/connections')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Databases' })).toBeVisible()
  await context.close()
})
