// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEvent, ImpactItem, Query, QueryVersion } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { setupDemo } from '../../test/demo.ts'
import { createUser, problem, setupServer } from '../../test/setup.ts'

const offenePosten = (connectionId: string) => ({
  connectionId,
  name: 'Offene Posten',
  description: 'Registrations with an open amount',
  sql: `SELECT a.startnummer, p.nachname, v.offen
          FROM v_zahlungsstatus v
          JOIN anmeldung a ON a.id = v.anmeldung_id
          JOIN person p ON p.id = a.person_id
         WHERE v.event_id = :current_event_id AND v.offen > :mindestens
         ORDER BY v.offen DESC`,
  parameters: [
    { name: 'mindestens', type: 'decimal', list: false, required: false, defaultValue: '0' },
  ],
  cacheTtlSeconds: 300,
})

describe('query library', () => {
  it('stores validated SQL with its analysis and versions changes', async () => {
    const s = await setupServer()
    const demo = await setupDemo(s)
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
    await manager.send('POST', '/internal/design/variables', {
      name: 'current_event_id',
      type: 'integer',
      value: 14,
      description: '',
    })

    const created = await manager.send(
      'POST',
      '/internal/design/queries',
      offenePosten(demo.connectionId),
    )
    expect(created.statusCode).toBe(201)
    const query = created.json<Query>()
    expect(query).toMatchObject({ name: 'Offene Posten', latestVersion: 1, mode: 'sql' })
    expect(query.current.analysis).toMatchObject({
      objects: ['anmeldung', 'person', 'v_zahlungsstatus'],
      parameters: ['current_event_id', 'mindestens'],
      variables: ['current_event_id'],
      usesUserContext: false,
      dependencies: ['anmeldung', 'hotelbuchung', 'person', 'v_zahlungsstatus', 'zahlung'],
    })

    // Metadata changes keep the version; SQL changes add one.
    const renamed = await manager.send('PATCH', `/internal/design/queries/${query.id}`, {
      cacheTtlSeconds: 60,
    })
    expect(renamed.json<Query>()).toMatchObject({ latestVersion: 1, cacheTtlSeconds: 60 })
    const changed = await manager.send('PATCH', `/internal/design/queries/${query.id}`, {
      sql: 'SELECT COUNT(*) AS n FROM anmeldung WHERE event_id = :current_event_id',
      parameters: [],
    })
    expect(changed.json<Query>().latestVersion).toBe(2)
    const versions = await manager.request('GET', `/internal/design/queries/${query.id}/versions`)
    expect(versions.json<{ data: QueryVersion[] }>().data.map((entry) => entry.version)).toEqual([
      2, 1,
    ])
    const first = await manager.request('GET', `/internal/design/queries/${query.id}/versions/1`)
    expect(first.json<QueryVersion>().parameters[0]?.name).toBe('mindestens')
    expect(
      (await manager.request('GET', `/internal/design/queries/${query.id}/versions/9`)).statusCode,
    ).toBe(404)

    const audit = await s.admin.request('GET', '/internal/admin/audit?action=query.updated')
    expect(audit.json<{ data: AuditEvent[] }>().data[0]?.changes).toEqual({ version: [1, 2] })
    const listed = await manager.request(
      'GET',
      `/internal/design/queries?connectionId=${demo.connectionId}`,
    )
    expect(listed.json<{ data: Query[] }>().data).toHaveLength(1)

    // The variable is now in use and cannot be deleted.
    const variables = (await manager.request('GET', '/internal/design/variables')).json<{
      data: { id: string }[]
    }>()
    const deleteVariable = await manager.send(
      'DELETE',
      `/internal/design/variables/${variables.data[0]?.id ?? ''}`,
    )
    expect(problem(deleteVariable).code).toBe('in_use')

    expect((await manager.send('DELETE', `/internal/design/queries/${query.id}`)).statusCode).toBe(
      204,
    )
    expect((await manager.request('GET', `/internal/design/queries/${query.id}`)).statusCode).toBe(
      404,
    )
  })

  it('rejects writes, several statements and objects without table access', async () => {
    const s = await setupServer()
    const demo = await setupDemo(s)
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
    const save = (sql: string) =>
      manager.send('POST', '/internal/design/queries', {
        ...offenePosten(demo.connectionId),
        sql,
        parameters: [],
      })
    const cases: [string, string][] = [
      ['UPDATE anmeldung SET status = 1', 'not_select'],
      ['DROP TABLE anmeldung', 'not_select'],
      ['SELECT 1; SELECT 2', 'multiple_statements'],
      ['SELECT id FROM checkin', 'object_not_exposed'],
      ['SELECT id FROM ehrung', 'object_not_readable'],
      ['SELECT kontakt_email FROM hotel', 'excluded_column'],
      ['SELECT * FROM hotel', 'star_on_excluded'],
      ['SELECT user FROM mysql.user', 'system_schema'],
    ]
    for (const [sql, code] of cases) {
      const response = await save(sql)
      expect(response.statusCode, sql).toBe(422)
      expect(problem(response).errors?.[0], sql).toMatchObject({ field: 'sql', code })
    }
    const missing = await save('SELECT id FROM person WHERE land = :land')
    expect(problem(missing).errors).toEqual([
      { field: 'parameters', code: 'missing', params: { name: 'land' } },
    ])
    const unused = await manager.send('POST', '/internal/design/queries', {
      ...offenePosten(demo.connectionId),
      sql: 'SELECT id FROM person',
      parameters: [
        { name: 'x', type: 'string', list: false, required: false, defaultValue: 5 },
        {
          name: 'current_user_id',
          type: 'string',
          list: false,
          required: false,
          defaultValue: null,
        },
      ],
    })
    expect(problem(unused).errors).toEqual([
      { field: 'parameters.0.name', code: 'unused' },
      { field: 'parameters.0.defaultValue', code: 'invalid' },
      { field: 'parameters.1.name', code: 'server_value' },
    ])
    const validated = await manager.send('POST', '/internal/design/queries/validate', {
      connectionId: demo.connectionId,
      sql: 'SELECT id FROM anmeldung ORDER BY id LIMIT 5',
      parameters: [],
    })
    expect(validated.json()).toMatchObject({ limit: 'wrap', analysis: { objects: ['anmeldung'] } })
    // Nothing was saved and nothing reached a database.
    expect((await manager.request('GET', '/internal/design/queries')).json()).toEqual({ data: [] })
  })

  it('admits only managers and admins', async () => {
    const s = await setupServer()
    const demo = await setupDemo(s)
    const { client: user } = await createUser(s, 'uwe@example.com', 'user')
    expect(problem(await user.request('GET', '/internal/design/queries')).code).toBe('forbidden')
    expect(
      problem(await user.send('POST', '/internal/design/queries', offenePosten(demo.connectionId)))
        .code,
    ).toBe('forbidden')
    expect(
      problem(
        await user.send('POST', '/internal/design/queries/run', {
          connectionId: demo.connectionId,
          sql: 'SELECT 1',
          parameters: [],
          values: {},
        }),
      ).code,
    ).toBe('forbidden')
  })

  it('reports queries affected by schema changes', async () => {
    const s = await setupServer()
    const demo = await setupDemo(s)
    const created = await s.admin.send('POST', '/internal/design/queries', {
      ...offenePosten(demo.connectionId),
      sql: 'SELECT nachname FROM person',
      parameters: [],
    })
    const query = created.json<Query>()
    const impact = await (
      s.server.services.catalog as unknown as {
        impact(connectionId: string, diff: unknown): Promise<ImpactItem[]>
      }
    ).impact(demo.connectionId, {
      addedObjects: [],
      removedObjects: [],
      changedObjects: [
        {
          object: 'person',
          addedColumns: [],
          removedColumns: ['nachname'],
          changedColumns: [],
          keysChanged: false,
        },
      ],
    })
    expect(impact).toContainEqual({
      kind: 'query',
      id: query.id,
      label: 'Offene Posten',
      reason: 'column_removed',
    })
  })
})
