// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminUser, SessionUser, Theme, UiLocale } from '@stashley/shared'
import { sql, type Kysely, type Updateable } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { Database, SystemRole, UsersTable, UserStatus } from '../../metastore/schema.ts'
import { isoOrNull } from '../../platform/clock.ts'

export type UserRow = UsersTable

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    systemRole: user.system_role,
    status: user.status,
    locale: (user.locale as UiLocale | null) ?? null,
    formatLocale: user.format_locale,
    theme: user.theme as Theme,
    mfaEnabled: user.totp_enabled_at !== null,
    hasPassword: user.password_hash !== null,
  }
}

export class UsersRepository {
  private readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  findById(id: string, db: Kysely<Database> = this.db): Promise<UserRow | undefined> {
    return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
  }

  findByEmail(email: string, db: Kysely<Database> = this.db): Promise<UserRow | undefined> {
    return db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', normalizeEmail(email))
      .executeTakeFirst()
  }

  async create(
    input: {
      email: string
      displayName: string
      systemRole: SystemRole
      status: UserStatus
      passwordHash?: string | null
      invitedBy?: string | null
    },
    now: number,
    db: Kysely<Database> = this.db,
  ): Promise<UserRow> {
    const row: UserRow = {
      id: uuidv7(),
      email: normalizeEmail(input.email),
      display_name: input.displayName,
      system_role: input.systemRole,
      status: input.status,
      password_hash: input.passwordHash ?? null,
      totp_secret: null,
      totp_enabled_at: null,
      totp_last_step: null,
      locale: null,
      format_locale: null,
      theme: 'system',
      invited_by: input.invitedBy ?? null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    }
    await db.insertInto('users').values(row).execute()
    return row
  }

  async update(
    id: string,
    values: Updateable<UsersTable>,
    now: number,
    db: Kysely<Database> = this.db,
  ): Promise<void> {
    await db
      .updateTable('users')
      .set({ ...values, updated_at: now })
      .where('id', '=', id)
      .execute()
  }

  async countActiveAdmins(db: Kysely<Database> = this.db, excludeId?: string): Promise<number> {
    let query = db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('system_role', '=', 'admin')
      .where('status', '=', 'active')
    if (excludeId !== undefined) query = query.where('id', '!=', excludeId)
    const row = await query.executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async countAdmins(): Promise<number> {
    const row = await this.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('system_role', '=', 'admin')
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async list(filter: { status?: UserStatus; query?: string }): Promise<AdminUser[]> {
    let query = this.db.selectFrom('users').selectAll()
    if (filter.status !== undefined) query = query.where('status', '=', filter.status)
    if (filter.query !== undefined && filter.query !== '') {
      const pattern = `%${filter.query.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`
      query = query.where((eb) =>
        eb.or([
          sql<boolean>`email like ${pattern} escape '\\'`,
          sql<boolean>`lower(display_name) like ${pattern} escape '\\'`,
        ]),
      )
    }
    const users = await query.orderBy('display_name').execute()
    const identities = await this.db
      .selectFrom('user_identities')
      .innerJoin('identity_providers', 'identity_providers.id', 'user_identities.provider_id')
      .select([
        'user_identities.id',
        'user_identities.user_id',
        'user_identities.email',
        'identity_providers.display_name as provider',
      ])
      .execute()
    return users.map((user) => this.toAdminUser(user, identities))
  }

  async getAdminUser(id: string): Promise<AdminUser | undefined> {
    const user = await this.findById(id)
    if (user === undefined) return undefined
    const identities = await this.db
      .selectFrom('user_identities')
      .innerJoin('identity_providers', 'identity_providers.id', 'user_identities.provider_id')
      .select([
        'user_identities.id',
        'user_identities.user_id',
        'user_identities.email',
        'identity_providers.display_name as provider',
      ])
      .where('user_identities.user_id', '=', id)
      .execute()
    return this.toAdminUser(user, identities)
  }

  private toAdminUser(
    user: UserRow,
    identities: { id: string; user_id: string; email: string | null; provider: string }[],
  ): AdminUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      systemRole: user.system_role,
      status: user.status,
      mfaEnabled: user.totp_enabled_at !== null,
      hasPassword: user.password_hash !== null,
      identities: identities
        .filter((identity) => identity.user_id === user.id)
        .map((identity) => ({
          id: identity.id,
          provider: identity.provider,
          email: identity.email,
        })),
      createdAt: new Date(user.created_at).toISOString(),
      lastLoginAt: isoOrNull(user.last_login_at),
    }
  }
}
