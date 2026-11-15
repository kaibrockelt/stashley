// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Connection, QueryResult, TableAccess, UserScope } from '@stashley/shared'
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
 * The scope of the read and the write user against real servers (§9.4): the statements
 * Stashley suggests are valid on every engine. Afterwards the database itself refuses
 * unexposed objects, excluded columns and writes above a ceiling, while exposed data reads
 * and writes as before.
 */
describe.skipIf(targets.length === 0).each(targets)('user scopes on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection
  let access: Map<string, TableAccess>

  const scope = async (purpose: 'read' | 'write' = 'read') =>
    (
      await admin.request('GET', `/internal/admin/connections/${connection.id}/${purpose}-scope`)
    ).json<UserScope>()
  const list = async () =>
    (
      await admin.request('GET', `/internal/admin/table-access?connectionId=${connection.id}`)
    ).json<{ data: TableAccess[] }>().data
  const run = (sql: string) =>
    admin.send('POST', '/internal/design/queries/run', {
      connectionId: connection.id,
      sql,
      parameters: [],
      values: {},
    })

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    await root.query('CREATE TABLE geheim (id INT PRIMARY KEY, wert VARCHAR(20))')
    await root.query("INSERT INTO geheim VALUES (1, 'vertraulich')")
    ;({ server, admin } = await startServer())
    ;({ connection, access } = await connectDemo(admin, url))
    const view = access.get('v_teilnahmen') as TableAccess
    const updated = await admin.send('PUT', `/internal/admin/table-access/${view.id}`, {
      ops: ['read'],
      keyColumn: 'person_id',
      displayTemplate: null,
      apiResource: view.apiResource,
      mcpEnabled: false,
      exclusions: [{ column: 'teilnahmen', scope: 'all' }],
    })
    expect(updated.statusCode, updated.body).toBe(200)
  }, 180_000)

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('limits the read user to the exposed objects and columns', async () => {
    const before = await scope()
    expect(before).toMatchObject({
      account: 'stashley_read@%',
      unexposedReadable: ['geheim'],
      excludedReadable: [
        { object: 'hotel', columns: ['kontakt_email'] },
        { object: 'v_teilnahmen', columns: ['teilnahmen'] },
      ],
      notes: [],
    })
    const hotel = (await list()).find((entry) => entry.objectName === 'hotel')
    expect(hotel?.warnings).toContainEqual({
      code: 'excluded_column_readable',
      columns: ['kontakt_email'],
    })
    // Before: only the SQL validation keeps the column out.
    expect((await run('SELECT wert FROM geheim')).statusCode).toBe(422)

    for (const statement of before.statements) await root.query(statement)
    // Schema privileges apply to new sessions.
    await server.services.pools.invalidate(connection.id)

    // The database refuses what is not exposed, also without Stashley's validation.
    const executor = server.services.executor
    for (const sql of [
      'SELECT kontakt_email FROM hotel',
      'SELECT wert FROM geheim',
      'SELECT teilnahmen FROM v_teilnahmen',
    ]) {
      await expect(executor.execute(connection.id, { sql, values: [] }), sql).rejects.toMatchObject(
        { code: 'target_permission_denied' },
      )
    }
    const exposed = await run('SELECT name FROM hotel ORDER BY id')
    expect(exposed.statusCode, exposed.body).toBe(200)
    expect(exposed.json<QueryResult>().rows).toEqual([
      { name: 'Lindenhof' },
      { name: 'Berggasthof Adler' },
    ])
    expect((await run('SELECT person_id FROM v_teilnahmen ORDER BY person_id')).statusCode).toBe(
      200,
    )

    // Grants and schema read again: nothing left to narrow, exclusions kept.
    expect(
      (await admin.send('POST', `/internal/admin/connections/${connection.id}/grants`)).statusCode,
    ).toBe(200)
    const refreshed = await admin.send(
      'POST',
      `/internal/admin/connections/${connection.id}/schema/refresh`,
    )
    expect(refreshed.statusCode, refreshed.body).toBe(200)
    expect(await scope()).toMatchObject({
      unexposedReadable: [],
      excludedReadable: [],
      statements: [],
      notes: [],
    })
    const after = (await list()).find((entry) => entry.objectName === 'hotel') as TableAccess
    // The write user is narrowed in the next test.
    expect(after.warnings).toEqual([
      { code: 'excluded_column_writable', columns: ['kontakt_email'] },
    ])
    expect(after.exclusions).toEqual([{ column: 'kontakt_email', scope: 'all' }])
    // Saving keeps the exclusion of the column the read user no longer sees.
    const saved = await admin.send('PUT', `/internal/admin/table-access/${after.id}`, {
      ops: after.ops,
      keyColumn: after.keyColumn,
      displayTemplate: null,
      apiResource: after.apiResource,
      mcpEnabled: false,
      exclusions: after.exclusions,
    })
    expect(saved.statusCode, saved.body).toBe(200)
  })

  // Runs after the read user was narrowed and the schema read again.
  it('limits the write user to the ceilings', async () => {
    const before = await scope('write')
    expect(before).toMatchObject({
      account: 'stashley_write@%',
      excludedReadable: [
        { object: 'hotel', columns: ['kontakt_email'] },
        { object: 'v_teilnahmen', columns: ['teilnahmen'] },
      ],
      notes: [],
    })
    expect(before.writableBeyondCeiling).toContainEqual({ object: 'checkin', ops: ['update'] })
    expect(before.writableBeyondCeiling).toContainEqual({
      object: 'v_zahlungsstatus',
      ops: ['create', 'update'],
    })
    expect(before.excludedWritable).toEqual([{ object: 'hotel', columns: ['kontakt_email'] }])
    const checkin = (await list()).find((entry) => entry.objectName === 'checkin')
    expect(checkin?.warnings).toContainEqual({ code: 'write_beyond_ceiling', ops: ['update'] })
    const hotel = (await list()).find((entry) => entry.objectName === 'hotel')
    expect(hotel?.warnings).toContainEqual({
      code: 'excluded_column_writable',
      columns: ['kontakt_email'],
    })
    expect(hotel?.writableColumns).toEqual({ create: null, update: null })

    for (const statement of before.statements) await root.query(statement)
    await server.services.pools.invalidate(connection.id)
    const resolved = await server.services.connections.resolve(connection.id)
    const writer = resolved.users.write
    if (writer === undefined) throw new Error('no write user')
    const asWriter = (sql: string) =>
      server.services.pools.run(connection.id, resolved.spec, writer, (session) =>
        session.query(sql),
      )

    // The database refuses writes above a ceiling, unexposed objects and excluded columns.
    for (const [sql, errno] of [
      ['UPDATE checkin SET anmeldung_id = anmeldung_id WHERE id = 0', 1142],
      ['DELETE FROM person WHERE id = 0', 1142],
      ["INSERT INTO geheim VALUES (2, 'x')", 1142],
      ['SELECT wert FROM geheim', 1142],
      ['SELECT kontakt_email FROM hotel', 1143],
      ['INSERT INTO v_zahlungsstatus (anmeldung_id) VALUES (1)', 1142],
      // Excluded columns can no longer be written either (E6).
      ["UPDATE hotel SET kontakt_email = 'x' WHERE id = 0", 1143],
      ["INSERT INTO hotel (name, ort, kontakt_email) VALUES ('Neu', 'Ort', 'x')", 1143],
    ] as const) {
      await expect(asWriter(sql), sql).rejects.toMatchObject({ errno })
    }
    // What the ceilings allow still works, including reads through a base filter's join.
    await asWriter("UPDATE person SET vorname = 'Anna' WHERE id = 1")
    await asWriter('DELETE FROM hotelbuchung WHERE id = 0')
    await asWriter('UPDATE hotel SET name = name, ort = ort WHERE id = 0')
    await asWriter("INSERT INTO hotel (name, ort) VALUES ('Neu', 'Ort')")
    await root.query("DELETE FROM hotel WHERE name = 'Neu'")
    await asWriter(
      'SELECT b.id FROM hotelbuchung b LEFT JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id WHERE k.hotel_id = 1',
    )

    expect(
      (await admin.send('POST', `/internal/admin/connections/${connection.id}/grants`)).statusCode,
    ).toBe(200)
    expect(await scope('write')).toMatchObject({
      unexposedReadable: [],
      excludedReadable: [],
      writableBeyondCeiling: [],
      statements: [],
      notes: [],
    })
    const after = (await list()).find((entry) => entry.objectName === 'checkin') as TableAccess
    expect(after.warnings).toEqual([])
    const narrowed = (await list()).find((entry) => entry.objectName === 'hotel') as TableAccess
    expect(narrowed.warnings).toEqual([])
    expect(narrowed.writableColumns).toEqual({
      create: ['id', 'name', 'ort'],
      update: ['id', 'name', 'ort'],
    })
  })
})
