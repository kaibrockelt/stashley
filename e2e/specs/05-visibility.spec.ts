// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { demoIds } from '@stashley/demo'
import { expect, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { type Account, as } from '../support/ui.ts'

/** What each account must see: pages in the navigation, and per page the blocks shown and absent. */
const expected: Record<
  Exclude<Account, 'manager' | 'checkin2' | 'orga2'>,
  { pages: string[]; shown: Record<string, string[]>; absent: Record<string, string[]> }
> = {
  orga: {
    pages: [
      'Übersicht',
      'Anmeldungen',
      'Teilnehmer',
      'Kasse',
      'Check-in',
      'Station',
      'Streckenlage',
      'Ehrung',
      'Hotels',
    ],
    shown: {
      kasse: ['Offene Posten', 'Soll'],
      'check-in': ['Teilnehmer', 'Letzte Check-ins'],
      streckenlage: ['Überfällig (über 90 min ohne Stempel)'],
    },
    // Orga may read payments and correct check-ins, but records neither.
    absent: { kasse: ['Zahlung erfassen'], 'check-in': ['Check-in erfassen'] },
  },
  kasse: {
    pages: ['Übersicht', 'Anmeldungen', 'Kasse'],
    shown: { kasse: ['Zahlung erfassen', 'Offene Posten'], uebersicht: ['Bezahlt'] },
    absent: {},
  },
  checkin: {
    pages: ['Übersicht', 'Anmeldungen', 'Check-in'],
    shown: { 'check-in': ['Teilnehmer', 'Check-in erfassen', 'Letzte Check-ins'] },
    absent: {},
  },
  station: {
    pages: ['Station'],
    shown: { station: ['Stempel erfassen', 'Letzte Stempel'] },
    absent: {},
  },
  lindenhof: {
    pages: ['Gäste Hotel Lindenhof'],
    shown: { 'gaeste-lindenhof': [] },
    absent: {},
  },
  adler: {
    pages: ['Gäste Berggasthof Adler'],
    shown: { 'gaeste-adler': [] },
    absent: {},
  },
}

const allPages: Record<string, string> = {
  uebersicht: 'Übersicht',
  anmeldungen: 'Anmeldungen',
  teilnehmer: 'Teilnehmer',
  kasse: 'Kasse',
  hotels: 'Hotels',
  'check-in': 'Check-in',
  station: 'Station',
  streckenlage: 'Streckenlage',
  ehrung: 'Ehrung',
  'gaeste-lindenhof': 'Gäste Hotel Lindenhof',
  'gaeste-adler': 'Gäste Berggasthof Adler',
}

// Criterion: every test account sees exactly the pages and components of its roles; the
// others are absent from the HTML and the API responses.
for (const [account, spec] of Object.entries(expected)) {
  test(`${account} sees exactly its pages and components`, async ({ browser }) => {
    const { context, page, api } = await as(browser, account as Account)
    await page.goto('/')
    const navigation = page.getByRole('navigation')
    await expect(navigation.getByRole('link').first()).toBeVisible()
    for (const [slug, title] of Object.entries(allPages)) {
      const visible = spec.pages.includes(title)
      await expect(navigation.getByRole('link', { name: title, exact: true })).toHaveCount(
        visible ? 1 : 0,
      )
      // Pages outside the roles are not found, in the UI and the API.
      if (!visible) {
        const response = await api.send('GET', `/internal/pages/${slug}`)
        expect(response.status(), `${account} → ${slug}`).toBe(404)
      }
    }
    for (const [slug, blocks] of Object.entries(spec.shown)) {
      await page.goto(`/pages/${slug}`)
      await page.waitForLoadState('networkidle')
      for (const title of blocks) {
        await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible()
      }
      const html = await page.content()
      for (const title of spec.absent[slug] ?? [])
        expect(html, `${slug} for ${account}`).not.toContain(title)
      const rendered = await api.json<{ components?: { id: string }[] }>(
        'GET',
        `/internal/pages/${slug}`,
      )
      for (const title of spec.absent[slug] ?? []) {
        expect(JSON.stringify(rendered), `${slug} API for ${account}`).not.toContain(title)
      }
      await expectAccessible(page, `${slug} as ${account}`)
    }
    await context.close()
  })
}

test('a component of a page outside the roles is not found through the API', async ({
  browser,
}) => {
  const { context, api } = await as(browser, 'kasse')
  const response = await api.send(
    'POST',
    `/internal/pages/${demoIds.page('streckenlage')}/components/ueberfaellig/query`,
    {},
  )
  expect(response.status()).toBe(404)
  await context.close()
})
