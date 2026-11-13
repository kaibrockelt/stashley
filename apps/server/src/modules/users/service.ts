// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminUser, LinkResult, userInvite, userUpdate } from '@stashley/shared'
import type { Kysely } from 'kysely'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import { checkPasswordPolicy, hashPassword } from '../auth/passwords.ts'
import type { SessionService } from '../auth/sessions.ts'
import type { AuthService } from '../auth/service.ts'
import { ensureAdminSignInPath } from '../auth/sign-in-paths.ts'
import type { UserTokens } from '../auth/user-tokens.ts'
import { renderMail, type Mailer } from '../mail/mailer.ts'
import type { UserRow, UsersRepository } from './repository.ts'

export interface UsersDeps {
  db: Kysely<Database>
  settings: SettingsRepository
  users: UsersRepository
  sessions: SessionService
  tokens: UserTokens
  auth: AuthService
  audit: AuditLog
  mailer: Mailer
  appUrl: (path: string) => string
  clock?: Clock
}

function subject(user: UserRow) {
  return { kind: 'user', id: user.id, label: user.email }
}

export class UsersService {
  private readonly deps: UsersDeps
  private readonly clock: Clock

  constructor(deps: UsersDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  private async require(id: string): Promise<UserRow> {
    const user = await this.deps.users.findById(id)
    if (user === undefined) throw new AppError('not_found')
    return user
  }

  private async deliver(
    user: UserRow,
    template: 'invitation' | 'password_reset',
    createdBy: string | null,
  ): Promise<LinkResult> {
    const token = await this.deps.tokens.issue(
      user.id,
      template === 'invitation' ? 'invitation' : 'password_reset',
      createdBy,
    )
    const path = template === 'invitation' ? `/invitation#${token}` : `/password-reset#${token}`
    const link = this.deps.appUrl(path)
    const emailed = await this.deps.mailer.send(
      renderMail(template, user.locale, user.email, link, user.display_name),
    )
    return { link: emailed ? null : link, emailed }
  }

  async invite(
    actor: Actor,
    input: z.infer<typeof userInvite>,
  ): Promise<{ user: AdminUser } & LinkResult> {
    if ((await this.deps.users.findByEmail(input.email)) !== undefined) {
      throw fieldError('email', 'taken')
    }
    const user = await this.deps.users.create(
      {
        email: input.email,
        displayName: input.displayName,
        systemRole: input.systemRole,
        status: 'active',
        invitedBy: actor.id,
      },
      this.clock(),
    )
    await this.deps.audit.record(actor, {
      action: 'user.invited',
      subject: subject(user),
      details: { systemRole: user.system_role },
    })
    const result = await this.deliver(user, 'invitation', actor.id)
    const admin = await this.deps.users.getAdminUser(user.id)
    if (admin === undefined) throw new AppError('internal_error')
    return { user: admin, ...result }
  }

  /** Changes role, status or name. The last active admin can be neither demoted nor disabled. */
  async update(actor: Actor, id: string, input: z.infer<typeof userUpdate>): Promise<AdminUser> {
    if (id === actor.id && (input.systemRole !== undefined || input.status !== undefined)) {
      // Prevents locking oneself out; another admin has to make this change.
      throw new AppError('forbidden')
    }
    const changes = await writeTransaction(this.deps.db, async (trx) => {
      const user = await this.deps.users.findById(id, trx)
      if (user === undefined) throw new AppError('not_found')
      const next = {
        display_name: input.displayName ?? user.display_name,
        system_role: input.systemRole ?? user.system_role,
        status: input.status ?? user.status,
      }
      const losesAdmin =
        user.system_role === 'admin' &&
        user.status === 'active' &&
        (next.system_role !== 'admin' || next.status !== 'active')
      if (losesAdmin && (await this.deps.users.countActiveAdmins(trx, user.id)) === 0) {
        throw new AppError('last_admin')
      }
      if (losesAdmin) await ensureAdminSignInPath(trx, this.deps.settings, { userId: user.id })
      const diff: Record<string, [unknown, unknown]> = {}
      if (next.display_name !== user.display_name)
        diff.displayName = [user.display_name, next.display_name]
      if (next.system_role !== user.system_role)
        diff.systemRole = [user.system_role, next.system_role]
      if (next.status !== user.status) diff.status = [user.status, next.status]
      if (Object.keys(diff).length === 0) return { user, diff }
      await this.deps.users.update(id, next, this.clock(), trx)
      if (next.status === 'disabled' || next.system_role !== user.system_role) {
        // Sessions end immediately; a role change takes effect with the next sign-in.
        await this.deps.sessions.revokeAllForUser(id, trx)
      }
      return { user, diff }
    })
    if (Object.keys(changes.diff).length > 0) {
      const action =
        changes.diff.status?.[0] === 'pending' && changes.diff.status[1] === 'active'
          ? 'user.approved'
          : 'user.updated'
      await this.deps.audit.record(actor, {
        action,
        subject: subject(changes.user),
        changes: changes.diff,
      })
    }
    const result = await this.deps.users.getAdminUser(id)
    if (result === undefined) throw new AppError('not_found')
    return result
  }

  async sendPasswordReset(actor: Actor, id: string): Promise<LinkResult> {
    const user = await this.require(id)
    if (user.status !== 'active') throw new AppError('conflict')
    const result = await this.deliver(user, 'password_reset', actor.id)
    await this.deps.audit.record(actor, {
      action: 'user.password_reset_issued',
      subject: subject(user),
    })
    return result
  }

  async resendInvitation(actor: Actor, id: string): Promise<LinkResult> {
    const user = await this.require(id)
    if (user.password_hash !== null || user.status !== 'active') throw new AppError('conflict')
    const result = await this.deliver(user, 'invitation', actor.id)
    await this.deps.audit.record(actor, {
      action: 'user.invitation_reissued',
      subject: subject(user),
    })
    return result
  }

  /** CLI: clears 2FA of an account found by email, e.g. when the only admin lost the device. */
  async resetMfaByEmail(actor: Actor, email: string): Promise<void> {
    const user = await this.deps.users.findByEmail(email)
    if (user === undefined) throw new AppError('not_found')
    await this.resetMfa(actor, user.id)
  }

  async resetMfa(actor: Actor, id: string): Promise<void> {
    const user = await this.require(id)
    await this.deps.auth.clearMfa(user.id)
    await this.deps.sessions.revokeAllForUser(user.id)
    await this.deps.audit.record(actor, { action: 'user.mfa_reset', subject: subject(user) })
  }

  async removeIdentity(actor: Actor, userId: string, identityId: string): Promise<void> {
    const user = await this.require(userId)
    await writeTransaction(this.deps.db, async (trx) => {
      await ensureAdminSignInPath(trx, this.deps.settings, { identityId })
      const result = await trx
        .deleteFrom('user_identities')
        .where('id', '=', identityId)
        .where('user_id', '=', userId)
        .executeTakeFirst()
      if (Number(result.numDeletedRows) === 0) throw new AppError('not_found')
    })
    await this.deps.audit.record(actor, {
      action: 'user.identity_removed',
      subject: subject(user),
      details: { identityId },
    })
  }

  /** Creates the first admin from INITIAL_ADMIN_* while no admin account exists. */
  async bootstrapAdmin(
    actor: Actor,
    initial: { email: string; password: string } | undefined,
  ): Promise<UserRow | undefined> {
    if (initial === undefined || (await this.deps.users.countAdmins()) > 0) return undefined
    if ((await this.deps.users.findByEmail(initial.email)) !== undefined) return undefined
    return this.createAdmin(actor, initial.email, initial.password)
  }

  async createAdmin(
    actor: Actor,
    email: string,
    password: string,
    displayName?: string,
  ): Promise<UserRow> {
    if ((await this.deps.users.findByEmail(email)) !== undefined) throw fieldError('email', 'taken')
    checkPasswordPolicy(password, email)
    const user = await this.deps.users.create(
      {
        email,
        displayName: displayName ?? email.split('@')[0] ?? email,
        systemRole: 'admin',
        status: 'active',
        passwordHash: await hashPassword(password),
      },
      this.clock(),
    )
    await this.deps.audit.record(actor, {
      action: 'user.created',
      subject: subject(user),
      details: { systemRole: 'admin' },
    })
    return user
  }

  /** Sets a password directly (CLI) or returns a reset link. Ends all sessions of the account. */
  async resetPassword(
    actor: Actor,
    email: string,
    password: string | undefined,
  ): Promise<{ link: string | null }> {
    const user = await this.deps.users.findByEmail(email)
    if (user === undefined) throw new AppError('not_found')
    if (password === undefined) {
      const token = await this.deps.tokens.issue(user.id, 'password_reset', null)
      await this.deps.audit.record(actor, {
        action: 'user.password_reset_issued',
        subject: subject(user),
      })
      return { link: this.deps.appUrl(`/password-reset#${token}`) }
    }
    checkPasswordPolicy(password, user.email)
    await this.deps.users.update(
      user.id,
      { password_hash: await hashPassword(password) },
      this.clock(),
    )
    await this.deps.sessions.revokeAllForUser(user.id)
    await this.deps.audit.record(actor, { action: 'user.password_reset', subject: subject(user) })
    return { link: null }
  }
}
