// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { demoIds } from '@stashley/demo'
import { expect, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { as, facts } from '../support/ui.ts'

// Criterion: every write appears in the audit log with its old and new values: the payment
// of spec 08, a hotel's check-in of a guest and the event switch of spec 11.
test('writes appear in the audit log with old and new values', async ({ browser }) => {
  const [guest] = await sql<{ id: number }>(
    `SELECT b.id FROM hotelbuchung b JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id
      WHERE k.hotel_id = 1 AND k.event_id = ? AND b.eingecheckt_am IS NULL ORDER BY b.id LIMIT 1`,
    [facts().currentEventId],
  )
  const hotel = await as(browser, 'lindenhof')
  const rows = `/internal/pages/${demoIds.page('gaeste-lindenhof')}/components/gaeste/rows/${String(guest?.id)}`
  const current = await hotel.api.json<{ version: string }>('GET', `${rows}/edit`)
  await hotel.api.json('PATCH', rows, {
    values: { eingecheckt_am: '2026-05-08T18:30:00.000Z' },
    version: current.version,
  })
  await hotel.context.close()

  const { context, page } = await as(browser, 'admin')
  await page.goto('/admin/audit')
  const action = page.getByRole('textbox', { name: 'Action', exact: true })
  await action.fill('row.created')
  await expect(
    page.getByRole('row').filter({ hasText: /jonas/i }).filter({ hasText: 'row.created' }).first(),
  ).toContainText(/betrag: null → "\d+(\.\d+)?"/)
  await expectAccessible(page, 'audit log')

  await action.fill('row.updated')
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: /lindenhof/i })
      .filter({ hasText: 'row.updated' })
      .first(),
  ).toContainText(/eingecheckt_am: null → "2026-05-08/)

  await action.fill('variable.updated')
  await expect(page.getByRole('row').filter({ hasText: 'variable.updated' }).first()).toContainText(
    /value: \d+ → \d+/,
  )
  await context.close()
})
