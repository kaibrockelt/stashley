// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Connection, ProblemDocument, QueryResult } from '@stashley/shared'
import type mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from '../src/app.ts'
import { AppError } from '../src/platform/http/problem.ts'
import { maxPreparedStatements } from '../src/target/pools.ts'
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
 * Reads against real servers (M4): stored queries, parameters, read-only transactions,
 * timeouts, value encoding.
 */
function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

describe.skipIf(targets.length === 0).each(targets)('reads on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let connection: Connection

  const run = (sql: string, values: Record<string, unknown> = {}, parameters: unknown[] = []) =>
    admin.send('POST', '/internal/design/queries/run', {
      connectionId: connection.id,
      sql,
      parameters,
      values,
    })

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    ;({ server, admin } = await startServer())
    ;({ connection } = await connectDemo(admin, url))
    const variable = await admin.send('POST', '/internal/design/variables', {
      name: 'current_event_id',
      type: 'integer',
      value: 2,
      description: '',
    })
    expect(variable.statusCode).toBe(201)
  }, 120_000)

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('runs a test query with encoded values and the instance variable', async () => {
    const response = await run(
      `SELECT a.id, a.startnummer, p.nachname, a.betrag_soll, a.angemeldet_am, s.ist_ziel, a.status
         FROM anmeldung a JOIN person p ON p.id = a.person_id
         LEFT JOIN station s ON s.id = 0
        WHERE a.event_id = :current_event_id
        ORDER BY a.id`,
    )
    expect(response.statusCode).toBe(200)
    const result = response.json<QueryResult & { durationMs: number }>()
    expect(result.columns.map((column) => [column.name, column.kind, column.role])).toEqual([
      ['id', 'bigint', 'identifier'],
      ['startnummer', 'integer', 'measure'],
      ['nachname', 'string', 'category'],
      ['betrag_soll', 'decimal', 'measure'],
      ['angemeldet_am', 'datetime', 'time'],
      ['ist_ziel', 'boolean', 'category'],
      ['status', 'enum', 'category'],
    ])
    expect(result.rows.slice(0, 3)).toEqual([
      {
        id: '3',
        startnummer: 201,
        nachname: 'Berg',
        betrag_soll: '28.00',
        angemeldet_am: '2026-03-01T08:30:00Z',
        ist_ziel: null,
        status: 'angemeldet',
      },
      // Wall times on both sides of the switch to summer time (Europe/Berlin).
      expect.objectContaining({ id: '4', angemeldet_am: '2026-03-29T00:30:00Z' }),
      expect.objectContaining({ id: '5', angemeldet_am: '2026-03-29T01:30:00Z' }),
    ])
    expect(result.rows).toHaveLength(5)
    expect(result.truncated).toBe(false)
  })

  it('binds lists, date-times, limits and repeated names', async () => {
    const parameters = [
      { name: 'ids', type: 'integer', list: true, required: true, defaultValue: null },
      { name: 'ab', type: 'datetime', list: false, required: true, defaultValue: null },
      { name: 'n', type: 'integer', list: false, required: true, defaultValue: null },
    ]
    const response = await run(
      `SELECT id FROM anmeldung
        WHERE id IN (:ids) AND angemeldet_am >= :ab AND (id = :n OR id <> :n OR :n IS NULL)
        ORDER BY id LIMIT :n`,
      { ids: [1, 3, 4, 5, 7], ab: '2026-03-29T00:30:00Z', n: 2 },
      parameters,
    )
    expect(response.statusCode).toBe(200)
    // 00:30 UTC is 01:30 in Berlin, which is when registration 4 was made.
    expect(response.json<QueryResult>().rows).toEqual([{ id: '4' }, { id: '5' }])
    const empty = await run('SELECT id FROM anmeldung WHERE id IN (:ids)', { ids: [] }, [
      { name: 'ids', type: 'integer', list: true, required: false, defaultValue: null },
    ])
    expect(empty.json<QueryResult>().rows).toEqual([])
  })

  it('reads strings exactly as the validation saw them', async () => {
    const response = await run(
      "SELECT 'it''s' AS a, 'c\\\\d' AS b, \"dq\" AS c, 'x\\%' AS d, CONCAT('--', ' /* no comment */') AS e",
    )
    expect(response.json<QueryResult>().rows).toEqual([
      { a: "it's", b: 'c\\d', c: 'dq', d: 'x\\%', e: '-- /* no comment */' },
    ])
  })

  it('cuts results at the limit and keeps a query LIMIT inside', async () => {
    const many = await run(
      `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) SELECT i FROM n`,
    )
    const result = many.json<QueryResult>()
    expect(result.rows).toHaveLength(100)
    expect(result.truncated).toBe(true)
    const limited = await run('SELECT id FROM person ORDER BY id DESC LIMIT 2')
    expect(limited.json<QueryResult>().rows).toEqual([{ id: '5' }, { id: '4' }])
  })

  it('keeps a bounded number of prepared statements per connection', async () => {
    const count = async () => {
      const [[row]] = await root.query<mysql.RowDataPacket[]>(
        "SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'",
      )
      return Number(row?.Value)
    }
    const target = await server.services.executor.target(connection.id)
    const before = await count()
    // One session, so every statement lands on the same connection.
    const during = await server.services.pools.run(
      connection.id,
      target.spec,
      target.reader,
      async (session) => {
        for (let i = 0; i < maxPreparedStatements + 172; i++) {
          await session.execute(`SELECT ? + ${String(i)} AS n`, [1])
        }
        return count()
      },
    )
    expect(during - before).toBeLessThanOrEqual(maxPreparedStatements)
  })

  it('runs every read inside a read-only transaction', async () => {
    const executor = server.services.executor
    await expect(
      executor.execute(connection.id, {
        sql: "UPDATE person SET vorname = 'X' WHERE id = ?",
        values: [1],
      }),
    ).rejects.toBeInstanceOf(AppError)
    const target = await executor.target(connection.id)
    const flags = await server.services.pools.run(
      connection.id,
      target.spec,
      target.reader,
      async (session) => {
        await session.query('START TRANSACTION READ ONLY')
        // MariaDB before 11.1 knows only the older name.
        const variable = await session
          .query<{ ro: number }>('SELECT @@SESSION.transaction_read_only AS ro')
          .catch(() => session.query<{ ro: number }>('SELECT @@SESSION.tx_read_only AS ro'))
        await session.query('COMMIT')
        return variable[0]
      },
    )
    expect(Number(flags?.ro)).toBe(1)
    const [[person]] = await root.query<mysql.RowDataPacket[]>(
      'SELECT vorname FROM person WHERE id = 1',
    )
    expect(person?.vorname).toBe('Anna')
  })

  it('reads without ANSI_QUOTES and NO_BACKSLASH_ESCAPES even if the server sets them', async () => {
    const [[before]] = await root.query<mysql.RowDataPacket[]>('SELECT @@GLOBAL.sql_mode AS mode')
    const original = String(before?.mode ?? '')
    await root.query(
      `SET GLOBAL sql_mode = CONCAT_WS(',', NULLIF(@@GLOBAL.sql_mode, ''), 'ANSI_QUOTES,NO_BACKSLASH_ESCAPES')`,
    )
    try {
      await server.services.pools.invalidate(connection.id)
      const response = await run('SELECT "dq" AS a, \'c\\\\d\' AS b')
      expect(response.json<QueryResult>().rows).toEqual([{ a: 'dq', b: 'c\\d' }])
    } finally {
      await root.query('SET GLOBAL sql_mode = ?', [original])
      await server.services.pools.invalidate(connection.id)
    }
  })

  it('stops statements at the timeout, also when the server does not', async () => {
    const heavy =
      'SELECT COUNT(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c, information_schema.columns d'
    const target = await server.services.executor.target(connection.id)
    const spec = { ...target.spec, queryTimeoutMs: 1000 }
    // The server's own timeout.
    const serverSide = server.services.pools.run(connection.id, spec, target.reader, (session) =>
      session.execute(heavy, []),
    )
    const failure = await serverSide.catch((error: unknown) => error)
    expect([1969, 3024, 1317]).toContain((failure as { errno: number }).errno)

    // With the server timeout turned off, the client sends KILL QUERY after 1 s + 2 s.
    const started = Date.now()
    const killed = await server.services.pools
      .run(`${connection.id}:kill`, spec, target.reader, async (session) => {
        await session.query(
          session.engine === 'mariadb'
            ? 'SET SESSION max_statement_time = 0'
            : 'SET SESSION max_execution_time = 0',
        )
        return session.execute(heavy, [])
      })
      .catch((error: unknown) => error)
    expect(killed).toMatchObject({ failure: 'timeout', errno: 1317 })
    expect(Date.now() - started).toBeLessThan(15_000)
    await server.services.pools.invalidate(`${connection.id}:kill`)
  })

  it('translates database errors into stable codes', async () => {
    const response = await run('SELECT id FROM person WHERE id = (SELECT id FROM person)')
    expect(response.statusCode).toBe(422)
    expect(problem(response)).toMatchObject({
      code: 'query_failed',
      errors: [{ field: 'sql', code: 'query_failed', params: { errno: 1242 } }],
    })
    expect(JSON.stringify(problem(response))).not.toMatch(/subquery/i)
  })
})
