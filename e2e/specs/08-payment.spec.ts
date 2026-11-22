// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { as, facts } from '../support/ui.ts'

/** The number a metric block shows: the first line that is only a number. */
async function metric(page: Page, title: string): Promise<number> {
  const block = page.getByRole('region', { name: title, exact: true })
  await expect(block).toContainText(/\d/)
  const line = (await block.innerText())
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /^[\d.,\s]+$/.test(entry))
  return Number((line ?? '').replace(/[^\d]/g, ''))
}

// Criterion: after the cashier records a payment, the payment status on the check-in and
// overview pages updates immediately, without waiting for the cache to expire.
test('a recorded payment shows at once on check-in and overview', async ({ browser }) => {
  const [open] = await sql<{ id: number; startnummer: number; offen: string }>(
    `SELECT a.id, a.startnummer, z.offen FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id
      WHERE a.event_id = ? AND a.status = 'angemeldet' AND z.status = 'teilbezahlt'
      ORDER BY a.startnummer LIMIT 1`,
    [facts().currentEventId],
  )
  if (open === undefined) throw new Error('no partly paid registration in the demo data')

  const checkin = await as(browser, 'checkin')
  // Both pages are loaded first, so their results sit in the cache.
  await checkin.page.goto(`/pages/check-in?f.teilnehmer=${String(open.id)}`)
  const record = checkin.page.getByRole('region', { name: 'Teilnehmer', exact: true })
  await expect(record).toContainText('teilbezahlt')
  const kasse = await as(browser, 'kasse')
  await kasse.page.goto('/pages/uebersicht')
  const paidBefore = await metric(kasse.page, 'Bezahlt')

  await kasse.page.goto('/pages/kasse')
  const form = kasse.page.getByRole('region', { name: 'Zahlung erfassen' })
  await form.getByRole('combobox', { name: 'Anmeldung' }).fill(String(open.startnummer))
  // An exact start number is taken at once.
  await expect(form.getByRole('combobox', { name: 'Anmeldung' })).toHaveValue(
    new RegExp(`^${String(open.startnummer)} – `),
  )
  await form.getByRole('textbox', { name: 'Betrag' }).fill(open.offen)
  await expectAccessible(kasse.page, 'cashier page with a filled form')
  await form.getByRole('button', { name: 'Zahlung speichern' }).click()
  await expect(form.getByText('Saved.')).toBeVisible()

  await kasse.page.goto('/pages/uebersicht')
  expect(await metric(kasse.page, 'Bezahlt')).toBe(paidBefore + 1)
  await checkin.page.reload()
  await expect(record).toContainText('bezahlt')
  await expect(record).not.toContainText('teilbezahlt')
  await kasse.context.close()
  await checkin.context.close()
})
