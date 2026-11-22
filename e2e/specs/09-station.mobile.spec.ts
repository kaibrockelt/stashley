// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { facts, signIn } from '../support/ui.ts'

// Criterion: a station helper records a stamp on a 375 px phone in under 10 s; a duplicate
// stamp is rejected with a clear message. (Project `mobile`.)
test('a helper stamps on a phone in under 10 seconds; a duplicate is refused', async ({ page }) => {
  // Someone whose last stamp is at station 2 and who reaches station 3 now.
  const [walker] = await sql<{ startnummer: number }>(
    `SELECT v.startnummer FROM v_streckenlage v JOIN station s ON s.id = v.station_id
      WHERE v.event_id = ? AND s.nummer = 2 AND v.im_ziel = 0 AND v.minuten_seit < 90
      ORDER BY v.startnummer LIMIT 1`,
    [facts().currentEventId],
  )
  const [station] = await sql<{ id: number }>(
    'SELECT id FROM station WHERE event_id = ? AND nummer = 3',
    [facts().currentEventId],
  )
  if (walker === undefined || station === undefined) throw new Error('demo data incomplete')

  await signIn(page, 'station')
  await page.goto(`/pages/station?f.station=${String(station.id)}`)
  const form = page.getByRole('region', { name: 'Stempel erfassen' })
  const number = form.getByRole('combobox', { name: 'Startnummer' })
  await expect(number).toBeVisible()
  await expect(form.getByRole('combobox', { name: 'Station' })).toHaveValue(/Mühlental/)
  await expectAccessible(page, 'station page at 375 px')
  const viewport = page.viewportSize()
  expect(viewport?.width).toBe(375)
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(375)

  const started = Date.now()
  await number.fill(String(walker.startnummer))
  await expect(number).toHaveValue(new RegExp(`^${String(walker.startnummer)} – `))
  await number.press('Enter')
  await expect(form.getByText('Saved.')).toBeVisible()
  expect(Date.now() - started).toBeLessThan(10_000)

  const table = page.getByRole('region', { name: 'Letzte Stempel' })
  await expect(
    table.getByRole('cell', { name: String(walker.startnummer), exact: true }),
  ).toBeVisible()

  await number.fill(String(walker.startnummer))
  await expect(number).toHaveValue(new RegExp(`^${String(walker.startnummer)} – `))
  await number.press('Enter')
  await expect(form.getByText('A record with these values already exists.')).toBeVisible()
  const [count] = await sql<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stempel st JOIN anmeldung a ON a.id = st.anmeldung_id
      WHERE a.startnummer = ? AND a.event_id = ? AND st.station_id = ?`,
    [walker.startnummer, facts().currentEventId, station.id],
  )
  expect(Number(count?.n)).toBe(1)
})
