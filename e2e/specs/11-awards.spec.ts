// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { as, dialog, facts } from '../support/ui.ts'

async function setEvent(page: Page, eventId: number) {
  await page.goto('/design/variables')
  await page.getByRole('button', { name: 'current_event_id', exact: true }).click()
  const form = dialog(page, 'current_event_id')
  await form.getByRole('textbox', { name: 'Value', exact: true }).fill(String(eventId))
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toBeHidden()
}

// Criterion: the awards page lists exactly the 12 medal candidates. After current_event_id is
// switched to the 2025 event, every event-related page shows 2025 data.
test('awards list the candidates and every page follows the event switch', async ({ browser }) => {
  const { context, page } = await as(browser, 'orga')
  const admin = await as(browser, 'admin')
  const candidates = () =>
    page
      .getByRole('region', { name: 'Medaillenkandidaten' })
      .getByRole('row')
      .filter({ has: page.getByRole('cell') })
  await page.goto('/pages/ehrung')
  await expect(candidates()).toHaveCount(facts().medalCandidates)
  await expectAccessible(page, 'awards')

  const [previous] = await sql<{ anmeldungen: number; alle: number; stempel: number }>(
    `SELECT (SELECT COUNT(*) FROM anmeldung WHERE event_id = ? AND status = 'angemeldet') AS anmeldungen,
            (SELECT COUNT(*) FROM anmeldung WHERE event_id = ?) AS alle,
            (SELECT COUNT(*) FROM stempel st JOIN station s ON s.id = st.station_id WHERE s.event_id = ?) AS stempel`,
    [facts().previousEventId, facts().previousEventId, facts().previousEventId],
  )
  try {
    await setEvent(admin.page, facts().previousEventId)
    await page.goto('/pages/uebersicht')
    await expect(page.getByRole('region', { name: 'Anmeldungen', exact: true })).toContainText(
      String(previous?.anmeldungen),
    )
    await page.goto('/pages/anmeldungen')
    // The table page shows every registration of the event, cancelled ones too.
    await expect(page.getByText(new RegExp(`^${String(previous?.alle)} rows$`))).toBeVisible()
    await page.goto('/pages/ehrung')
    await expect(page.getByRole('region', { name: 'Medaillenkandidaten' })).toContainText('No data')
    await page.goto('/pages/streckenlage')
    await expect(
      page.getByRole('region', { name: 'Überfällig (über 90 min ohne Stempel)' }),
    ).toContainText('No data')
  } finally {
    await setEvent(admin.page, facts().currentEventId)
  }
  await page.goto('/pages/ehrung')
  await expect(candidates()).toHaveCount(facts().medalCandidates)
  await admin.context.close()
  await context.close()
})
