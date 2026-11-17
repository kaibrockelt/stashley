// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiTokenCreated, AuditEvent, ProblemDocument, TableAccess } from '@stashley/shared'
import type mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from '../src/app.ts'
import type { TestClient } from '../src/test/client.ts'
import {
  connectDemo,
  prepareDatabase,
  rootConnection,
  seedDemo,
  startServer,
  targets,
} from './support.ts'

/**
 * The public REST API against real servers (§16): tokens, endpoints, live reads with
 * filters and keyset pages, writes through the shared write path with `If-Match`, the
 * idempotent upsert, translated errors and the audit log with the token as actor.
 */
function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

describe.skipIf(targets.length === 0).each(targets)('public API on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let access: Map<string, TableAccess>
  const secrets: Record<string, string> = {}

  const table = (name: string) => access.get(name) as TableAccess

  const call = (
    secret: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    server.app.inject({
      method,
      url: `/api/v1/${path}`,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { payload: JSON.stringify(body) }),
    })

  async function expose(name: string, alias: string, operations: string[]) {
    const entry = table(name)
    const renamed = await admin.send('PUT', `/internal/admin/table-access/${entry.id}`, {
      ops: entry.ops,
      keyColumn: entry.keyColumn,
      displayTemplate: entry.displayTemplate,
      apiResource: alias,
      mcpEnabled: false,
      exclusions: entry.exclusions,
    })
    expect(renamed.statusCode, JSON.stringify(renamed.json())).toBe(200)
    const enabled = await admin.send('PUT', `/internal/admin/api/endpoints/${entry.id}`, {
      operations,
    })
    expect(enabled.statusCode, JSON.stringify(enabled.json())).toBe(200)
  }

  async function token(name: string, grants: [string, string[]][]) {
    const created = await admin.send('POST', '/internal/admin/api/tokens', {
      name,
      expiresAt: null,
      ipAllowlist: [],
      rateLimitPerMinute: 1000,
      grants: grants.flatMap(([object, operations]) =>
        operations.map((operation) => ({ tableAccessId: table(object).id, operation })),
      ),
    })
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201)
    secrets[name] = created.json<ApiTokenCreated>().secret
  }

  const audit = async (action: string) =>
    (
      await admin.request('GET', `/internal/admin/audit?action=${encodeURIComponent(action)}`)
    ).json<{ data: AuditEvent[] }>().data

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    ;({ server, admin } = await startServer())
    ;({ access } = await connectDemo(admin, url))
    await expose('zahlung', 'payments', ['list', 'get', 'create'])
    await expose('person', 'people', [
      'list',
      'get',
      'count',
      'schema',
      'create',
      'update',
      'replace',
      'upsert',
    ])
    await expose('hotel', 'hotels', ['list', 'get'])
    await expose('anmeldung', 'registrations', ['get', 'replace'])
    await expose('hotelbuchung', 'bookings', ['get', 'delete'])
    await expose('v_zahlungsstatus', 'payment-status', ['list', 'get', 'count'])
    await expose('v_medaille', 'medals', ['list'])
    await token('kasse', [['zahlung', ['create']]])
    await token('sync', [
      ['person', ['list', 'get', 'count', 'schema', 'create', 'update', 'replace', 'upsert']],
      ['hotel', ['list', 'get']],
      ['anmeldung', ['get', 'replace']],
      ['hotelbuchung', ['get', 'delete']],
      ['v_zahlungsstatus', ['list', 'get', 'count']],
      ['v_medaille', ['list']],
    ])
    await token('writer', [['person', ['update', 'upsert']]])
  })

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('writes with a create-only token, audits it with the token, and refuses list (§ Abnahme)', async () => {
    const created = await call(secrets.kasse as string, 'POST', 'payments', {
      anmeldung_id: 5,
      betrag: '28.00',
      eingang_am: '2026-04-20',
      verwendungszweck: 'Dubois 203',
    })
    expect(created.statusCode, created.body).toBe(201)
    // Without `get` or `list` the answer carries the key only.
    const key = created.json<{ id: string }>().id
    expect(created.json()).toEqual({ id: key })
    expect(created.headers.location).toBe(`/api/v1/payments/${key}`)
    expect(created.headers.etag).toBeUndefined()
    const [stored] = (await root.query(
      'SELECT betrag, verwendungszweck FROM zahlung WHERE id = ?',
      [key],
    )) as unknown as [{ betrag: string; verwendungszweck: string }[]]
    expect(stored[0]).toEqual({ betrag: '28.00', verwendungszweck: 'Dubois 203' })

    const event = (await audit('row.created')).find((entry) => entry.subjectId === String(key))
    expect(event).toMatchObject({
      actorKind: 'api_token',
      actorLabel: 'kasse',
      subjectLabel: `zahlung ${key}`,
    })
    // Decimals are recorded in their canonical form, as for forms.
    expect(event?.changes).toMatchObject({ betrag: [null, '28'] })

    const list = await call(secrets.kasse as string, 'GET', 'payments')
    expect(list.statusCode).toBe(403)
    expect(problem(list).code).toBe('forbidden')
  })

  it('lists with filters, one sort column, fields and keyset pages', async () => {
    const sync = secrets.sync as string
    const page = async (query: string) => {
      const response = await call(sync, 'GET', `people?${query}`)
      expect(response.statusCode, response.body).toBe(200)
      return response.json<{ data: Record<string, unknown>[]; next_cursor: string | null }>()
    }
    const first = await page('sort=-nachname&fields=id,nachname&limit=2')
    expect(first.data).toEqual([
      { id: '4', nachname: 'Nowak' },
      { id: '3', nachname: 'Dubois' },
    ])
    const second = await page(
      `sort=-nachname&fields=id,nachname&limit=2&cursor=${first.next_cursor}`,
    )
    expect(second.data.map((row) => row.nachname)).toEqual(['Carstens', 'Berg'])
    const third = await page(
      `sort=-nachname&fields=id,nachname&limit=2&cursor=${second.next_cursor}`,
    )
    expect(third.data.map((row) => row.nachname)).toEqual(['Berg'])
    expect(third.next_cursor).toBeNull()
    // A cursor belongs to its sort and filters.
    const reused = await call(sync, 'GET', `people?sort=vorname&cursor=${first.next_cursor}`)
    expect(reused.statusCode).toBe(400)

    expect((await page('filter[land][in]=DE,FR&fields=id')).data).toEqual([
      { id: '1' },
      { id: '3' },
      { id: '5' },
    ])
    expect((await page('filter[nachname][like]=B%25&fields=vorname')).data).toEqual([
      { vorname: 'Anna' },
      { vorname: 'Eva' },
    ])
    expect((await page('filter[telefon][null]=true&fields=id')).data).toEqual([
      { id: '2' },
      { id: '4' },
    ])
    expect((await page('filter[id][gte]=4&fields=id')).data).toEqual([{ id: '4' }, { id: '5' }])
    const all = await page('limit=1')
    expect(Object.keys(all.data[0] ?? {})).toEqual(
      expect.arrayContaining(['id', 'vorname', 'email', 'created_at', 'updated_at']),
    )
    const bad = await call(sync, 'GET', 'people?filter[id][gte]=many')
    expect(bad.statusCode).toBe(400)
    expect(problem(bad).errors).toEqual([{ field: 'filter[id][gte]', code: 'invalid' }])

    const count = await call(sync, 'GET', 'people/count?filter[land][eq]=DE')
    expect(count.json()).toEqual({ count: 2, approximate: false })
  })

  it('never returns excluded columns and reads views, also without a key', async () => {
    const sync = secrets.sync as string
    const hotels = await call(sync, 'GET', 'hotels')
    expect(hotels.statusCode).toBe(200)
    expect(hotels.body).not.toContain('kontakt_email')
    expect(hotels.body).not.toContain('info@lindenhof.example')

    const status = await call(sync, 'GET', 'payment-status/3')
    expect(status.statusCode, status.body).toBe(200)
    expect(status.json()).toMatchObject({ anmeldung_id: '3' })
    expect(status.headers.etag).toBeUndefined()

    const medals = await call(sync, 'GET', 'medals?limit=1')
    expect(medals.statusCode, medals.body).toBe(200)
    const body = medals.json<{ data: unknown[]; next_cursor: string | null }>()
    if (body.next_cursor !== null) {
      const next = await call(sync, 'GET', `medals?limit=1&cursor=${body.next_cursor}`)
      expect(next.statusCode).toBe(200)
      expect(next.json<{ data: unknown[] }>().data).not.toEqual(body.data)
    }
  })

  it('updates with If-Match and answers 412 when the row changed (D6, E17)', async () => {
    const sync = secrets.sync as string
    const read = await call(sync, 'GET', 'people/2')
    expect(read.statusCode).toBe(200)
    const etag = read.headers.etag as string
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/)

    const changed = await call(
      sync,
      'PATCH',
      'people/2',
      { telefon: '0170 2' },
      { 'if-match': etag },
    )
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json()).toMatchObject({ id: '2', telefon: '0170 2' })
    const next = changed.headers.etag as string
    expect(next).not.toBe(etag)

    const stale = await call(sync, 'PATCH', 'people/2', { telefon: '0170 9' }, { 'if-match': etag })
    expect(stale.statusCode).toBe(412)
    expect(problem(stale).code).toBe('precondition_failed')
    expect(problem(stale).current).toBeUndefined()

    // Without If-Match the update goes through; `*` only needs the row to exist.
    expect((await call(sync, 'PATCH', 'people/2', { land: 'DK' })).statusCode).toBe(200)
    expect(
      (await call(sync, 'PATCH', 'people/99', { land: 'DK' }, { 'if-match': '*' })).statusCode,
    ).toBe(404)
    // Version tokens of the UI and the API are not interchangeable.
    const ui = await call(sync, 'PATCH', 'people/2', { land: 'DE' }, { 'if-match': '"abc"' })
    expect(ui.statusCode).toBe(412)

    // The lock column and the key are not writable.
    const lock = await call(sync, 'PATCH', 'people/2', { updated_at: '2026-01-01T00:00:00Z' })
    expect(lock.statusCode).toBe(422)
    expect(problem(lock).errors).toEqual([{ field: 'updated_at', code: 'field_not_writable' }])

    // A token with update but without read gets the key only.
    const blind = await call(secrets.writer as string, 'PATCH', 'people/2', { land: 'DK' })
    expect(blind.statusCode).toBe(200)
    expect(blind.json()).toEqual({ id: '2' })
  })

  it('replaces every writable column with PUT /:id', async () => {
    const sync = secrets.sync as string
    const missing = await call(sync, 'PUT', 'people/3', { vorname: 'Chloé', nachname: 'Dubois' })
    expect(missing.statusCode).toBe(422)
    expect(
      problem(missing)
        .errors?.map((error) => error.field)
        .sort(),
    ).toEqual(['email', 'land'])

    const createdAt = async () =>
      ((await root.query('SELECT created_at FROM person WHERE id = 3')) as unknown as [
        { created_at: Date }[],
      ])[0][0]?.created_at
    const created = await createdAt()
    const body = { vorname: 'Chloé', nachname: 'Dubois', email: 'chloe@example.com', land: 'BE' }
    const replaced = await call(sync, 'PUT', 'people/3', body)
    expect(replaced.statusCode, replaced.body).toBe(200)
    // `telefon` was left out: it has no default, so it is now NULL. `created_at` has an
    // expression default and keeps its value.
    expect(replaced.json()).toMatchObject({ land: 'BE', telefon: null })
    expect(await createdAt()).toEqual(created)
    // An unchanged repeat writes nothing: same ETag, no audit entry.
    const updates = (await audit('row.updated')).length
    const repeated = await call(sync, 'PUT', 'people/3', body)
    expect(repeated.statusCode).toBe(200)
    expect(repeated.headers.etag).toBe(replaced.headers.etag)
    expect((await audit('row.updated')).length).toBe(updates)
    expect((await call(sync, 'PUT', 'people/99', { vorname: 'x' })).statusCode).toBe(422)
  })

  it('writes literal defaults as values on PUT /:id, so a repeat stays unchanged', async () => {
    const sync = secrets.sync as string
    const before = await call(sync, 'GET', 'registrations/1')
    expect(before.statusCode, before.body).toBe(200)
    const updates = (await audit('row.updated')).length
    // `ticket_typ` and `status` are left out and already hold their literal defaults;
    // `angemeldet_am` has an expression default and keeps its value.
    const replaced = await call(sync, 'PUT', 'registrations/1', {
      person_id: '1',
      event_id: '1',
      startnummer: 101,
      betrag_soll: '25.00',
    })
    expect(replaced.statusCode, replaced.body).toBe(200)
    expect(replaced.json()).toEqual(before.json())
    expect(replaced.headers.etag).toBe(before.headers.etag)
    expect((await audit('row.updated')).length).toBe(updates)
  })

  it('upserts idempotently on a unique key and writes nothing on unchanged repeats', async () => {
    const sync = secrets.sync as string
    const body = { vorname: 'Fatma', nachname: 'Yilmaz', email: 'fatma@example.com', land: 'TR' }
    const created = await call(sync, 'PUT', 'people?on=email', body)
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json<{ id: string }>().id
    const before = (await audit('row.updated')).length
    const repeated = await call(sync, 'PUT', 'people?on=email', body)
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json<{ id: string }>().id).toBe(id)
    expect((await audit('row.updated')).length).toBe(before)
    const changed = await call(sync, 'PUT', 'people?on=email', { ...body, land: 'DE' })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ id, land: 'DE' })
    const [rows] = (await root.query(
      "SELECT COUNT(*) AS n FROM person WHERE email = 'fatma@example.com'",
    )) as unknown as [{ n: number }[]]
    expect(Number(rows[0]?.n)).toBe(1)

    // The auto-increment key and columns that are not unique cannot be the upsert key.
    for (const on of ['id', 'land']) {
      const refused = await call(sync, 'PUT', `people?on=${on}`, body)
      expect(refused.statusCode).toBe(400)
      expect(problem(refused).errors).toEqual([{ field: 'on', code: 'upsert_key_invalid' }])
    }
    expect((await call(sync, 'PUT', 'people', body)).statusCode).toBe(400)
  })

  it('translates database errors by field', async () => {
    const sync = secrets.sync as string
    const duplicate = await call(sync, 'POST', 'people', {
      vorname: 'Anna',
      nachname: 'Berg',
      email: 'anna@example.com',
      land: 'DE',
    })
    expect(duplicate.statusCode).toBe(422)
    expect(problem(duplicate)).toMatchObject({
      code: 'unique_violation',
      errors: [{ field: 'email', code: 'unique_violation' }],
    })
    const reference = await call(secrets.kasse as string, 'POST', 'payments', {
      anmeldung_id: 999,
      betrag: '1.00',
      eingang_am: '2026-04-20',
    })
    expect(reference.statusCode).toBe(422)
    expect(problem(reference)).toMatchObject({
      code: 'foreign_key_violation',
      errors: [{ field: 'anmeldung_id', code: 'foreign_key_violation' }],
    })
    const long = await call(sync, 'PATCH', 'people/1', { land: 'DEU' })
    expect(long.statusCode).toBe(422)
    expect(problem(long).errors?.[0]).toMatchObject({ field: 'land' })
  })

  it('deletes with If-Match and audits the old values', async () => {
    const sync = secrets.sync as string
    const read = await call(sync, 'GET', 'bookings/2')
    expect(read.statusCode, read.body).toBe(200)
    const stale = await call(sync, 'DELETE', 'bookings/2', undefined, { 'if-match': '"stale"' })
    expect(stale.statusCode).toBe(412)
    const removed = await call(sync, 'DELETE', 'bookings/2', undefined, {
      'if-match': read.headers.etag as string,
    })
    expect(removed.statusCode, removed.body).toBe(204)
    expect((await call(sync, 'GET', 'bookings/2')).statusCode).toBe(404)
    const event = (await audit('row.deleted')).find(
      (entry) => entry.subjectLabel === 'hotelbuchung 2',
    )
    expect(event).toMatchObject({ actorKind: 'api_token', actorLabel: 'sync' })
  })
})
