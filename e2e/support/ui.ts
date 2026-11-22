// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DemoFacts } from '@stashley/demo'
import {
  type Browser,
  type BrowserContextOptions,
  type Cookie,
  expect,
  type Locator,
  type Page,
} from '@playwright/test'
import { Api } from './api.ts'
import { env, runDirectory, userPassword } from './env.ts'

/** The figures of the seeded data (written by the global setup). */
export function facts(): DemoFacts {
  return JSON.parse(readFileSync(path.join(runDirectory, 'facts.json'), 'utf8')) as DemoFacts
}

/** Test accounts of the scenario (§ Benutzer und Rollen) and the manager. */
export const accounts = {
  manager: { email: 'mia.manager@wanderverein.test', name: 'Mia Manager', role: null },
  orga: { email: 'petra.krueger@wanderverein.test', name: 'Petra Krüger', role: 'Orga' },
  orga2: { email: 'malte.jensen@wanderverein.test', name: 'Malte Jensen', role: 'Orga' },
  kasse: { email: 'jonas.weber@wanderverein.test', name: 'Jonas Weber', role: 'Kasse' },
  checkin: { email: 'aylin.demir@wanderverein.test', name: 'Aylin Demir', role: 'Check-in' },
  checkin2: { email: 'tobias.brandt@wanderverein.test', name: 'Tobias Brandt', role: 'Check-in' },
  station: { email: 'helfer1@wanderverein.test', name: 'Helfer 1', role: 'Station' },
  lindenhof: {
    email: 'rezeption@lindenhof.test',
    name: 'Rezeption Hotel Lindenhof',
    role: 'Hotel Lindenhof',
  },
  adler: {
    email: 'rezeption@berggasthof-adler.test',
    name: 'Rezeption Berggasthof Adler',
    role: 'Berggasthof Adler',
  },
} as const
export type Account = keyof typeof accounts

/** Signs in through the sign-in form. */
export async function signInWithForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/sign-in/)
}

/**
 * Signs a page in through the API; the page shares the session. Sessions are kept per account
 * and instance for the run, so the sign-in rate limit (per address) is not exhausted.
 */
export async function signIn(page: Page, account: Account | 'admin', base = env.a.base) {
  const api = Api.of(page, base)
  const file = path.join(runDirectory, `session-${account}-${new URL(base).port}.json`)
  if (existsSync(file)) {
    await page.context().addCookies(JSON.parse(readFileSync(file, 'utf8')) as Cookie[])
    await api.refresh()
    if (await api.signedIn()) return api
    await page.context().clearCookies()
  }
  if (account === 'admin') {
    await api.signIn(
      env.adminEmail,
      base === env.a.base ? env.a.adminPassword : env.b.adminPassword,
    )
  } else {
    await api.signIn(accounts[account].email, userPassword)
  }
  writeFileSync(file, JSON.stringify(await page.context().cookies(base)))
  return api
}

/** A fresh browser context signed in as an account, for specs that switch users. */
export async function as(
  browser: Browser,
  account: Account | 'admin',
  options: BrowserContextOptions = {},
) {
  const context = await browser.newContext({ baseURL: env.a.base, ...options })
  const page = await context.newPage()
  const api = await signIn(page, account)
  return { context, page, api }
}

/** The dialog with a title. */
export function dialog(page: Page, title: string | RegExp): Locator {
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title }) })
}

/**
 * Chooses an option of a React Aria select by its label. The select's button is named by its
 * current value followed by its label, so a string label is matched at the end.
 */
export async function choose(
  scope: Page | Locator,
  label: string | RegExp,
  option: string | RegExp,
) {
  const name =
    typeof label === 'string'
      ? new RegExp(`(^|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
      : label
  // Opened with the keyboard: a list that opens under the pointer would take the click's
  // release as a choice.
  const button = scope.getByRole('button', { name })
  await button.focus()
  await expect(button).toBeFocused()
  await button.press('Enter')
  const page = 'page' in scope ? scope.page() : scope
  await page.getByRole('option', { name: option }).click()
}

/**
 * Ticks or clears a checkbox or switch. React Aria hides the input inside its label, so the
 * label is what a user clicks.
 */
export async function setChecked(
  scope: Page | Locator,
  label: string,
  checked: boolean,
  role: 'checkbox' | 'switch' = 'checkbox',
) {
  const box = scope.getByRole(role, { name: label, exact: true })
  if ((await box.isChecked()) !== checked) await box.locator('xpath=ancestor::label[1]').click()
  await expect(box).toBeChecked({ checked })
}
