// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { demoIds } from '@stashley/demo'
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.ts'
import { as, facts } from '../support/ui.ts'

const lindenhof = demoIds.page('gaeste-lindenhof')
const rows = (pageId: string, component: string) =>
  `/internal/pages/${pageId}/components/${component}/rows`

async function bookingOf(hotelId: number): Promise<string> {
  const [row] = await sql<{ id: number }>(
    `SELECT b.id FROM hotelbuchung b JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id
      WHERE k.hotel_id = ? AND k.event_id = ? ORDER BY b.id LIMIT 1`,
    [hotelId, facts().currentEventId],
  )
  return String(row?.id)
}

// Criterion: direct API calls outside a user's rights are rejected: a foreign component ID,
// extra payload fields, manipulated parameters. One hotel's front desk can neither read nor
// change the other hotel's bookings, even with a manipulated ID.
test.describe('direct API calls outside the rights', () => {
  test('a foreign component ID is not found', async ({ browser }) => {
    const { context, api } = await as(browser, 'lindenhof')
    // A component of another page, addressed through the own page and directly.
    for (const [pageId, component] of [
      [lindenhof, 'ueberfaellig'],
      [demoIds.page('kasse'), 'offene-posten'],
      [demoIds.page('gaeste-adler'), 'gaeste'],
    ] as const) {
      const response = await api.send(
        'POST',
        `/internal/pages/${pageId}/components/${component}/query`,
        {},
      )
      expect(response.status(), `${pageId}/${component}`).toBe(404)
    }
    await context.close()
  })

  test("the other hotel's bookings stay out of reach, even with their IDs", async ({ browser }) => {
    const { context, api } = await as(browser, 'lindenhof')
    const own = await bookingOf(1)
    const foreign = await bookingOf(2)
    expect((await api.send('GET', `${rows(lindenhof, 'gaeste')}/${own}/edit`)).status()).toBe(200)
    expect((await api.send('GET', `${rows(lindenhof, 'gaeste')}/${foreign}/edit`)).status()).toBe(
      404,
    )
    expect((await api.send('GET', `${rows(lindenhof, 'gaeste')}/${foreign}`)).status()).toBe(404)
    const changed = await api.send('PATCH', `${rows(lindenhof, 'gaeste')}/${foreign}`, {
      values: { eingecheckt_am: '2026-01-01T18:00:00Z' },
      version: 'x',
    })
    expect([404, 409]).toContain(changed.status())
    const [stored] = await sql<{ eingecheckt_am: Date | null }>(
      'SELECT eingecheckt_am FROM hotelbuchung WHERE id = ?',
      [foreign],
    )
    expect(stored?.eingecheckt_am?.toISOString().startsWith('2026-01-01')).not.toBe(true)

    // Nothing of hotel 2 in the own table, whatever the search says.
    const result = await api.json<{ rows: { key: unknown }[] }>(
      'POST',
      `/internal/pages/${lindenhof}/components/gaeste/query`,
      { search: '', pageSize: 500 },
    )
    const keys = new Set(result.rows.map((row) => String(row.key)))
    expect(keys.has(own)).toBe(true)
    expect(keys.has(foreign)).toBe(false)
    await context.close()
  })

  test('extra fields in a payload are rejected', async ({ browser }) => {
    const { context, api } = await as(browser, 'lindenhof')
    const own = await bookingOf(1)
    const current = await api.json<{ version: string }>(
      'GET',
      `${rows(lindenhof, 'gaeste')}/${own}/edit`,
    )
    const response = await api.send('PATCH', `${rows(lindenhof, 'gaeste')}/${own}`, {
      values: { eingecheckt_am: null, betrag_soll: '1.00' },
      version: current.version,
    })
    expect(response.status()).toBeGreaterThanOrEqual(400)
    expect(response.status()).toBeLessThan(500)
    const [stored] = await sql<{ betrag_soll: string }>(
      'SELECT betrag_soll FROM hotelbuchung WHERE id = ?',
      [own],
    )
    expect(stored?.betrag_soll).not.toBe('1.00')
    // An unknown property of the request itself is refused as well.
    const unknown = await api.send('POST', `/internal/pages/${lindenhof}/components/gaeste/query`, {
      table: 'hotelbuchung',
    })
    expect(unknown.status()).toBe(422)
    await context.close()
  })

  test('manipulated parameters are rejected', async ({ browser }) => {
    const { context, api } = await as(browser, 'station')
    const station = demoIds.page('station')
    // A cursor that was not issued by the server.
    const cursor = await api.send('POST', `/internal/pages/${station}/components/letzte/query`, {
      cursor: 'eyJrIjpbMV19.forged',
    })
    expect(cursor.status()).toBe(400)
    // A sort column the table does not have.
    const sort = await api.send('POST', `/internal/pages/${station}/components/letzte/query`, {
      sort: { columnId: 'telefon', direction: 'asc' },
    })
    expect(sort.status()).toBeGreaterThanOrEqual(400)
    expect(sort.status()).toBeLessThan(500)
    // A stamp for a registration outside the option list (a cancelled one).
    const [cancelled] = await sql<{ id: number }>(
      "SELECT id FROM anmeldung WHERE event_id = ? AND status = 'storniert' LIMIT 1",
      [facts().currentEventId],
    )
    const [stationId] = await sql<{ id: number }>(
      'SELECT id FROM station WHERE event_id = ? LIMIT 1',
      [facts().currentEventId],
    )
    const stamp = await api.send('POST', rows(station, 'stempel'), {
      values: { anmeldung_id: String(cancelled?.id), station_id: String(stationId?.id) },
    })
    expect(stamp.status()).toBe(422)
    expect((await stamp.json()) as { code: string }).toMatchObject({ code: 'value_not_allowed' })
    await context.close()
  })
})
