// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

/** WCAG 2.2 AA (§ Qualitätsanforderungen), checked with axe on every page a spec visits. */
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

export async function expectAccessible(page: Page, label = page.url()): Promise<void> {
  // Charts draw on a canvas and announce their data through their table view.
  const results = await new AxeBuilder({ page }).withTags(tags).exclude('canvas').analyze()
  const violations = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }))
  expect(violations, `accessibility of ${label}`).toEqual([])
}

/** Opens a path, waits until the client settled and checks accessibility. */
export async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
  await expectAccessible(page, path)
}
