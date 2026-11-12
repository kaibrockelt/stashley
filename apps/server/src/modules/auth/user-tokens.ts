// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { Database, UserTokensTable } from '../../metastore/schema.ts'
import { day, hour, systemClock, type Clock } from '../../platform/clock.ts'

export type TokenPurpose = UserTokensTable['purpose']

const lifetimes: Record<TokenPurpose, number> = {
  invitation: 7 * day,
  password_reset: hour,
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** One-time tokens for invitation and password reset links. Only hashes are stored. */
export class UserTokens {
  private readonly db: Kysely<Database>
  private readonly clock: Clock

  constructor(db: Kysely<Database>, clock: Clock = systemClock) {
    this.db = db
    this.clock = clock
  }

  /** Creates a token; earlier unused tokens of the same purpose for the user are invalidated. */
  async issue(userId: string, purpose: TokenPurpose, createdBy: string | null): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const now = this.clock()
    await this.db
      .deleteFrom('user_tokens')
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .execute()
    await this.db
      .insertInto('user_tokens')
      .values({
        id: uuidv7(),
        user_id: userId,
        purpose,
        token_hash: hashToken(token),
        expires_at: now + lifetimes[purpose],
        consumed_at: null,
        created_by: createdBy,
        created_at: now,
      })
      .execute()
    return token
  }

  /** Returns the user ID of a valid, unused token. */
  async peek(token: string, purpose: TokenPurpose): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('user_tokens')
      .select(['user_id', 'expires_at', 'consumed_at'])
      .where('token_hash', '=', hashToken(token))
      .where('purpose', '=', purpose)
      .executeTakeFirst()
    if (row === undefined || row.consumed_at !== null || row.expires_at <= this.clock()) {
      return undefined
    }
    return row.user_id
  }

  /** Marks a valid token as used and returns its user ID; a token works only once. */
  async consume(
    token: string,
    purpose: TokenPurpose,
    db: Kysely<Database> = this.db,
  ): Promise<string | undefined> {
    const now = this.clock()
    const row = await db
      .updateTable('user_tokens')
      .set({ consumed_at: now })
      .where('token_hash', '=', hashToken(token))
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', now)
      .returning('user_id')
      .executeTakeFirst()
    return row?.user_id
  }

  async cleanup(): Promise<void> {
    await this.db
      .deleteFrom('user_tokens')
      .where('expires_at', '<', this.clock() - day)
      .execute()
  }
}
