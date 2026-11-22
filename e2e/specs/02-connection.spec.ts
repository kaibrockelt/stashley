// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { demoCeilings, demoViewKeys } from '@stashley/demo'
import { expect, type Page, test } from '@playwright/test'
import { expectAccessible, visit } from '../support/axe.ts'
import { demoDatabase } from '../support/env.ts'
import { choose, dialog, setChecked, signIn } from '../support/ui.ts'

function userBlock(page: Page, title: string) {
  // The heading sits in the block's head; the fields are in the block around it.
  return dialog(page, /Add database|wanderverein/)
    .getByRole('heading', { name: title, exact: true })
    .locator('xpath=../..')
}

// Criterion: the admin connects the demo database, gets a warning for the deliberately
// over-privileged user and shares the tables with the scenario's ceilings.
test('the admin connects the demo database and shares its tables', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, 'admin')
  await visit(page, '/admin/connections')
  await page.getByRole('button', { name: 'Add database' }).click()
  const form = dialog(page, 'Add database')
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(demoDatabase.name)
  await form.getByRole('textbox', { name: 'Host', exact: true }).fill(demoDatabase.host)
  await form.getByRole('textbox', { name: 'Database', exact: true }).fill(demoDatabase.database)
  // The demo data is stored as UTC (packages/demo).
  await form.getByRole('textbox', { name: 'Time zone', exact: true }).fill('UTC')

  const read = userBlock(page, 'Read user')
  await read
    .getByRole('textbox', { name: 'User name', exact: true })
    .fill(demoDatabase.overPrivileged.username)
  await read.getByLabel('Password', { exact: true }).fill(demoDatabase.overPrivileged.password)
  await form.getByRole('button', { name: 'Test connection' }).click()
  const result = form.getByRole('heading', { name: 'Test result' }).locator('xpath=../..')
  await expect(result).toContainText('FILE on all databases')
  await expect(result).toContainText(/DROP on .*more than this user needs/)
  await expectAccessible(page, 'connection test with grant warnings')

  await read
    .getByRole('textbox', { name: 'User name', exact: true })
    .fill(demoDatabase.read.username)
  await read.getByLabel('Password', { exact: true }).fill(demoDatabase.read.password)
  for (const [title, user] of [
    ['Write user', demoDatabase.write],
    ['Schema user', demoDatabase.schema],
  ] as const) {
    const block = userBlock(page, title)
    await setChecked(block, 'Use this user', true, 'switch')
    await block.getByRole('textbox', { name: 'User name', exact: true }).fill(user.username)
    await block.getByLabel('Password', { exact: true }).fill(user.password)
  }
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: demoDatabase.name })).toBeVisible()

  const notRead = page.getByText('The schema has not been read yet.')
  if (await notRead.isVisible()) {
    await page.getByRole('button', { name: 'Read schema' }).click()
    await expect(notRead).toBeHidden()
  }
  await expectAccessible(page, 'connection page')

  const share = async (object: string, ops: string[], key: string | null | undefined) => {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: object, exact: true }) })
    await row.getByRole('button', { name: /Share|Edit/ }).click()
    const access = dialog(page, object)
    for (const op of ['Create', 'Update', 'Delete']) {
      if (key === undefined) await setChecked(access, op, ops.includes(op.toLowerCase()))
    }
    if (key !== undefined) {
      await choose(access, 'Key column', key === null ? /^None/ : new RegExp(`^${key}`))
    }
    await access.getByRole('button', { name: /^(Share|Save)$/ }).click()
    await expect(access).toBeHidden()
  }
  for (const [object, ops] of Object.entries(demoCeilings)) await share(object, ops, undefined)
  for (const [object, key] of Object.entries(demoViewKeys)) await share(object, ['read'], key)

  for (const object of [...Object.keys(demoCeilings), ...Object.keys(demoViewKeys)]) {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: object, exact: true }) })
    await expect(row.getByText('Read', { exact: true })).toBeVisible()
  }
  const ehrung = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'ehrung', exact: true }) })
  await expect(ehrung.getByText('Create', { exact: true })).toBeVisible()
  await expect(ehrung.getByText('Update', { exact: true })).toHaveCount(0)
})
