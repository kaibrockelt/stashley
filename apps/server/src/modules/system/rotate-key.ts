// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database } from '../../metastore/schema.ts'
import { decrypt, encrypt, type KeyRing } from '../../platform/crypto/keys.ts'

/**
 * Every encrypted column (§21.1) with its AAD. A new encrypted column must be added here,
 * or key rotation leaves it unreadable.
 */
export const encryptedColumns = [
  'users.totp_secret',
  'identity_providers.client_secret',
  'connection_credentials.password',
] as const

export interface RotationResult {
  secrets: number
  sessions: number
}

/**
 * Re-encrypts all secrets with a new key in one transaction, replaces the key check value
 * and ends all sessions, whose cookies are signed with the old key (§21.3).
 */
export async function rotateSecrets(
  db: Kysely<Database>,
  current: KeyRing,
  next: KeyRing,
  keyCheck: { plaintext: string; aad: string },
): Promise<RotationResult> {
  return writeTransaction(db, async (trx) => {
    let secrets = 0
    const reencrypt = (value: string, aad: string) => {
      secrets += 1
      return encrypt(next, decrypt(current, value, aad), aad)
    }

    const users = await trx
      .selectFrom('users')
      .select(['id', 'totp_secret'])
      .where('totp_secret', 'is not', null)
      .execute()
    for (const row of users) {
      if (row.totp_secret === null) continue
      const value = reencrypt(row.totp_secret, `users:${row.id}:totp_secret`)
      await trx.updateTable('users').set({ totp_secret: value }).where('id', '=', row.id).execute()
    }

    const providers = await trx
      .selectFrom('identity_providers')
      .select(['id', 'client_secret'])
      .where('client_secret', 'is not', null)
      .execute()
    for (const row of providers) {
      if (row.client_secret === null) continue
      const value = reencrypt(row.client_secret, `identity_providers:${row.id}:client_secret`)
      await trx
        .updateTable('identity_providers')
        .set({ client_secret: value })
        .where('id', '=', row.id)
        .execute()
    }

    const credentials = await trx
      .selectFrom('connection_credentials')
      .select(['id', 'password'])
      .execute()
    for (const row of credentials) {
      const value = reencrypt(row.password, `connection_credentials:${row.id}:password`)
      await trx
        .updateTable('connection_credentials')
        .set({ password: value })
        .where('id', '=', row.id)
        .execute()
    }

    await trx
      .updateTable('settings')
      .set({
        value: JSON.stringify(encrypt(next, keyCheck.plaintext, keyCheck.aad)),
        updated_at: Date.now(),
        updated_by: null,
      })
      .where('key', '=', 'crypto.keyCheck')
      .execute()
    const sessions = await trx.deleteFrom('sessions').executeTakeFirst()
    return { secrets, sessions: Number(sessions.numDeletedRows) }
  })
}
