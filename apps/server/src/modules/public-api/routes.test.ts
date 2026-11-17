// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiTokenCreated, ProblemDocument, TableAccess } from '@stashley/shared'
import { Validator } from '@seriousme/openapi-schema-validator'
import { describe, expect, it } from 'vitest'
import { setupDemo } from '../../test/demo.ts'
import { setupServer, type TestSetup } from '../../test/setup.ts'
import { generateToken } from './tokens.ts'

interface Fixture {
  s: TestSetup
  zahlung: TableAccess
  hotel: TableAccess
}

async function setup(env: Record<string, string> = {}): Promise<Fixture> {
  const s = await setupServer({}, env)
  const demo = await setupDemo(s)
  const zahlung = demo.access.get('zahlung') as TableAccess
  const hotel = demo.access.get('hotel') as TableAccess
  for (const [access, alias, operations] of [
    [zahlung, 'payments', ['list', 'get', 'create']],
    [hotel, 'hotels', ['list', 'count', 'schema']],
  ] as const) {
    const renamed = await s.admin.send('PUT', `/internal/admin/table-access/${access.id}`, {
      ops: access.ops,
      keyColumn: access.keyColumn,
      displayTemplate: access.displayTemplate,
      apiResource: alias,
      mcpEnabled: access.mcpEnabled,
      exclusions: access.exclusions,
    })
    expect(renamed.statusCode).toBe(200)
    const enabled = await s.admin.send('PUT', `/internal/admin/api/endpoints/${access.id}`, {
      operations,
    })
    expect(enabled.statusCode).toBe(200)
  }
  return { s, zahlung, hotel }
}

async function token(
  f: Fixture,
  grants: { tableAccessId: string; operation: string }[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await f.s.admin.send('POST', '/internal/admin/api/tokens', {
    name: 'Integration',
    expiresAt: null,
    ipAllowlist: [],
    rateLimitPerMinute: 60,
    grants,
    ...extra,
  })
  expect(created.statusCode).toBe(201)
  return created.json<ApiTokenCreated>().secret
}

function call(
  f: Fixture,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return f.s.server.app.inject({
    method,
    url,
    headers: {
      ...(options.token !== undefined && { authorization: `Bearer ${options.token}` }),
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body !== undefined && { payload: JSON.stringify(options.body) }),
  })
}

const problemOf = (response: { json: () => unknown }) => response.json() as ProblemDocument

describe('public API authentication', () => {
  it('needs a valid bearer token and never reads the session cookie', async () => {
    const f = await setup()
    const none = await call(f, 'GET', '/api/v1/payments')
    expect(none.statusCode).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer realm="stashley"')
    expect(none.headers['content-type']).toContain('application/problem+json')

    // The admin's session cookie does not count on the public API.
    const cookie = await f.s.admin.request('GET', '/api/v1/payments')
    expect(cookie.statusCode).toBe(401)

    const forged = await call(f, 'GET', '/api/v1/payments', { token: generateToken() })
    expect(forged.statusCode).toBe(401)
    expect(forged.headers['www-authenticate']).toContain('error="invalid_token"')
    const garbage = await call(f, 'GET', '/api/v1/payments', { token: 'stl_api_nope' })
    expect(garbage.statusCode).toBe(401)
  })

  it('refuses revoked and expired tokens at once', async () => {
    const f = await setup()
    const secret = await token(f, [{ tableAccessId: f.zahlung.id, operation: 'create' }])
    const tokens = (await f.s.admin.request('GET', '/internal/admin/api/tokens')).json<{
      data: { id: string }[]
    }>().data
    const id = tokens[0]?.id as string
    // A known token passes authentication; `list` is not granted.
    expect((await call(f, 'GET', '/api/v1/payments', { token: secret })).statusCode).toBe(403)
    await f.s.admin.send('POST', `/internal/admin/api/tokens/${id}/revoke`, {})
    expect((await call(f, 'GET', '/api/v1/payments', { token: secret })).statusCode).toBe(401)

    const soon = await token(f, [{ tableAccessId: f.zahlung.id, operation: 'list' }], {
      expiresAt: Date.now() + 60_000,
    })
    const later = f.s.server.services
    await f.s.server.store.db
      .updateTable('api_tokens')
      .set({ expires_at: Date.now() - 1 })
      .where('name', '=', 'Integration')
      .where('revoked_at', 'is', null)
      .execute()
    later.events.emit('api.changed', {})
    expect((await call(f, 'GET', '/api/v1/payments', { token: soon })).statusCode).toBe(401)
  })

  it('limits invalid tokens per address and requests per token', async () => {
    const f = await setup()
    for (let attempt = 0; attempt < 20; attempt++) {
      await call(f, 'GET', '/api/v1/payments', { token: generateToken() })
    }
    const blocked = await call(f, 'GET', '/api/v1/payments', { token: generateToken() })
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    // A valid token from the same address still passes.
    const valid = await token(f, [{ tableAccessId: f.hotel.id, operation: 'schema' }])
    expect((await call(f, 'GET', '/api/v1/hotels/schema', { token: valid })).statusCode).toBe(200)

    const g = await setup()
    const secret = await token(g, [{ tableAccessId: g.hotel.id, operation: 'schema' }], {
      rateLimitPerMinute: 2,
    })
    expect((await call(g, 'GET', '/api/v1/hotels/schema', { token: secret })).statusCode).toBe(200)
    expect((await call(g, 'GET', '/api/v1/hotels/schema', { token: secret })).statusCode).toBe(200)
    const limited = await call(g, 'GET', '/api/v1/hotels/schema', { token: secret })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('checks the IP allowlist', async () => {
    const f = await setup()
    const secret = await token(f, [{ tableAccessId: f.hotel.id, operation: 'schema' }], {
      ipAllowlist: ['203.0.113.0/24'],
    })
    // Fastify's inject comes from 127.0.0.1.
    const outside = await call(f, 'GET', '/api/v1/hotels/schema', { token: secret })
    expect(outside.statusCode).toBe(403)
  })

  it('can be left out entirely', async () => {
    const f = await setup({ STASHLEY_PUBLIC_API: 'off' })
    const response = await call(f, 'GET', '/api/v1/payments', { token: generateToken() })
    expect(response.statusCode).toBe(404)
  })
})

describe('public API resolution (§16, D5)', () => {
  it('answers 404 for unknown names, table names and disabled endpoints, 403 without grant', async () => {
    const f = await setup()
    const secret = await token(f, [
      { tableAccessId: f.zahlung.id, operation: 'create' },
      { tableAccessId: f.hotel.id, operation: 'schema' },
    ])
    const status = async (method: 'GET' | 'DELETE', url: string) =>
      (await call(f, method, url, { token: secret })).statusCode
    expect(await status('GET', '/api/v1/nothing')).toBe(404)
    // The real table name is not a resource.
    expect(await status('GET', '/api/v1/zahlung')).toBe(404)
    // `count` is not enabled on payments; `delete` is not even in the ceiling.
    expect(await status('GET', '/api/v1/payments/count')).toBe(404)
    expect(await status('DELETE', '/api/v1/payments/1')).toBe(404)
    // Enabled, but this token has only `create`.
    expect(await status('GET', '/api/v1/payments')).toBe(403)
    expect(await status('GET', '/api/v1/payments/1')).toBe(403)
    expect(await status('GET', '/api/v1/hotels')).toBe(403)
  })

  it('describes a resource without excluded columns or the table name', async () => {
    const f = await setup()
    const secret = await token(f, [
      { tableAccessId: f.hotel.id, operation: 'schema' },
      { tableAccessId: f.hotel.id, operation: 'list' },
    ])
    const response = await call(f, 'GET', '/api/v1/hotels/schema', { token: secret })
    expect(response.statusCode).toBe(200)
    const schema = response.json<{
      resource: string
      key: string
      operations: string[]
      columns: { name: string }[]
    }>()
    expect(schema).toMatchObject({ resource: 'hotels', key: 'id', operations: ['list', 'schema'] })
    expect(schema.columns.map((column) => column.name)).not.toContain('kontakt_email')
    expect(response.body).not.toContain('"hotel"')
    expect(response.headers['cache-control']).toBe('no-store')
  })
})

describe('public API requests', () => {
  it('reject unknown parameters, columns and operators alike for excluded columns', async () => {
    const f = await setup()
    const secret = await token(f, [{ tableAccessId: f.hotel.id, operation: 'list' }])
    const errors = async (query: string) => {
      const response = await call(f, 'GET', `/api/v1/hotels?${query}`, { token: secret })
      expect(response.statusCode).toBe(400)
      return problemOf(response).errors
    }
    expect(await errors('page=2')).toEqual([{ field: 'page', code: 'unknown_parameter' }])
    expect(await errors('limit=1001')).toEqual([
      { field: 'limit', code: 'out_of_range', params: { min: 1, max: 1000 } },
    ])
    expect(await errors('sort=-missing')).toEqual([{ field: 'sort', code: 'unknown_field' }])
    expect(await errors('sort=name,ort')).toEqual([{ field: 'sort', code: 'one_sort_column' }])
    // An excluded column reads exactly like a missing one (E16).
    const excluded = await errors('filter[kontakt_email][eq]=x')
    const missing = await errors('filter[nichts][eq]=x')
    expect(excluded?.[0]?.code).toBe('unknown_field')
    expect(missing?.[0]?.code).toBe('unknown_field')
    expect(await errors('fields=name,kontakt_email')).toEqual([
      { field: 'fields', code: 'unknown_field' },
    ])
    expect(await errors('filter[name][regex]=x')).toEqual([
      { field: 'filter[name][regex]', code: 'unknown_operator' },
    ])
    expect(await errors('filter[name][null]=maybe')).toEqual([
      { field: 'filter[name][null]', code: 'invalid' },
    ])
    expect(
      await errors(`filter[name][in]=${Array.from({ length: 101 }, (_, i) => i).join(',')}`),
    ).toEqual([{ field: 'filter[name][in]', code: 'too_many_values', params: { max: 100 } }])
    expect(await errors('limit=1&limit=2')).toEqual([{ field: 'limit', code: 'duplicate' }])
  })

  it('check write bodies before anything reaches the database', async () => {
    const f = await setup()
    const secret = await token(f, [{ tableAccessId: f.zahlung.id, operation: 'create' }])
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      call(f, 'POST', '/api/v1/payments', { token: secret, body, headers })
    const unknown = await post({ betrag: '10.00', nichts: 1 })
    expect(unknown.statusCode).toBe(400)
    expect(problemOf(unknown).errors).toEqual([{ field: 'nichts', code: 'unknown_field' }])
    const readOnly = await post({ id: 5, betrag: '10.00' })
    expect(readOnly.statusCode).toBe(422)
    expect(problemOf(readOnly).errors).toEqual([{ field: 'id', code: 'field_not_writable' }])
    expect((await post([1, 2])).statusCode).toBe(400)
    expect((await post({ betrag: '1' }, { 'if-match': '*' })).statusCode).toBe(400)
    const text = await f.s.server.app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'text/csv' },
      payload: 'betrag\n10',
    })
    expect(text.statusCode).toBe(415)
    const large = await post({ kommentar: 'x'.repeat(1024 * 1024) })
    expect(large.statusCode).toBe(413)
  })
})

describe('OpenAPI document (§16, E21)', () => {
  async function valid(document: unknown) {
    const result = await new Validator().validate(document as Record<string, unknown>)
    expect(result.errors ?? []).toEqual([])
    expect(result.valid).toBe(true)
  }

  it('needs a token and lists only what the token can use', async () => {
    const f = await setup()
    const anonymous = await call(f, 'GET', '/api/docs')
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.headers['www-authenticate']).toBe('Bearer realm="stashley"')

    const secret = await token(f, [{ tableAccessId: f.zahlung.id, operation: 'create' }])
    const response = await call(f, 'GET', '/api/docs', { token: secret })
    expect(response.statusCode).toBe(200)
    const document = response.json<{
      openapi: string
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
    }>()
    expect(document.openapi).toBe('3.1.0')
    expect(Object.keys(document.paths)).toEqual(['/payments'])
    expect(Object.keys(document.paths['/payments'] ?? {})).toEqual(['post'])
    expect(Object.keys(document.components.schemas.PaymentsCreate?.properties ?? {})).toEqual([
      'anmeldung_id',
      'betrag',
      'eingang_am',
    ])
    expect(response.body).not.toContain('zahlung')
    expect(response.body).not.toContain('hotel')
    await valid(document)
  })

  it('lists every enabled endpoint for admins, without excluded columns', async () => {
    const f = await setup()
    const response = await f.s.admin.request('GET', '/internal/admin/api/openapi')
    expect(response.statusCode).toBe(200)
    const document = response.json<{ paths: Record<string, Record<string, unknown>> }>()
    expect(Object.keys(document.paths).sort()).toEqual([
      '/hotels',
      '/hotels/count',
      '/hotels/schema',
      '/payments',
      '/payments/{id}',
    ])
    expect(response.body).not.toContain('kontakt_email')
    expect(response.body).not.toContain('"zahlung')
    await valid(document)
  })
})
