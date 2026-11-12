// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceSettings, instanceSettingsUpdate } from '@stashley/shared'
import type { Kysely } from 'kysely'
import type { z } from 'zod'
import type { Database } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'

export class InstanceSettingsService {
  private readonly db: Kysely<Database>
  private readonly settings: SettingsRepository
  private readonly audit: AuditLog

  constructor(db: Kysely<Database>, settings: SettingsRepository, audit: AuditLog) {
    this.db = db
    this.settings = settings
    this.audit = audit
  }

  async get(): Promise<InstanceSettings> {
    const [local, twoFactor, session, retention] = await Promise.all([
      this.settings.get('auth.localLogin'),
      this.settings.get('auth.twoFactor'),
      this.settings.get('auth.session'),
      this.settings.get('audit.retention'),
    ])
    return {
      localLoginEnabled: local.enabled,
      twoFactorEnforced: twoFactor.enforced,
      sessionIdleMinutes: session.idleMinutes,
      sessionMaxAgeDays: session.maxAgeDays,
      auditRetentionDays: retention.days,
    }
  }

  /**
   * Password sign-in can be turned off only while an enabled identity provider exists and at
   * least one active admin can sign in through it.
   */
  private async canDisableLocalLogin(): Promise<boolean> {
    const provider = await this.db
      .selectFrom('identity_providers')
      .select('id')
      .where('enabled', '=', 1)
      .executeTakeFirst()
    if (provider === undefined) return false
    const admin = await this.db
      .selectFrom('users')
      .innerJoin('user_identities', 'user_identities.user_id', 'users.id')
      .innerJoin('identity_providers', 'identity_providers.id', 'user_identities.provider_id')
      .select('users.id')
      .where('users.system_role', '=', 'admin')
      .where('users.status', '=', 'active')
      .where('identity_providers.enabled', '=', 1)
      .executeTakeFirst()
    return admin !== undefined
  }

  async update(
    actor: Actor,
    input: z.infer<typeof instanceSettingsUpdate>,
  ): Promise<InstanceSettings> {
    const before = await this.get()
    if (input.localLoginEnabled === false && before.localLoginEnabled) {
      if (!(await this.canDisableLocalLogin()))
        throw fieldError('localLoginEnabled', 'requirements_not_met')
    }
    const next: InstanceSettings = {
      localLoginEnabled: input.localLoginEnabled ?? before.localLoginEnabled,
      twoFactorEnforced: input.twoFactorEnforced ?? before.twoFactorEnforced,
      sessionIdleMinutes: input.sessionIdleMinutes ?? before.sessionIdleMinutes,
      sessionMaxAgeDays: input.sessionMaxAgeDays ?? before.sessionMaxAgeDays,
      auditRetentionDays: input.auditRetentionDays ?? before.auditRetentionDays,
    }
    const changes: Record<string, [unknown, unknown]> = {}
    for (const key of Object.keys(next) as (keyof InstanceSettings)[]) {
      if (next[key] !== before[key]) changes[key] = [before[key], next[key]]
    }
    if (Object.keys(changes).length === 0) return before
    const by = actor.id
    await this.settings.set('auth.localLogin', { enabled: next.localLoginEnabled }, by)
    await this.settings.set('auth.twoFactor', { enforced: next.twoFactorEnforced }, by)
    await this.settings.set(
      'auth.session',
      { idleMinutes: next.sessionIdleMinutes, maxAgeDays: next.sessionMaxAgeDays },
      by,
    )
    await this.settings.set('audit.retention', { days: next.auditRetentionDays }, by)
    await this.audit.record(actor, { action: 'settings.updated', changes })
    return next
  }

  /** Emergency switch for the CLI. */
  async enableLocalLogin(actor: Actor): Promise<boolean> {
    const { enabled } = await this.settings.get('auth.localLogin')
    if (enabled) return false
    await this.settings.set('auth.localLogin', { enabled: true })
    await this.audit.record(actor, {
      action: 'settings.updated',
      changes: { localLoginEnabled: [false, true] },
    })
    return true
  }
}
