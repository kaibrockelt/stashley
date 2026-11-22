// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test'
import { Api } from '../support/api.ts'
import { expectAccessible, visit } from '../support/axe.ts'
import { env, userPassword } from '../support/env.ts'
import { type Account, accounts, choose, dialog, setChecked, signIn } from '../support/ui.ts'

async function invite(page: Page, account: Account): Promise<string> {
  const { email, name } = accounts[account]
  await page.getByRole('button', { name: 'Invite user' }).click()
  const form = dialog(page, 'Invite user')
  await form.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
  if (account === 'manager') await choose(form, 'System role', 'Manager')
  await form.getByRole('button', { name: 'Invite', exact: true }).click()
  const link = await form.getByLabel('Invitation link').inputValue()
  await form.getByRole('button', { name: 'Done' }).click()
  return link
}

async function assignRole(page: Page, name: string, role: string) {
  await page.getByRole('button', { name, exact: true }).click()
  const form = dialog(page, name)
  await setChecked(form, role, true)
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toBeHidden()
}

// Criterion: the admin creates roles and test accounts; a first OIDC sign-in shows up as
// pending and is approved.
test('the admin creates roles and accounts and approves an OIDC sign-in', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000)
  await signIn(page, 'admin')

  await visit(page, '/design/roles')
  await page.getByRole('button', { name: 'New role' }).click()
  const roleForm = dialog(page, 'New role')
  await roleForm.getByRole('textbox', { name: 'Name', exact: true }).fill('Presse')
  await roleForm
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Pressestelle, nur Übersicht')
  await roleForm.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('cell', { name: 'Presse', exact: true })).toBeVisible()
  await expectAccessible(page, 'roles')

  await visit(page, '/admin/users')
  const links = new Map<Account, string>()
  for (const account of Object.keys(accounts) as Account[]) {
    if (account === 'checkin2') continue // signs in with OIDC below
    links.set(account, await invite(page, account))
    const role = accounts[account].role
    if (role !== null) await assignRole(page, accounts[account].name, role)
  }
  await expectAccessible(page, 'users')

  // One account is set up through the invitation page, the others through its API.
  const first = await browser.newContext({ baseURL: env.a.base })
  const invited = await first.newPage()
  await invited.goto(links.get('orga') ?? '')
  await expect(invited.getByRole('heading', { name: 'Set up your account' })).toBeVisible()
  await invited.getByLabel('New password').fill(userPassword)
  await invited.getByLabel('Confirm password').fill(userPassword)
  await expectAccessible(invited, 'invitation')
  await invited.getByRole('button', { name: 'Create account' }).click()
  await expect(invited.getByRole('link', { name: 'Übersicht', exact: true })).toBeVisible()
  await first.close()
  for (const [account, link] of links) {
    if (account === 'orga') continue
    const api = await Api.open(env.a.base)
    await api.json('POST', '/internal/invitations/accept', {
      token: link.split('#').at(-1),
      password: userPassword,
    })
  }

  // An identity provider, and a first sign-in through it.
  await visit(page, '/admin/identity-providers')
  await page.getByRole('button', { name: 'Add provider' }).click()
  const provider = dialog(page, 'Add provider')
  await provider.getByRole('textbox', { name: 'Name', exact: true }).fill('Vereins-Login')
  await provider.getByRole('textbox', { name: 'Identifier', exact: true }).fill('verein')
  await provider.getByRole('textbox', { name: 'Issuer URL', exact: true }).fill(env.oidcIssuer)
  await provider.getByRole('textbox', { name: 'Client ID', exact: true }).fill('stashley-e2e')
  await provider.getByLabel('Client secret', { exact: true }).fill('e2e-client-secret')
  await provider.getByRole('button', { name: 'Save' }).click()
  await expect(provider).toBeHidden()

  const oidc = await browser.newContext({ baseURL: env.a.base })
  const newcomer = await oidc.newPage()
  await newcomer.goto('/sign-in')
  await newcomer.getByRole('link', { name: 'Continue with Vereins-Login' }).click()
  // The mock provider's login form: any user name, the claims as JSON.
  await newcomer.locator('input[name="username"]').fill('tobias')
  await newcomer.locator('textarea[name="claims"]').fill(
    JSON.stringify({
      email: accounts.checkin2.email,
      email_verified: true,
      name: accounts.checkin2.name,
    }),
  )
  await newcomer.locator('input[type="submit"], button[type="submit"]').first().click()
  await expect(newcomer.getByRole('heading', { name: 'Approval pending' })).toBeVisible()
  await expectAccessible(newcomer, 'pending account')

  await page.goto('/admin/users')
  await choose(page, 'Status', 'Pending')
  await page.getByRole('button', { name: accounts.checkin2.name, exact: true }).click()
  const pending = dialog(page, accounts.checkin2.name)
  await setChecked(pending, 'Check-in', true)
  await pending.getByRole('button', { name: 'Save' }).click()
  await choose(page, 'Status', 'All')
  await page.getByRole('button', { name: accounts.checkin2.name, exact: true }).click()
  await dialog(page, accounts.checkin2.name).getByRole('button', { name: 'Approve' }).click()
  await expect(
    page.getByRole('row').filter({ hasText: accounts.checkin2.email }).getByText('Active'),
  ).toBeVisible()

  // Approval keeps the session: the newcomer continues without signing in again.
  await newcomer.goto('/')
  await expect(newcomer.getByRole('link', { name: 'Check-in', exact: true })).toBeVisible()
  await oidc.close()
})
