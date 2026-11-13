// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'
import type { Database } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { AppError } from '../../platform/http/problem.ts'

/** What a pending change would remove: a provider, one identity, or one admin. */
export interface SignInPathChange {
  providerId?: string
  identityId?: string
  userId?: string
}

/** Whether an active admin can still sign in through an enabled provider after the change. */
export async function oidcAdminRemains(
  db: Kysely<Database>,
  change: SignInPathChange = {},
): Promise<boolean> {
  let query = db
    .selectFrom('users')
    .innerJoin('user_identities', 'user_identities.user_id', 'users.id')
    .innerJoin('identity_providers', 'identity_providers.id', 'user_identities.provider_id')
    .select('users.id')
    .where('users.system_role', '=', 'admin')
    .where('users.status', '=', 'active')
    .where('identity_providers.enabled', '=', 1)
  if (change.providerId !== undefined) {
    query = query.where('identity_providers.id', '!=', change.providerId)
  }
  if (change.identityId !== undefined) {
    query = query.where('user_identities.id', '!=', change.identityId)
  }
  if (change.userId !== undefined) query = query.where('users.id', '!=', change.userId)
  return (await query.executeTakeFirst()) !== undefined
}

/**
 * With password sign-in off, admins sign in only through identity providers. A change that
 * would leave no admin able to sign in is refused; `stashley auth enable-local` stays the
 * emergency exit.
 */
export async function ensureAdminSignInPath(
  db: Kysely<Database>,
  settings: SettingsRepository,
  change: SignInPathChange,
): Promise<void> {
  const { enabled } = await settings.get('auth.localLogin', db)
  if (enabled) return
  if (!(await oidcAdminRemains(db, change))) throw new AppError('last_sign_in_path')
}
