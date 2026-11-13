// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminUser, ProblemDocument } from '@stashley/shared'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../../app.ts'
import { resolveTargetHost } from '../../target/address-guard.ts'
import { TestClient } from '../../test/client.ts'
import { storeConnection } from '../../test/connections.ts'
import { testConfig } from '../../test/helpers.ts'

/**
 * Route contracts of the M3 data routes that need no target database: who may call them,
 * CSRF, input validation, the self-connection guard and the outbound rate limit (§14, §15).
 * Behaviour against real servers is covered by `apps/server/test/target.test.ts`.
 */

const adminEmail = 'admin@example.com'
const adminPassword = 'correct horse battery staple'
const id = '01890000-0000-7000-8000-000000000001'
const driftId = '01890000-0000-7000-8000-000000000002'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
interface Route {
  method: Method
  url: string
}

/** Every route registered by `registerDataRoutes`. */
const routes: Route[] = [
  { method: 'GET', url: '/internal/admin/connections' },
  { method: 'POST', url: '/internal/admin/connections/test' },
  { method: 'POST', url: '/internal/admin/connections' },
  { method: 'GET', url: `/internal/admin/connections/${id}` },
  { method: 'PUT', url: `/internal/admin/connections/${id}` },
  { method: 'DELETE', url: `/internal/admin/connections/${id}` },
  { method: 'POST', url: `/internal/admin/connections/${id}/grants` },
  { method: 'GET', url: `/internal/admin/connections/${id}/schema` },
  { method: 'POST', url: `/internal/admin/connections/${id}/schema/refresh` },
  { method: 'GET', url: `/internal/admin/connections/${id}/schema/drifts` },
  {
    method: 'POST',
    url: `/internal/admin/connections/${id}/schema/drifts/${driftId}/acknowledge`,
  },
  { method: 'GET', url: `/internal/admin/table-access?connectionId=${id}` },
  { method: 'POST', url: '/internal/admin/table-access' },
  { method: 'PUT', url: `/internal/admin/table-access/${id}` },
  { method: 'DELETE', url: `/internal/admin/table-access/${id}` },
  { method: 'GET', url: `/internal/admin/relations?connectionId=${id}` },
  { method: 'POST', url: '/internal/admin/relations' },
  { method: 'DELETE', url: `/internal/admin/relations/${id}` },
]
const mutating = routes.filter((route) => route.method !== 'GET')
const label = (route: Route) => `${route.method} ${route.url}`

const connectionInput = (overrides: Record<string, unknown> = {}) => ({
  name: 'Wanderverein',
  host: 'db.example.com',
  port: 3306,
  databaseName: 'wanderverein',
  tls: { mode: 'verify-full', caPem: null, serverName: null },
  timezone: 'Europe/Berlin',
  queryTimeoutSeconds: 10,
  credentials: {
    read: { username: 'stashley_read', password: 'read password' },
    write: { username: 'stashley_write', password: 'write password' },
    schema: null,
  },
  ...overrides,
})
const accessFields = {
  ops: ['read'],
  keyColumn: null,
  displayTemplate: null,
  apiResource: null,
  mcpEnabled: false,
  exclusions: [],
}

interface Setup {
  server: Server
  admin: TestClient
  client: () => TestClient
  /** Hosts the self-connection guard was asked about, i.e. outbound connection attempts. */
  resolved: string[]
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function setup(): Promise<Setup> {
  const resolved: string[] = []
  const server = await createServer(
    testConfig({ INITIAL_ADMIN_EMAIL: adminEmail, INITIAL_ADMIN_PASSWORD: adminPassword }),
    {
      quiet: true,
      listen: false,
      overrides: {
        resolveTargetHost: (host) => {
          resolved.push(host)
          return resolveTargetHost(host)
        },
      },
    },
  )
  servers.push(server)
  await server.start()
  const admin = new TestClient(server.app)
  expect((await admin.login(adminEmail, adminPassword)).statusCode).toBe(200)
  return { server, admin, client: () => new TestClient(server.app), resolved }
}

async function createUser(
  s: Setup,
  email: string,
  systemRole: 'admin' | 'manager' | 'user',
): Promise<{ user: AdminUser; client: TestClient }> {
  const invited = await s.admin.send('POST', '/internal/admin/users', {
    email,
    displayName: email.split('@')[0],
    systemRole,
  })
  expect(invited.statusCode).toBe(201)
  const { user, link } = invited.json<{ user: AdminUser; link: string | null }>()
  const client = s.client()
  const accepted = await client.send('POST', '/internal/invitations/accept', {
    token: link?.split('#').at(-1) ?? '',
    password: `${email} long passphrase`,
  })
  expect(accepted.statusCode).toBe(200)
  return { user, client }
}

/** Calls a route the way the web client does, with a fresh CSRF token for writes. */
function call(
  client: TestClient,
  route: Route,
  body: unknown = {},
): Promise<LightMyRequestResponse> {
  if (route.method === 'GET') return client.request('GET', route.url)
  return client.send(route.method, route.url, route.method === 'DELETE' ? undefined : body)
}

function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

describe('data routes', () => {
  it('admit only admins and never connect for anyone else', async () => {
    const s = await setup()
    const anonymous = s.client()
    const { client: manager } = await createUser(s, 'mia@example.com', 'manager')
    const { client: user } = await createUser(s, 'uwe@example.com', 'user')
    for (const route of routes) {
      const body = route.url.endsWith('/test') ? connectionInput() : {}
      expect(problem(await call(anonymous, route, body)).code, label(route)).toBe('unauthenticated')
      expect(problem(await call(manager, route, body)).code, label(route)).toBe('forbidden')
      expect(problem(await call(user, route, body)).code, label(route)).toBe('forbidden')
    }
    expect(s.resolved).toEqual([])
  })

  it('stop admin accounts that are pending or must still enroll in 2FA', async () => {
    const s = await setup()
    const { user: pending, client: pendingClient } = await createUser(s, 'pia@example.com', 'admin')
    const { client: enrolling } = await createUser(s, 'eli@example.com', 'admin')
    await s.server.store.db
      .updateTable('users')
      .set({ status: 'pending' })
      .where('id', '=', pending.id)
      .execute()
    for (const route of routes) {
      expect(problem(await call(pendingClient, route)).code, label(route)).toBe('account_pending')
    }
    const enforced = await s.admin.send('PATCH', '/internal/admin/settings', {
      twoFactorEnforced: true,
    })
    expect(enforced.statusCode).toBe(200)
    for (const route of routes) {
      expect(problem(await call(enrolling, route)).code, label(route)).toBe('mfa_required')
    }
    expect(s.resolved).toEqual([])
  })

  it('require a CSRF token and a same-origin request for every write', async () => {
    const s = await setup()
    await s.admin.session()
    for (const route of mutating) {
      const body = route.method === 'DELETE' ? undefined : connectionInput()
      const missing = await s.admin.request(route.method, route.url, body, { 'x-csrf-token': '' })
      expect(problem(missing).code, `${label(route)} without token`).toBe('csrf_failed')
      const crossSite = await s.admin.request(route.method, route.url, body, {
        'sec-fetch-site': 'cross-site',
      })
      expect(problem(crossSite).code, `${label(route)} cross-site`).toBe('csrf_failed')
      const foreign = await s.admin.request(route.method, route.url, body, {
        origin: 'https://evil.example',
      })
      expect(problem(foreign).code, `${label(route)} foreign origin`).toBe('csrf_failed')
    }
    // The router decodes the path; the check must still apply.
    const encoded = await s.admin.request(
      'POST',
      '/%69nternal/admin/connections/test',
      connectionInput(),
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(problem(encoded).code).toBe('csrf_failed')
    expect(s.resolved).toEqual([])
  })

  it('validate input and report unknown objects before connecting', async () => {
    const s = await setup()
    const { admin } = s
    expect((await admin.request('GET', '/internal/admin/connections')).json()).toEqual({
      data: [],
    })

    const missing: Route[] = [
      { method: 'GET', url: `/internal/admin/connections/${id}` },
      { method: 'GET', url: `/internal/admin/connections/${id}/schema` },
      { method: 'GET', url: `/internal/admin/connections/${id}/schema/drifts` },
      { method: 'GET', url: `/internal/admin/table-access?connectionId=${id}` },
      { method: 'GET', url: `/internal/admin/relations?connectionId=${id}` },
      { method: 'DELETE', url: `/internal/admin/connections/${id}` },
      { method: 'POST', url: `/internal/admin/connections/${id}/grants` },
      { method: 'POST', url: `/internal/admin/connections/${id}/schema/refresh` },
      {
        method: 'POST',
        url: `/internal/admin/connections/${id}/schema/drifts/${driftId}/acknowledge`,
      },
      { method: 'DELETE', url: `/internal/admin/table-access/${id}` },
      { method: 'DELETE', url: `/internal/admin/relations/${id}` },
    ]
    for (const route of missing) {
      expect(problem(await call(admin, route)).code, label(route)).toBe('not_found')
    }
    const unknownTarget: [Route, unknown][] = [
      [{ method: 'PUT', url: `/internal/admin/connections/${id}` }, connectionInput()],
      [
        { method: 'POST', url: '/internal/admin/connections/test' },
        {
          ...connectionInput({
            credentials: { read: { username: 'stashley_read' }, write: null, schema: null },
          }),
          connectionId: id,
        },
      ],
      [{ method: 'PUT', url: `/internal/admin/table-access/${id}` }, accessFields],
      [
        { method: 'POST', url: '/internal/admin/table-access' },
        { connectionId: id, objectName: 'person', ...accessFields },
      ],
      [
        { method: 'POST', url: '/internal/admin/relations' },
        {
          connectionId: id,
          sourceObject: 'anmeldung',
          sourceColumn: 'id',
          targetObject: 'v_zahlungsstatus',
          targetColumn: 'anmeldung_id',
          kind: 'one_to_one',
        },
      ],
    ]
    for (const [route, body] of unknownTarget) {
      expect(problem(await call(admin, route, body)).code, label(route)).toBe('not_found')
    }

    const invalid: [Route, unknown, { field: string; code: string }][] = [
      [
        { method: 'GET', url: '/internal/admin/connections/not-a-uuid' },
        undefined,
        { field: 'id', code: 'invalid' },
      ],
      [
        { method: 'GET', url: '/internal/admin/table-access' },
        undefined,
        { field: 'connectionId', code: 'required' },
      ],
      [
        { method: 'POST', url: '/internal/admin/connections/test' },
        connectionInput({ host: 'db.example.com/x' }),
        { field: 'host', code: 'invalid' },
      ],
      [
        { method: 'POST', url: '/internal/admin/connections/test' },
        connectionInput({ port: 0 }),
        { field: 'port', code: 'too_small' },
      ],
      [
        { method: 'POST', url: '/internal/admin/connections' },
        { ...connectionInput(), connectionId: id },
        { field: 'connectionId', code: 'not_allowed' },
      ],
      [
        { method: 'POST', url: '/internal/admin/connections' },
        connectionInput({ tls: { mode: 'prefer', caPem: null, serverName: null } }),
        { field: 'tls.mode', code: 'invalid' },
      ],
      [
        { method: 'POST', url: '/internal/admin/table-access' },
        { connectionId: id, objectName: 'person', ...accessFields, ops: [] },
        { field: 'ops', code: 'too_small' },
      ],
      [
        { method: 'POST', url: '/internal/admin/table-access' },
        { connectionId: id, objectName: 'person', ...accessFields, apiResource: 'Person' },
        { field: 'apiResource', code: 'invalid' },
      ],
      [
        { method: 'POST', url: '/internal/admin/table-access' },
        { connectionId: id, objectName: 'person', ...accessFields, ops: ['read', 'drop'] },
        { field: 'ops.1', code: 'invalid' },
      ],
      [
        { method: 'PUT', url: `/internal/admin/table-access/${id}` },
        { ...accessFields, objectName: 'person' },
        { field: 'objectName', code: 'not_allowed' },
      ],
      [
        { method: 'POST', url: '/internal/admin/relations' },
        { connectionId: id, sourceObject: 'a', sourceColumn: 'b', targetObject: 'c' },
        { field: 'targetColumn', code: 'required' },
      ],
    ]
    for (const [route, body, error] of invalid) {
      const response = await call(admin, route, body)
      expect(response.statusCode, label(route)).toBe(422)
      expect(problem(response).errors, label(route)).toEqual(expect.arrayContaining([error]))
    }
    expect(s.resolved).toEqual([])
  })

  it('refuse connections to Stashley itself for every database user', async () => {
    const s = await setup()
    for (const host of [
      'localhost',
      '127.0.0.1',
      '[::1]',
      '0.0.0.0',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::ffff:a9fe:a9fe',
    ]) {
      const response = await s.admin.send(
        'POST',
        '/internal/admin/connections/test',
        connectionInput({ host }),
      )
      expect(response.statusCode, host).toBe(422)
      expect(problem(response), host).toMatchObject({
        code: 'connection_failed',
        errors: [
          { field: 'credentials.read', code: 'host_not_allowed' },
          { field: 'credentials.write', code: 'host_not_allowed' },
        ],
      })
    }
    const saved = await s.admin.send(
      'POST',
      '/internal/admin/connections',
      connectionInput({ host: 'localhost' }),
    )
    expect(problem(saved).code).toBe('connection_failed')
    expect((await s.admin.request('GET', '/internal/admin/connections')).json()).toEqual({
      data: [],
    })
  })

  it('send stored passwords only to the server they were saved for', async () => {
    const s = await setup()
    // A documentation address: the guard refuses it, so nothing leaves the test.
    const target = {
      host: '192.0.2.10',
      port: 3306,
      tls: { mode: 'verify-full', caPem: null, serverName: null },
    }
    const connectionId = await storeConnection(s.server, target)
    const keep = {
      read: { username: 'stashley_read' },
      write: { username: 'stashley_write' },
      schema: null,
    }
    const reenter = [
      { field: 'credentials.read.password', code: 'required' },
      { field: 'credentials.write.password', code: 'required' },
    ]
    for (const change of [
      { host: 'attacker.example.net' },
      { port: 3307 },
      { tls: { mode: 'disabled', caPem: null, serverName: null } },
      { tls: { mode: 'verify-full', caPem: null, serverName: 'other.example.net' } },
    ]) {
      const input = connectionInput({ ...target, ...change, credentials: keep })
      const tested = await s.admin.send('POST', '/internal/admin/connections/test', {
        ...input,
        connectionId,
      })
      expect(problem(tested).errors, JSON.stringify(change)).toEqual(reenter)
      const saved = await s.admin.send('PUT', `/internal/admin/connections/${connectionId}`, input)
      expect(problem(saved).errors, JSON.stringify(change)).toEqual(reenter)
    }
    expect(s.resolved).toEqual([])

    // With the target unchanged, the stored passwords are used and the test is audited.
    const same = await s.admin.send('POST', '/internal/admin/connections/test', {
      ...connectionInput({ ...target, credentials: keep }),
      connectionId,
    })
    expect(problem(same).errors).toEqual([
      { field: 'credentials.read', code: 'host_not_allowed' },
      { field: 'credentials.write', code: 'host_not_allowed' },
    ])
    expect(s.resolved).toEqual(['192.0.2.10', '192.0.2.10'])
    const audited = await s.server.store.db
      .selectFrom('audit_events')
      .select(['details', 'connection_id'])
      .where('action', '=', 'connection.tested')
      .execute()
    expect(audited).toHaveLength(1)
    expect(audited[0]?.connection_id).toBe(connectionId)
    expect(JSON.parse(audited[0]?.details ?? '{}')).toEqual({
      host: '192.0.2.10',
      port: 3306,
      storedPasswords: ['read', 'write'],
      outcome: 'failed',
    })
  })

  it('limit outbound routes per client', async () => {
    const s = await setup()
    const route: Route = { method: 'POST', url: '/internal/admin/connections/test' }
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await call(s.admin, route)).statusCode, `attempt ${attempt}`).toBe(422)
    }
    const limited = await call(s.admin, route)
    expect(limited.statusCode).toBe(429)
    expect(problem(limited).code).toBe('rate_limited')
    expect(limited.headers['retry-after']).toBeDefined()
    expect((await s.admin.request('GET', '/internal/admin/connections')).statusCode).toBe(200)
  })
})
