// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Connection, QueryResult, ReadScope, TableAccess } from '@stashley/shared'
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
 * The read user's scope against real servers (§9.4): the statements Stashley suggests are
 * valid on every engine, and afterwards the database itself refuses unexposed objects and
 * excluded columns, while exposed data reads as before.
 */
describe.skipIf(targets.length === 0).each(targets)('read scope on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection
  let access: Map<string, TableAccess>

  const scope = async () =>
    (
      await admin.request('GET', `/internal/admin/connections/${connection.id}/read-scope`)
    ).json<ReadScope>()
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
    expect(after.warnings).toEqual([])
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
})
