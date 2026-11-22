// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  type DemoFacts,
  type DemoRole,
  demoConfig,
  demoConnectionName,
  demoIds,
} from '@stashley/demo'
import type {
  ComponentResult,
  ConfigImportPlan,
  Connection,
  PageIssue,
  TableResult,
} from '@stashley/shared'
import type mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from '../src/app.ts'
import { TestClient } from '../src/test/client.ts'
import {
  connectDemo,
  loadDemoData,
  prepareDatabase,
  rootConnection,
  startServer,
  targets,
} from './support.ts'

/**
 * The demo scenario: its configuration imports into an instance with the demo database and
 * the scenario's figures show on its pages (§ Referenzszenario).
 */
describe.skipIf(targets.length === 0).each(targets)('demo scenario on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection
  let facts: DemoFacts
  const users = {} as Record<DemoRole, TestClient>
  const page = (slug: string) => demoIds.page(slug)

  async function user(email: string, roleKey: DemoRole): Promise<TestClient> {
    const invited = await admin.send('POST', '/internal/admin/users', {
      email,
      displayName: email,
      systemRole: 'user',
    })
    const { user: account, link } = invited.json<{ user: { id: string }; link: string }>()
    const client = new TestClient(server.app)
    await client.send('POST', '/internal/invitations/accept', {
      token: link.split('#').at(-1),
      password: `${email} long passphrase`,
    })
    await admin.send('PUT', `/internal/admin/users/${account.id}/roles`, {
      roleIds: [demoIds.role(roleKey)],
    })
    return client
  }

  const query = async <T = ComponentResult>(
    client: TestClient,
    slug: string,
    component: string,
    body: unknown = {},
  ) => {
    const response = await client.send(
      'POST',
      `/internal/pages/${page(slug)}/components/${component}/query`,
      body,
    )
    expect(response.statusCode, `${slug}/${component}: ${response.body}`).toBe(200)
    return response.json<T>()
  }

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    facts = await loadDemoData(root)
    ;({ server, admin } = await startServer())
    ;({ connection } = await connectDemo(admin, url, { name: demoConnectionName, timezone: 'UTC' }))
    const file = demoConfig()
    const connections = { [demoConnectionName]: connection.id }
    const plan = (
      await admin.send('POST', '/internal/admin/config/import/preview', { file, connections })
    ).json<ConfigImportPlan>()
    expect(
      plan.items.filter((item) => item.status === 'conflict'),
      'conflicts',
    ).toEqual([])
    const applied = await admin.send('POST', '/internal/admin/config/import', {
      file,
      connections,
      fingerprint: plan.fingerprint,
    })
    expect(applied.statusCode, applied.body).toBe(200)
    users.orga = await user('petra.krueger@example.com', 'orga')
    users.kasse = await user('jonas.weber@example.com', 'kasse')
    users.checkin = await user('aylin.demir@example.com', 'checkin')
    users.station = await user('helfer1@example.com', 'station')
    users.lindenhof = await user('rezeption@lindenhof.example.org', 'lindenhof')
    users.adler = await user('rezeption@berggasthof-adler.example.org', 'adler')
  })

  afterAll(async () => {
    await server.stop()
    await root.end()
  })

  it('imports without page errors', async () => {
    const issues = (await admin.request('GET', '/internal/design/issues')).json<{
      data: { pageId: string; issues: PageIssue[] }[]
    }>()
    const errors = JSON.stringify(issues.data).match(/"severity":"error"/g) ?? []
    expect(errors, JSON.stringify(issues.data)).toEqual([])
  })

  it('shows the figures of the scenario', async () => {
    const overview = await query(users.orga, 'uebersicht', 'anmeldungen')
    expect(Number(overview.rows[0]?.anmeldungen)).toBe(facts.registrations - facts.cancelled)
    expect(Number(overview.rows[0]?.bezahlt)).toBe(facts.paid)
    expect(Number(overview.rows[0]?.eingecheckt)).toBe(facts.checkedIn)
    expect(Number(overview.rows[0]?.im_ziel)).toBe(facts.atFinish)

    const candidates = await query(users.orga, 'ehrung', 'kandidaten')
    expect(candidates.rows).toHaveLength(facts.medalCandidates)

    const overdue = await query(users.orga, 'streckenlage', 'ueberfaellig')
    expect(overdue.rows).toHaveLength(facts.overdue)
    for (const entry of overdue.rows) expect(entry.telefon).toMatch(/^\+\d/)

    const open = await query(users.kasse, 'kasse', 'offene-posten')
    expect(open.rows).toHaveLength(facts.partlyPaid + facts.unpaid)
  })

  it('keeps each role to its pages', async () => {
    const navigation = async (client: TestClient) =>
      (await client.request('GET', '/internal/navigation')).json<{
        sections: { pages: { slug: string }[] }[]
        pages: { slug: string }[]
      }>()
    const slugs = async (client: TestClient) => {
      const nav = await navigation(client)
      return [...nav.sections.flatMap((section) => section.pages), ...(nav.pages ?? [])]
        .map((entry) => entry.slug)
        .sort()
    }
    expect(await slugs(users.lindenhof)).toEqual(['gaeste-lindenhof'])
    expect(await slugs(users.station)).toEqual(['station'])
    expect(await slugs(users.kasse)).toEqual(['anmeldungen', 'kasse', 'uebersicht'])
    expect(
      (
        await users.kasse.send(
          'POST',
          `/internal/pages/${page('streckenlage')}/components/ueberfaellig/query`,
          {},
        )
      ).statusCode,
    ).toBe(404)
    const lindenhof = await query<TableResult>(users.lindenhof, 'gaeste-lindenhof', 'gaeste')
    expect(lindenhof.rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(lindenhof.rows)).not.toContain('Adler')
  })

  it('updates the payment status at once and rejects a duplicate stamp', async () => {
    const [[pending]] = (await root.query(
      `SELECT z.anmeldung_id AS id, z.offen FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id
        WHERE a.event_id = ? AND a.status = 'angemeldet' AND z.status = 'teilbezahlt' ORDER BY a.id LIMIT 1`,
      [facts.currentEventId],
    )) as unknown as [{ id: number; offen: string }[]]
    const before = await query(users.kasse, 'uebersicht', 'bezahlt')
    const paid = await users.kasse.send(
      'POST',
      `/internal/pages/${page('kasse')}/components/zahlung/rows`,
      { values: { anmeldung_id: String(pending?.id), betrag: String(pending?.offen) } },
    )
    expect(paid.statusCode, paid.body).toBe(201)
    const after = await query(users.kasse, 'uebersicht', 'bezahlt')
    expect(Number(after.rows[0]?.bezahlt)).toBe(Number(before.rows[0]?.bezahlt) + 1)

    const [[walker]] = (await root.query(
      `SELECT s.anmeldung_id AS id, s.station_id AS station FROM stempel s JOIN station st ON st.id = s.station_id
        WHERE st.event_id = ? ORDER BY s.id DESC LIMIT 1`,
      [facts.currentEventId],
    )) as unknown as [{ id: number; station: number }[]]
    const duplicate = await users.station.send(
      'POST',
      `/internal/pages/${page('station')}/components/stempel/rows`,
      { values: { anmeldung_id: String(walker?.id), station_id: String(walker?.station) } },
    )
    expect(duplicate.statusCode, duplicate.body).toBe(409)
    expect(duplicate.json<{ code: string }>().code).toBe('unique_violation')
  })

  it('shows 2025 after the event variable is switched', async () => {
    const variables = (await admin.request('GET', '/internal/design/variables')).json<{
      data: { id: string; name: string }[]
    }>()
    const variable = variables.data.find((entry) => entry.name === 'current_event_id')
    await admin.send('PATCH', `/internal/design/variables/${variable?.id ?? ''}`, {
      value: facts.previousEventId,
    })
    const [[expected]] = (await root.query(
      "SELECT COUNT(*) AS n FROM anmeldung WHERE event_id = ? AND status = 'angemeldet'",
      [facts.previousEventId],
    )) as unknown as [{ n: number }[]]
    const overview = await query(users.orga, 'uebersicht', 'anmeldungen')
    expect(Number(overview.rows[0]?.anmeldungen)).toBe(Number(expected?.n))
    expect((await query(users.orga, 'ehrung', 'kandidaten')).rows).toHaveLength(0)
    await admin.send('PATCH', `/internal/design/variables/${variable?.id ?? ''}`, {
      value: facts.currentEventId,
    })
  })
})
