// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { as, choose, dialog, facts, setChecked } from '../support/ui.ts'

/**
 * Criterion: a manager builds the demo pages through the UI alone, checks each one with
 * preview as role and publishes it. The scenario's pages came in through the configuration
 * import (spec 03); here the manager builds them again by clicking, under their own address,
 * and the result must behave like the imported ones for the roles.
 */
const run = Date.now().toString(36)

async function newPage(
  page: Page,
  title: string,
  kind: 'Dashboard' | 'Table page',
  viewers: string[],
) {
  await page.goto('/design/pages')
  await page.getByRole('button', { name: 'New page' }).click()
  const form = dialog(page, 'New page')
  await form.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
  if (kind !== 'Dashboard') await choose(form, 'Type', kind)
  await form.getByRole('button', { name: 'Create and edit' }).click()
  await expect(page.getByRole('button', { name: 'Page settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Page settings' }).click()
  const settings = dialog(page, 'Page settings')
  for (const viewer of viewers) await setChecked(settings, viewer, true)
  return settings
}

/** The row of a form field or base filter column in the block dialog. */
function fieldRow(block: Locator, column: string) {
  return block
    .locator('div[class*="fieldRow"]')
    .filter({
      has: block.page().getByRole('button', { name: new RegExp(`(^|\\s)${column}( \\*)?$`) }),
    })
}

async function blockDialog(page: Page, type: string, title: string) {
  const block = dialog(page, 'New block')
  await choose(block, 'Block type', type)
  await block.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
  return block
}

async function apply(block: Locator) {
  await block.getByRole('button', { name: 'Apply' }).click()
  await expect(block).toBeHidden()
}

/** Saves the draft, checks it as a role in the preview, publishes it. */
async function saveCheckPublish(page: Page, role: string, check: (page: Page) => Promise<void>) {
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText(/Draft revision 2/)).toBeVisible()
  await page.getByRole('button', { name: 'Preview as role' }).click()
  await setChecked(page.getByRole('dialog'), role, true)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Show|Preview|Apply/ })
    .click()
  await check(page)
  await expectAccessible(page, `preview as ${role}`)
  await page.getByRole('button', { name: /Back to editing|Leave preview/ }).click()
  await page.getByRole('button', { name: 'Publish' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Published. Users now see this version.')).toBeVisible()
}

test.describe('a manager builds pages through the UI', () => {
  test('awards: a query table and a form with server-set defaults', async ({ browser }) => {
    const { context, page } = await as(browser, 'manager')
    const settings = await newPage(page, `Ehrung ${run}`, 'Dashboard', ['Orga'])
    await settings.getByRole('button', { name: 'Apply' }).click()

    await page.getByRole('button', { name: 'Add row' }).click()
    let block = await blockDialog(page, 'Table', 'Medaillenkandidaten')
    await choose(block, 'Data source', 'Query from the library')
    await choose(block, 'Query', 'Medaillenkandidaten')
    await setChecked(block, 'Read', true)
    await apply(block)

    await page.getByRole('button', { name: 'Add block' }).first().click()
    block = await blockDialog(page, 'Form', 'Ehrung erfassen')
    await choose(block, 'Table', 'ehrung')
    await choose(fieldRow(block, 'person_id'), 'person_id *', 'Input field')
    const event = fieldRow(block, 'event_id')
    await choose(event, 'event_id *', 'Input field')
    await choose(event, 'Default value', 'Variable current_event_id')
    await setChecked(event, 'Hidden', true)
    const kind = fieldRow(block, 'art')
    await choose(kind, 'art *', 'Input field')
    await choose(kind, 'Default value', 'Fixed value')
    await kind.getByRole('textbox', { name: 'Value' }).fill('medaille_10')
    await setChecked(kind, 'Hidden', true)
    await choose(fieldRow(block, 'uebergeben_am'), 'uebergeben_am', 'Automatic')
    await setChecked(block, 'Create', true)
    await expectAccessible(page, 'block dialog of a form')
    await apply(block)

    await saveCheckPublish(page, 'Orga', async (preview) => {
      const rows = preview
        .getByRole('region', { name: 'Medaillenkandidaten' })
        .getByRole('row')
        .filter({ has: preview.getByRole('cell') })
      await expect(rows).toHaveCount(facts().medalCandidates)
      await expect(preview.getByRole('region', { name: 'Ehrung erfassen' })).toBeVisible()
    })
    const slug = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    await context.close()

    // Orga records an award on the new page; event and kind come from the server.
    const orga = await as(browser, 'orga')
    await orga.page.goto(`/pages/${slug}`)
    const form = orga.page.getByRole('region', { name: 'Ehrung erfassen' })
    const [candidate] = await sql<{ nachname: string; vorname: string }>(
      `SELECT p.vorname, p.nachname FROM v_medaille m JOIN person p ON p.id = m.person_id
        WHERE m.event_id = ? AND m.kandidat = 1 ORDER BY p.nachname LIMIT 1`,
      [facts().currentEventId],
    )
    await form.getByRole('combobox', { name: /person_id/ }).fill(candidate?.nachname ?? '')
    await orga.page
      .getByRole('option', { name: `${candidate?.vorname} ${candidate?.nachname}` })
      .first()
      .click()
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form.getByText('Saved.')).toBeVisible()
    const [award] = await sql<{ event_id: number; art: string }>(
      'SELECT event_id, art FROM ehrung ORDER BY id DESC LIMIT 1',
    )
    expect(award).toMatchObject({ event_id: facts().currentEventId, art: 'medaille_10' })
    const [left] = await sql<{ n: number }>(
      'SELECT COUNT(*) AS n FROM v_medaille WHERE event_id = ? AND kandidat = 1',
      [facts().currentEventId],
    )
    await orga.page.reload()
    await expect(
      orga.page
        .getByRole('region', { name: 'Medaillenkandidaten' })
        .getByRole('row')
        .filter({ has: orga.page.getByRole('cell') }),
    ).toHaveCount(Number(left?.n))
    await orga.context.close()
  })
  test("a hotel's guest list: base filter over a relation, inline editing", async ({ browser }) => {
    const { context, page } = await as(browser, 'manager')
    const settings = await newPage(page, `Gäste ${run}`, 'Table page', ['Hotel Lindenhof'])
    await settings.getByRole('button', { name: 'Apply' }).click()
    await page.getByRole('button', { name: 'Set up table' }).click()
    const block = dialog(page, 'New block')
    await block.getByRole('textbox', { name: 'Title', exact: true }).fill('Gäste')
    await choose(block, 'Data source', 'Shared table or view')
    await choose(block, 'Table or view', 'hotelbuchung')
    const columns = block
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Columns$/ }) })
    for (const column of ['id', 'anmeldung_id', 'hotel_kontingent_id', 'betrag_soll']) {
      await setChecked(columns, column, false)
    }
    await choose(block, 'Add a linked column', 'anmeldung_id → anmeldung (display value)')
    const filter = block
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Base filter$/ }) })
    await filter.getByRole('button', { name: 'Add condition' }).click()
    await choose(filter, 'Column', 'hotel_kontingent_id → hotel_kontingent.hotel_id')
    await filter.getByRole('textbox', { name: 'Value', exact: true }).fill('1')
    await filter.getByRole('button', { name: 'Add condition' }).click()
    const second = filter.locator('div[class*="fieldRow"]').last()
    await choose(second, 'Column', 'hotel_kontingent_id → hotel_kontingent.event_id')
    await choose(second, 'Value from', 'Variable current_event_id')
    const editing = block
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Editing$/ }) })
    await setChecked(editing, 'Change', true)
    await setChecked(editing, 'Edit in a dialog', false)
    const fields = block
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Fields$/ }) })
    for (const column of [
      'anmeldung_id',
      'hotel_kontingent_id',
      'anreise',
      'abreise',
      'betrag_soll',
    ]) {
      await choose(fieldRow(fields, column), new RegExp(`(^|\\s)${column}( \\*)?$`), 'Not included')
    }
    await choose(fieldRow(fields, 'eingecheckt_am'), 'eingecheckt_am', 'Input field')
    const rights = block
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Rights$/ }) })
    await setChecked(rights, 'Read', true)
    await setChecked(rights, 'Change', true)
    await apply(block)
    const [own] = await sql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM hotelbuchung b JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id
        WHERE k.hotel_id = 1 AND k.event_id = ?`,
      [facts().currentEventId],
    )
    await saveCheckPublish(page, 'Hotel Lindenhof', async (preview) => {
      await expect(preview.getByText(`${String(own?.n)} rows`)).toBeVisible()
    })
    const slug = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    await context.close()

    // The front desk edits its own guests' check-in and nothing of the other hotel.
    const hotel = await as(browser, 'lindenhof')
    await hotel.page.goto(`/pages/${slug}`)
    await expect(hotel.page.getByText(`${String(own?.n)} rows`)).toBeVisible()
    const rendered = await hotel.api.json<{ id: string; table: { id: string } }>(
      'GET',
      `/internal/pages/${slug}`,
    )
    const rows = `/internal/pages/${rendered.id}/components/${rendered.table.id}/rows`
    const [mine] = await sql<{ id: number }>(
      `SELECT b.id FROM hotelbuchung b JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id
        WHERE k.hotel_id = 1 AND k.event_id = ? LIMIT 1`,
      [facts().currentEventId],
    )
    const [theirs] = await sql<{ id: number }>(
      `SELECT b.id FROM hotelbuchung b JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id
        WHERE k.hotel_id = 2 AND k.event_id = ? LIMIT 1`,
      [facts().currentEventId],
    )
    expect((await hotel.api.send('GET', `${rows}/${String(mine?.id)}/edit`)).status()).toBe(200)
    expect((await hotel.api.send('GET', `${rows}/${String(theirs?.id)}/edit`)).status()).toBe(404)
    await hotel.context.close()
  })
  test('overview: metric and chart from the suggested setup', async ({ browser }) => {
    const { context, page } = await as(browser, 'manager')
    const settings = await newPage(page, `Übersicht ${run}`, 'Dashboard', ['Kasse', 'Check-in'])
    await settings.getByRole('button', { name: 'Apply' }).click()
    const learn = async (block: Locator) => {
      // Imported queries learn their result columns on first use.
      const run = block.getByRole('button', { name: 'Run it once' })
      await run.click({ timeout: 2_000 }).catch(() => undefined)
      await expect(run).toBeHidden()
    }
    const rights = (block: Locator) =>
      block.locator('fieldset').filter({ has: page.locator('legend', { hasText: /^Rights$/ }) })

    await page.getByRole('button', { name: 'Add row' }).click()
    let block = await blockDialog(page, 'Metric', 'Anmeldungen')
    await choose(block, 'Query', 'Übersicht Kennzahlen')
    await learn(block)
    await choose(block, 'Value', 'anmeldungen')
    for (const role of ['Kasse', 'Check-in']) {
      await setChecked(
        rights(block)
          .locator('div')
          .filter({ hasText: new RegExp(`^${role}`) })
          .last(),
        'Read',
        true,
      )
    }
    await apply(block)

    await page.getByRole('button', { name: 'Add block' }).first().click()
    block = await blockDialog(page, 'Chart', 'Anmeldungen pro Woche')
    await choose(block, 'Query', 'Anmeldungen pro Woche')
    await learn(block)
    await block.getByRole('button', { name: 'Use the suggested setup' }).click()
    await expect(block.getByRole('button', { name: /(^|\s)Chart type$/ })).toContainText('Line')
    for (const role of ['Kasse', 'Check-in']) {
      await setChecked(
        rights(block)
          .locator('div')
          .filter({ hasText: new RegExp(`^${role}`) })
          .last(),
        'Read',
        true,
      )
    }
    await apply(block)

    await saveCheckPublish(page, 'Kasse', async (preview) => {
      await expect(preview.getByRole('region', { name: 'Anmeldungen', exact: true })).toContainText(
        String(facts().registrations - facts().cancelled),
      )
      await expect(preview.getByRole('region', { name: 'Anmeldungen pro Woche' })).toBeVisible()
    })
    await context.close()
  })
  test('station: a page filter feeds a form; start numbers are taken at once', async ({
    browser,
  }) => {
    const { context, page } = await as(browser, 'manager')
    const settings = await newPage(page, `Station ${run}`, 'Dashboard', ['Station'])
    await settings.getByRole('button', { name: 'Add selection' }).click()
    await settings.getByRole('textbox', { name: 'Label', exact: true }).fill('Station')
    await choose(settings, 'Options from query', 'Stationen')
    await choose(settings, 'Value column', 'id')
    await choose(settings, 'Label column', 'station')
    await expectAccessible(page, 'page settings with a filter')
    await settings.getByRole('button', { name: 'Apply' }).click()

    await page.getByRole('button', { name: 'Add row' }).click()
    const block = await blockDialog(page, 'Form', 'Stempel erfassen')
    await choose(block, 'Table', 'stempel')
    const station = fieldRow(block, 'station_id')
    await choose(station, 'station_id *', 'Input field')
    await choose(station, 'Default value', 'Page filter Station')
    const number = fieldRow(block, 'anmeldung_id')
    await choose(number, 'anmeldung_id *', 'Input field')
    await number.getByRole('textbox', { name: 'Label', exact: true }).fill('Startnummer')
    await choose(number, 'Also search by', 'startnummer')
    await choose(fieldRow(block, 'zeitpunkt'), 'zeitpunkt *', 'Automatic')
    await setChecked(block, 'Create', true)
    await apply(block)
    await saveCheckPublish(page, 'Station', async (preview) => {
      await expect(preview.getByRole('region', { name: 'Stempel erfassen' })).toBeVisible()
    })
    const slug = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    await context.close()

    const [walker] = await sql<{ startnummer: number }>(
      `SELECT v.startnummer FROM v_streckenlage v JOIN station s ON s.id = v.station_id
        WHERE v.event_id = ? AND s.nummer = 1 AND v.im_ziel = 0 ORDER BY v.startnummer DESC LIMIT 1`,
      [facts().currentEventId],
    )
    const helper = await as(browser, 'station')
    await helper.page.goto(`/pages/${slug}`)
    const filter = helper.page.getByRole('combobox', { name: 'Station' }).first()
    await filter.fill('Aussicht')
    await helper.page.getByRole('option', { name: /Aussichtsturm/ }).click()
    const form = helper.page.getByRole('region', { name: 'Stempel erfassen' })
    await expect(form.getByRole('combobox', { name: /station_id/ })).toHaveValue(/Aussichtsturm/)
    const field = form.getByRole('combobox', { name: /Startnummer/ })
    await field.fill(String(walker?.startnummer))
    await expect(field).toHaveValue(new RegExp(`^${String(walker?.startnummer)} – `))
    await field.press('Enter')
    await expect(form.getByText('Saved.')).toBeVisible()
    const [stamp] = await sql<{ name: string }>(
      `SELECT s.name FROM stempel st JOIN station s ON s.id = st.station_id JOIN anmeldung a ON a.id = st.anmeldung_id
        WHERE a.startnummer = ? AND a.event_id = ? ORDER BY st.id DESC LIMIT 1`,
      [walker?.startnummer, facts().currentEventId],
    )
    expect(stamp?.name).toBe('Aussichtsturm')
    await helper.context.close()
  })
})
