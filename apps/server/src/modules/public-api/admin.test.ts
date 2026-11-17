// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiEndpointState,
  ApiToken,
  ApiTokenCreated,
  AuditEvent,
  TableAccess,
} from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { storeSnapshot } from '../../test/connections.ts'
import { demoObjects, setupDemo } from '../../test/demo.ts'
import { createUser, problem, setupServer, type TestSetup } from '../../test/setup.ts'
import { addressAllowed, generateToken, hashToken, tokenPrefix, wellFormed } from './tokens.ts'

async function setup() {
  const s = await setupServer()
  const demo = await setupDemo(s)
  const zahlung = demo.access.get('zahlung') as TableAccess
  return { s, demo, zahlung }
}

function accessBody(access: TableAccess, fields: Record<string, unknown> = {}) {
  return {
    ops: access.ops,
    keyColumn: access.keyColumn,
    displayTemplate: access.displayTemplate,
    apiResource: access.apiResource,
    mcpEnabled: access.mcpEnabled,
    exclusions: access.exclusions,
    ...fields,
  }
}

async function endpoints(s: TestSetup, tableAccessId: string): Promise<ApiEndpointState> {
  const list = (await s.admin.request('GET', '/internal/admin/api/endpoints')).json<{
    data: ApiEndpointState[]
  }>().data
  return list.find((entry) => entry.tableAccessId === tableAccessId) as ApiEndpointState
}

/** `zahlung` as `payments` with list, get and create enabled. */
async function enablePayments(s: TestSetup, zahlung: TableAccess) {
  const renamed = await s.admin.send(
    'PUT',
    `/internal/admin/table-access/${zahlung.id}`,
    accessBody(zahlung, { apiResource: 'payments' }),
  )
  expect(renamed.statusCode).toBe(200)
  const enabled = await s.admin.send('PUT', `/internal/admin/api/endpoints/${zahlung.id}`, {
    operations: ['list', 'get', 'create'],
  })
  expect(enabled.statusCode).toBe(200)
  return renamed.json<TableAccess>()
}

async function createToken(s: TestSetup, grants: { tableAccessId: string; operation: string }[]) {
  const created = await s.admin.send('POST', '/internal/admin/api/tokens', {
    name: 'Kassen-Export',
    expiresAt: null,
    ipAllowlist: [],
    rateLimitPerMinute: 60,
    grants,
  })
  expect(created.statusCode).toBe(201)
  return created.json<ApiTokenCreated>()
}

describe('token format', () => {
  it('has a prefix and a checksum that catches typos', () => {
    const token = generateToken()
    expect(token.startsWith(tokenPrefix)).toBe(true)
    expect(token).toHaveLength(tokenPrefix.length + 49)
    expect(wellFormed(token)).toBe(true)
    const last = token.at(-8) === 'a' ? 'b' : 'a'
    expect(wellFormed(`${token.slice(0, -8)}${last}${token.slice(-7)}`)).toBe(false)
    expect(wellFormed(`${token}x`)).toBe(false)
    expect(wellFormed('stl_mcp_' + token.slice(tokenPrefix.length))).toBe(false)
    expect(new Set(Array.from({ length: 50 }, generateToken)).size).toBe(50)
    expect(hashToken(token)).not.toContain(token.slice(tokenPrefix.length, 20))
  })

  it('checks addresses against the allowlist', () => {
    expect(addressAllowed([], '203.0.113.7')).toBe(true)
    expect(addressAllowed(['203.0.113.0/24'], '203.0.113.7')).toBe(true)
    expect(addressAllowed(['203.0.113.0/24'], '::ffff:203.0.113.7')).toBe(true)
    expect(addressAllowed(['::ffff:203.0.113.0/120'], '203.0.113.7')).toBe(true)
    expect(addressAllowed(['203.0.113.0/24'], '198.51.100.1')).toBe(false)
    expect(addressAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true)
    expect(addressAllowed(['2001:db8::/32'], '203.0.113.7')).toBe(false)
    expect(addressAllowed(['198.51.100.1'], '198.51.100.1')).toBe(true)
    expect(addressAllowed(['198.51.100.1'], 'not an address')).toBe(false)
  })
})

describe('API endpoints', () => {
  it('open only once the alias hides the table name, and only within the ceiling', async () => {
    const { s, zahlung } = await setup()
    const before = await endpoints(s, zahlung.id)
    expect(before.blockers).toEqual(['alias_is_object_name'])
    expect(before.available).toEqual([
      'list',
      'get',
      'count',
      'schema',
      'create',
      'update',
      'replace',
      'upsert',
    ])
    const refused = await s.admin.send('PUT', `/internal/admin/api/endpoints/${zahlung.id}`, {
      operations: ['list'],
    })
    expect(refused.statusCode).toBe(422)
    expect(problem(refused).errors).toEqual([{ field: 'operations', code: 'alias_is_object_name' }])

    await enablePayments(s, zahlung)
    const after = await endpoints(s, zahlung.id)
    expect(after).toMatchObject({
      apiResource: 'payments',
      enabled: ['list', 'get', 'create'],
      blockers: [],
    })
    const beyond = await s.admin.send('PUT', `/internal/admin/api/endpoints/${zahlung.id}`, {
      operations: ['list', 'delete'],
    })
    expect(beyond.statusCode).toBe(422)
    expect(problem(beyond).errors?.[0]).toMatchObject({ code: 'not_available' })

    // The alias cannot go back to the table name while endpoints are enabled.
    const back = await s.admin.send(
      'PUT',
      `/internal/admin/table-access/${zahlung.id}`,
      accessBody(zahlung, { apiResource: 'zahlung', confirm: true }),
    )
    expect(back.statusCode).toBe(422)
    expect(problem(back).errors).toEqual([{ field: 'apiResource', code: 'alias_is_object_name' }])
  })

  it('confirm before a change takes endpoints and grants away (E15)', async () => {
    const { s, zahlung } = await setup()
    const access = await enablePayments(s, zahlung)
    const { token } = await createToken(s, [
      { tableAccessId: zahlung.id, operation: 'create' },
      { tableAccessId: zahlung.id, operation: 'list' },
    ])

    const lowered = accessBody(access, { ops: ['read'] })
    const asked = await s.admin.send('PUT', `/internal/admin/table-access/${zahlung.id}`, lowered)
    expect(asked.statusCode).toBe(409)
    expect(problem(asked)).toMatchObject({
      code: 'confirmation_required',
      consequences: [
        { kind: 'api_endpoint_removed', operation: 'create' },
        {
          kind: 'api_grant_removed',
          tokenId: token.id,
          tokenName: 'Kassen-Export',
          operation: 'create',
        },
      ],
    })
    expect((await endpoints(s, zahlung.id)).enabled).toEqual(['list', 'get', 'create'])

    const confirmed = await s.admin.send('PUT', `/internal/admin/table-access/${zahlung.id}`, {
      ...lowered,
      confirm: true,
    })
    expect(confirmed.statusCode).toBe(200)
    expect((await endpoints(s, zahlung.id)).enabled).toEqual(['list', 'get'])
    const tokens = (await s.admin.request('GET', '/internal/admin/api/tokens')).json<{
      data: ApiToken[]
    }>().data
    expect(tokens[0]?.grants).toEqual([{ tableAccessId: zahlung.id, operation: 'list' }])

    // Raising the ceiling again reopens nothing by itself.
    const raised = await s.admin.send(
      'PUT',
      `/internal/admin/table-access/${zahlung.id}`,
      accessBody(access, { ops: ['read', 'create', 'update'] }),
    )
    expect(raised.statusCode).toBe(200)
    expect((await endpoints(s, zahlung.id)).enabled).toEqual(['list', 'get'])

    const audit = (
      await s.admin.request('GET', '/internal/admin/audit?action=table_access.updated')
    )
      .json<{ data: AuditEvent[] }>()
      .data.find((event) => event.details !== null && 'consequences' in (event.details ?? {}))
    expect(audit?.details).toMatchObject({
      consequences: [{ kind: 'api_endpoint_removed' }, { kind: 'api_grant_removed' }],
    })
  })

  it('confirm before disabling an endpoint with grants, and before renaming', async () => {
    const { s, zahlung } = await setup()
    const access = await enablePayments(s, zahlung)
    await createToken(s, [{ tableAccessId: zahlung.id, operation: 'get' }])

    const disable = { operations: ['list', 'create'] }
    const asked = await s.admin.send('PUT', `/internal/admin/api/endpoints/${zahlung.id}`, disable)
    expect(asked.statusCode).toBe(409)
    expect(problem(asked).consequences).toEqual([
      expect.objectContaining({ kind: 'api_grant_removed', operation: 'get' }),
    ])
    const done = await s.admin.send('PUT', `/internal/admin/api/endpoints/${zahlung.id}`, {
      ...disable,
      confirm: true,
    })
    expect(done.json<ApiEndpointState>().enabled).toEqual(['list', 'create'])

    const renamed = accessBody(access, { apiResource: 'zahlungen' })
    const rename = await s.admin.send('PUT', `/internal/admin/table-access/${zahlung.id}`, renamed)
    expect(problem(rename).consequences).toEqual([
      { kind: 'api_alias_changed', from: 'payments', to: 'zahlungen' },
    ])

    const removal = await s.admin.request('DELETE', `/internal/admin/table-access/${zahlung.id}`)
    expect(removal.statusCode).toBe(409)
    expect(problem(removal).consequences).toEqual([
      { kind: 'api_endpoint_removed', operation: 'list' },
      { kind: 'api_endpoint_removed', operation: 'create' },
    ])
    const removed = await s.admin.request(
      'DELETE',
      `/internal/admin/table-access/${zahlung.id}?confirm=true`,
    )
    expect(removed.statusCode).toBe(204)
  })

  it('show enabled endpoints the resource cannot serve, not only missing grants', async () => {
    const { s, zahlung } = await setup()
    await enablePayments(s, zahlung)
    // `betrag` becomes required and is excluded: no row can be created through the API.
    await storeSnapshot(
      s.server,
      demoObjects.map((object) =>
        object.name !== 'zahlung'
          ? object
          : {
              ...object,
              columns: object.columns.map((column) =>
                column.name === 'betrag' ? { ...column, nullable: false } : column,
              ),
            },
      ),
      Date.now() + 1000,
    )
    const excluded = await s.admin.send(
      'PUT',
      `/internal/admin/table-access/${zahlung.id}`,
      accessBody(zahlung, {
        apiResource: 'payments',
        exclusions: [{ column: 'betrag', scope: 'all' }],
      }),
    )
    expect(excluded.statusCode, excluded.body).toBe(200)
    expect((await endpoints(s, zahlung.id)).withheld).toEqual(['create'])
  })
})

describe('API tokens', () => {
  it('are shown once, stored as a hash and granted only on enabled endpoints', async () => {
    const { s, zahlung } = await setup()
    await enablePayments(s, zahlung)
    const refused = await s.admin.send('POST', '/internal/admin/api/tokens', {
      name: 'x',
      expiresAt: Date.now() - 1000,
      ipAllowlist: ['10.0.0.0/8', 'nonsense'],
      rateLimitPerMinute: 60,
      grants: [{ tableAccessId: zahlung.id, operation: 'update' }],
    })
    expect(refused.statusCode).toBe(422)
    expect(problem(refused).errors).toEqual([
      { field: 'ipAllowlist.1', code: 'invalid' },
      { field: 'expiresAt', code: 'in_the_past' },
      { field: 'grants.0', code: 'endpoint_disabled' },
    ])

    const { token, secret } = await createToken(s, [
      { tableAccessId: zahlung.id, operation: 'create' },
    ])
    expect(wellFormed(secret)).toBe(true)
    expect(token).toMatchObject({
      name: 'Kassen-Export',
      hint: secret.slice(-4),
      createdBy: 'admin@example.com',
      revokedAt: null,
      requestCount: 0,
      grants: [{ tableAccessId: zahlung.id, operation: 'create' }],
    })
    const stored = await s.server.store.db.selectFrom('api_tokens').selectAll().execute()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(stored[0]?.token_hash).toBe(hashToken(secret))
    const list = (await s.admin.request('GET', '/internal/admin/api/tokens')).body
    expect(list).not.toContain(secret)

    const updated = await s.admin.send('PUT', `/internal/admin/api/tokens/${token.id}`, {
      name: 'Kasse',
      expiresAt: null,
      ipAllowlist: ['203.0.113.0/24'],
      rateLimitPerMinute: 10,
      grants: [],
    })
    expect(updated.json<ApiToken>()).toMatchObject({
      name: 'Kasse',
      ipAllowlist: ['203.0.113.0/24'],
      rateLimitPerMinute: 10,
      grants: [],
    })
    const revoked = await s.admin.send('POST', `/internal/admin/api/tokens/${token.id}/revoke`, {})
    expect(revoked.json<ApiToken>().revokedAt).not.toBeNull()
    const again = await s.admin.send('PUT', `/internal/admin/api/tokens/${token.id}`, {
      name: 'Kasse',
      expiresAt: null,
      ipAllowlist: [],
      rateLimitPerMinute: 10,
      grants: [],
    })
    expect(again.statusCode).toBe(409)

    const actions = (await s.admin.request('GET', '/internal/admin/audit'))
      .json<{ data: AuditEvent[] }>()
      .data.map((event) => event.action)
    expect(actions).toEqual(
      expect.arrayContaining(['api_token.created', 'api_token.updated', 'api_token.revoked']),
    )
    expect(JSON.stringify(actions)).not.toContain(secret)
  })

  it('are managed by admins only', async () => {
    const { s } = await setup()
    const { client } = await createUser(s, 'manager@example.com', 'manager')
    expect((await client.request('GET', '/internal/admin/api/tokens')).statusCode).toBe(403)
    expect((await client.request('GET', '/internal/admin/api/endpoints')).statusCode).toBe(403)
  })
})
