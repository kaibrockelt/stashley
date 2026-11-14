// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminUser, ProblemDocument } from '@stashley/shared'
import { afterEach, expect } from 'vitest'
import { createServer, type Server } from '../app.ts'
import type { ServiceOverrides } from '../services.ts'
import { TestClient } from './client.ts'
import { testConfig } from './helpers.ts'

export const adminEmail = 'admin@example.com'
export const adminPassword = 'correct horse battery staple'

export interface TestSetup {
  server: Server
  admin: TestClient
  client: () => TestClient
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

/** A started server with a signed-in first admin; stopped after each test. */
export async function setupServer(
  overrides: ServiceOverrides = {},
  env: Record<string, string> = {},
): Promise<TestSetup> {
  const server = await createServer(
    testConfig({
      INITIAL_ADMIN_EMAIL: adminEmail,
      INITIAL_ADMIN_PASSWORD: adminPassword,
      ...env,
    }),
    { quiet: true, listen: false, overrides },
  )
  servers.push(server)
  await server.start()
  const admin = new TestClient(server.app)
  expect((await admin.login(adminEmail, adminPassword)).statusCode).toBe(200)
  return { server, admin, client: () => new TestClient(server.app) }
}

/** Invites an account through the admin API and signs it in. */
export async function createUser(
  s: TestSetup,
  email: string,
  systemRole: 'admin' | 'manager' | 'user',
  roleIds: string[] = [],
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
  if (roleIds.length > 0) {
    const assigned = await s.admin.send('PUT', `/internal/admin/users/${user.id}/roles`, {
      roleIds,
    })
    expect(assigned.statusCode).toBe(200)
  }
  return { user, client }
}

export function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}
