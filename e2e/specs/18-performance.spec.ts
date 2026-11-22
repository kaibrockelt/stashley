// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test'
import { as } from '../support/ui.ts'

/**
 * First render of a page under 2 s on a 4G connection (§ Qualitätsanforderungen), measured in
 * Chromium with Chrome's "Fast 4G" profile: 9 Mbit/s down, 1.5 Mbit/s up, 165 ms round trip
 * (60 ms latency times Chrome's adjustment). The cache is empty for every load.
 */
const fast4g = {
  offline: false,
  downloadThroughput: (9 * 1024 * 1024) / 8,
  uploadThroughput: (1.5 * 1024 * 1024) / 8,
  latency: 165,
}

for (const [label, account, path, ready] of [
  ['sign-in page', null, '/sign-in', 'Sign in'],
  ['overview dashboard', 'kasse', '/pages/uebersicht', 'Anmeldungen'],
  ['registrations table page', 'orga', '/pages/anmeldungen', 'Anmeldungen'],
] as const) {
  test(`${label} renders within 2 s on 4G`, async ({ browser }) => {
    const { context, page } =
      account === null
        ? await (async () => {
            const created = await browser.newContext()
            return { context: created, page: await created.newPage() }
          })()
        : await as(browser, account)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Network.emulateNetworkConditions', fast4g)
    const started = Date.now()
    await page.goto(path)
    // Rendered: the page's heading or first block with its content is on screen.
    await expect(page.getByRole('heading', { name: ready }).first()).toBeVisible({
      timeout: 10_000,
    })
    const elapsed = Date.now() - started
    const paint = await page.evaluate(
      () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    )
    test.info().annotations.push({
      type: 'timing',
      description: `${label}: rendered after ${String(elapsed)} ms, first contentful paint ${String(Math.round(paint ?? -1))} ms`,
    })
    expect(elapsed).toBeLessThan(2000)
    await context.close()
  })
}
