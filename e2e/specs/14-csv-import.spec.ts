// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { as, choose, dialog, setChecked } from '../support/ui.ts'

/** A CSV file as Excel writes it on a German Windows: Windows-1252, semicolons, 01.03.2019. */
function windows1252(lines: string[]) {
  // Latin-1 and Windows-1252 agree on the umlauts used here.
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1')
}

async function upload(page: Page, name: string, content: Buffer) {
  await page.goto('/design/imports')
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'text/csv', buffer: content })
  await expect(page).toHaveURL(/\/design\/imports\/[0-9a-f-]+$/)
  await expect(page.getByRole('button', { name: /Encoding/ })).toContainText('Windows-1252')
  await expect(page.getByRole('button', { name: /Delimiter/ })).toContainText('Semicolon')
}

// Criterion: the admin creates a new table from a CSV file in Windows-1252 with semicolons and
// German dates, adding an id column. After the ceiling is adjusted, a second import upserts
// existing rows by email, and its dry run reports the faulty rows beforehand.
test('a new table from a German CSV file, then an upsert by email', async ({ browser }) => {
  test.setTimeout(240_000)
  const { context, page } = await as(browser, 'admin')

  await upload(
    page,
    'mitglieder.csv',
    windows1252([
      'Vorname;Nachname;Email;Eintritt;Beitrag',
      'Jürgen;Müller;juergen.mueller@example.org;01.03.2019;48,50',
      'Käthe;Schäfer;kaethe.schaefer@example.org;15.11.2021;24,00',
      'Søren;Nielsen;soeren.nielsen@example.org;02.01.2024;48,50',
    ]),
  )
  await expect(
    page
      .getByRole('button', { name: /Date format/ })
      .or(page.getByRole('textbox', { name: 'Date format' })),
  ).toBeVisible()
  await choose(page, 'Table', 'Create a new table …')
  await choose(page, 'Database', 'wanderverein')
  await page.getByRole('textbox', { name: 'Table name', exact: true }).fill('mitglieder')
  await choose(page, 'Primary key', 'Add a running number')
  await setChecked(page, 'email is unique', true)
  await setChecked(page, 'email is required', true)
  await expectAccessible(page, 'new table definition')
  await page.getByRole('button', { name: 'Save and check preview' }).first().click()
  await page.getByRole('button', { name: 'Dry run' }).click()
  await expect(page.getByText(/3 rows: 3 new, 0 updated, 0 unchanged, 0 faulty\./)).toBeVisible()
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByText(/Imported: 3 new/)).toBeVisible()
  const created = await sql<{ id: number; vorname: string; eintritt: Date; beitrag: string }>(
    'SELECT id, vorname, eintritt, beitrag FROM mitglieder ORDER BY id',
  )
  expect(created.map((row) => row.vorname)).toEqual(['Jürgen', 'Käthe', 'Søren'])
  expect(created[0]?.beitrag).toBe('48.50')

  // The new table is shared read-only; the admin raises its ceiling for the upsert.
  await page.goto('/admin/connections')
  await page.getByRole('link', { name: 'wanderverein' }).click()
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'mitglieder', exact: true }) })
    .getByRole('button', { name: 'Edit' })
    .click()
  const access = dialog(page, 'mitglieder')
  await setChecked(access, 'Create', true)
  await setChecked(access, 'Update', true)
  await access.getByRole('button', { name: 'Save' }).click()
  await expect(access).toBeHidden()

  await upload(
    page,
    'mitglieder-2026.csv',
    windows1252([
      'Vorname;Nachname;Email;Eintritt;Beitrag',
      'Jürgen;Müller;JUERGEN.MUELLER@example.org;01.03.2019;52,00',
      'Mette;Hansen;mette.hansen@example.org;12.06.2026;24,00',
      'Fehler;Datum;falsches.datum@example.org;31.02.2026;24,00',
    ]),
  )
  await choose(page, 'Table', 'mitglieder')
  await choose(page, 'Mode', 'Insert or update')
  await choose(page, 'Find existing rows by', 'email')
  await page.getByRole('button', { name: 'Save and check preview' }).first().click()
  await page.getByRole('button', { name: 'Dry run' }).click()
  await expect(page.getByText(/3 rows: 1 new, 1 updated, 0 unchanged, 1 faulty\./)).toBeVisible()
  await expect(page.getByText(/Line 4, eintritt:/)).toBeVisible()
  await expectAccessible(page, 'dry run with a faulty row')
  await setChecked(page, 'Skip faulty rows', true, 'switch')
  await page.getByRole('button', { name: 'Save and check preview' }).first().click()
  await page.getByRole('button', { name: 'Dry run' }).click()
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByText(/Imported: 1 new, 1 updated, 0 unchanged, 1 skipped\./)).toBeVisible()
  const [updated] = await sql<{ beitrag: string; n: number }>(
    "SELECT (SELECT beitrag FROM mitglieder WHERE email = 'juergen.mueller@example.org') AS beitrag, (SELECT COUNT(*) FROM mitglieder) AS n",
  )
  expect(updated).toMatchObject({ beitrag: '52.00', n: 4 })
  await context.close()
})
