// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database, SessionsTable, SessionState } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { day, minute, systemClock, type Clock } from '../../platform/clock.ts'
import type { KeyRing } from '../../platform/crypto/keys.ts'
import type { UserRow } from '../users/repository.ts'

export type SessionRow = SessionsTable

export interface ResolvedSession {
  session: SessionRow
  user: UserRow
}

/** `last_active_at` is written at most this often. */
const touchInterval = minute

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-stashley_session' : 'stashley_session'
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Server-side sessions. The cookie holds a random token plus an HMAC; the store keeps only
 * the token's SHA-256, so a leaked database cannot be turned into valid cookies.
 */
export class SessionService {
  private readonly db: Kysely<Database>
  private readonly keys: KeyRing
  private readonly settings: SettingsRepository
  private readonly clock: Clock

  constructor(
    db: Kysely<Database>,
    keys: KeyRing,
    settings: SettingsRepository,
    clock: Clock = systemClock,
  ) {
    this.db = db
    this.keys = keys
    this.settings = settings
    this.clock = clock
  }

  private sign(token: string): string {
    return createHmac('sha256', this.keys.key('session')).update(token).digest('base64url')
  }

  /** Returns the token hash for a well-formed, correctly signed cookie value. */
  parseCookie(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    const [token, signature] = value.split('.')
    if (token === undefined || signature === undefined || token.length !== 43) return undefined
    const expected = Buffer.from(this.sign(token))
    const actual = Buffer.from(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    return hashToken(token)
  }

  async create(input: {
    userId: string
    state: SessionState
    method: SessionRow['auth_method']
    ip: string | null
    userAgent: string | null
  }): Promise<{ cookie: string; idHash: string; maxAgeSeconds: number }> {
    const { maxAgeDays } = await this.settings.get('auth.session')
    const token = randomBytes(32).toString('base64url')
    const idHash = hashToken(token)
    const now = this.clock()
    await this.db
      .insertInto('sessions')
      .values({
        id_hash: idHash,
        user_id: input.userId,
        state: input.state,
        auth_method: input.method,
        created_at: now,
        last_active_at: now,
        expires_at: now + maxAgeDays * day,
        ip: input.ip,
        user_agent: input.userAgent?.slice(0, 300) ?? null,
      })
      .execute()
    return { cookie: `${token}.${this.sign(token)}`, idHash, maxAgeSeconds: maxAgeDays * 86_400 }
  }

  /** Loads a session; expired or idle sessions and sessions of disabled accounts are removed. */
  async resolve(idHash: string): Promise<ResolvedSession | undefined> {
    const session = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id_hash', '=', idHash)
      .executeTakeFirst()
    if (session === undefined) return undefined
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', session.user_id)
      .executeTakeFirst()
    const now = this.clock()
    const { idleMinutes } = await this.settings.get('auth.session')
    if (
      user === undefined ||
      user.status === 'disabled' ||
      now >= session.expires_at ||
      now - session.last_active_at > idleMinutes * minute
    ) {
      await this.revoke(idHash)
      return undefined
    }
    if (now - session.last_active_at >= touchInterval) {
      await this.db
        .updateTable('sessions')
        .set({ last_active_at: now })
        .where('id_hash', '=', idHash)
        .execute()
      session.last_active_at = now
    }
    return { session, user }
  }

  /** Issues a new session ID for a privilege change (e.g. after the second factor). */
  async rotate(
    current: SessionRow,
    state: SessionState,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ cookie: string; idHash: string; maxAgeSeconds: number }> {
    await this.revoke(current.id_hash)
    return this.create({
      userId: current.user_id,
      state,
      method: current.auth_method,
      ip,
      userAgent,
    })
  }

  async revoke(idHash: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('id_hash', '=', idHash).execute()
  }

  async revokeAllForUser(userId: string, db: Kysely<Database> = this.db): Promise<void> {
    await db.deleteFrom('sessions').where('user_id', '=', userId).execute()
  }

  async revokeAll(): Promise<void> {
    await this.db.deleteFrom('sessions').execute()
  }

  async cleanup(): Promise<number> {
    const { idleMinutes } = await this.settings.get('auth.session')
    const now = this.clock()
    const result = await this.db
      .deleteFrom('sessions')
      .where((eb) =>
        eb.or([eb('expires_at', '<=', now), eb('last_active_at', '<', now - idleMinutes * minute)]),
      )
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }
}
