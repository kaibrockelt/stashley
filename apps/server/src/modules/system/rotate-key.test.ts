// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, keyCheckAad, keyCheckPlaintext, verifyKey, type Server } from '../../app.ts'
import { createKeyRing, decrypt, encrypt } from '../../platform/crypto/keys.ts'
import { testConfig, testSecret } from '../../test/helpers.ts'
import { TestClient } from '../../test/client.ts'
import { encryptedColumns, rotateSecrets } from './rotate-key.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

describe('rotate-key', () => {
  it('re-encrypts every secret, replaces the key check and ends sessions', async () => {
    const server = await createServer(
      testConfig({
        INITIAL_ADMIN_EMAIL: 'admin@example.com',
        INITIAL_ADMIN_PASSWORD: 'correct horse battery staple',
      }),
      {
        quiet: true,
        listen: false,
        overrides: {
          oidcClient: {
            authorizationUrl: () => Promise.reject(new Error('unused')),
            exchange: () => Promise.reject(new Error('unused')),
            check: () => Promise.resolve(),
          },
        },
      },
    )
    servers.push(server)
    await server.start()
    const admin = new TestClient(server.app)
    await admin.login('admin@example.com', 'correct horse battery staple')
    const db = server.store.db
    const current = createKeyRing(testSecret)
    const next = createKeyRing('a completely different key of 32+ bytes')

    const provider = await server.services.oidc.create(
      { kind: 'cli', id: null, label: null, ip: null },
      {
        slug: 'corp',
        displayName: 'Corp',
        issuerUrl: 'https://idp.example.com',
        clientId: 'stashley',
        clientSecret: 'provider secret',
        scopes: 'openid',
        autoApproveDomains: [],
        enabled: true,
      },
    )
    const admins = await db.selectFrom('users').select('id').execute()
    const userId = admins[0]?.id ?? ''
    await db
      .updateTable('users')
      .set({ totp_secret: encrypt(current, 'TOTPSECRET', `users:${userId}:totp_secret`) })
      .where('id', '=', userId)
      .execute()
    await db
      .insertInto('connections')
      .values({
        id: 'c1',
        name: 'Demo',
        host: 'db',
        port: 3306,
        database_name: 'demo',
        engine: 'mariadb',
        server_version: '11.4.2',
        tls: JSON.stringify({ mode: 'disabled', caPem: null, serverName: null }),
        timezone: 'UTC',
        query_timeout_ms: 30_000,
        created_at: 0,
        updated_at: 0,
      })
      .execute()
    await db
      .insertInto('connection_credentials')
      .values({
        id: 'k1',
        connection_id: 'c1',
        purpose: 'read',
        username: 'reader',
        password: encrypt(current, 'db password', 'connection_credentials:k1:password'),
        grant_report: null,
        checked_at: null,
      })
      .execute()

    const result = await rotateSecrets(db, current, next, {
      plaintext: keyCheckPlaintext,
      aad: keyCheckAad,
    })
    expect(result).toEqual({ secrets: encryptedColumns.length, sessions: 1 })

    const user = await db
      .selectFrom('users')
      .select('totp_secret')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    expect(decrypt(next, user.totp_secret ?? '', `users:${userId}:totp_secret`)).toBe('TOTPSECRET')
    const idp = await db
      .selectFrom('identity_providers')
      .select('client_secret')
      .where('id', '=', provider.id)
      .executeTakeFirstOrThrow()
    expect(
      decrypt(next, idp.client_secret ?? '', `identity_providers:${provider.id}:client_secret`),
    ).toBe('provider secret')
    const credential = await db
      .selectFrom('connection_credentials')
      .select('password')
      .executeTakeFirstOrThrow()
    expect(decrypt(next, credential.password, 'connection_credentials:k1:password')).toBe(
      'db password',
    )

    await expect(verifyKey(server.services.settings, next)).resolves.toBeUndefined()
    await expect(verifyKey(server.services.settings, current)).rejects.toThrow(/does not match/)
    expect((await admin.session()).state).toBe('anonymous')
  })
})
