// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { InvitationInfo, MfaSetup, RecoveryCodes } from '@stashley/shared'
import type { z } from 'zod'
import type { invitationAccept, profileUpdate } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, SessionState } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import { decrypt, encrypt, type KeyRing } from '../../platform/crypto/keys.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import { renderMail, type Mailer } from '../mail/mailer.ts'
import { normalizeEmail, type UserRow, type UsersRepository } from '../users/repository.ts'
import type { AuthContext } from './context.ts'
import { FailureLimiter } from './failure-limiter.ts'
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from './passwords.ts'
import type { SessionService } from './sessions.ts'
import {
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  totpQrSvg,
  totpUri,
  verifyTotp,
} from './totp.ts'
import type { UserTokens } from './user-tokens.ts'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

export interface IssuedSession {
  cookie: string
  maxAgeSeconds: number
  state: SessionState | 'pending'
}

export interface AuthDeps {
  db: Kysely<Database>
  users: UsersRepository
  sessions: SessionService
  tokens: UserTokens
  settings: SettingsRepository
  keys: KeyRing
  audit: AuditLog
  mailer: Mailer
  appUrl: (path: string) => string
  clock?: Clock
}

function totpAad(userId: string): string {
  return `users:${userId}:totp_secret`
}

export class AuthService {
  private readonly deps: AuthDeps
  private readonly clock: Clock
  readonly accountLimiter: FailureLimiter
  readonly mfaLimiter: FailureLimiter

  constructor(deps: AuthDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.accountLimiter = new FailureLimiter({ clock: this.clock })
    this.mfaLimiter = new FailureLimiter({ clock: this.clock })
  }

  private actor(user: UserRow | undefined, meta: RequestMeta, label?: string): Actor {
    return { kind: 'user', id: user?.id ?? null, label: user?.email ?? label ?? null, ip: meta.ip }
  }

  private subject(user: UserRow) {
    return { kind: 'user', id: user.id, label: user.email }
  }

  private async initialState(user: UserRow, method: 'password' | 'invitation' | 'password_reset') {
    if (user.status === 'pending') return 'active' as const
    if (user.totp_enabled_at !== null && method === 'password') return 'mfa_required' as const
    const { enforced } = await this.deps.settings.get('auth.twoFactor')
    if (enforced && user.totp_enabled_at === null) return 'mfa_enrollment_required' as const
    return 'active' as const
  }

  private async issue(
    user: UserRow,
    method: 'password' | 'invitation' | 'password_reset',
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const state = await this.initialState(user, method)
    const session = await this.deps.sessions.create({
      userId: user.id,
      state,
      method,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    if (state === 'active') {
      await this.deps.users.update(user.id, { last_login_at: this.clock() }, this.clock())
    }
    return { cookie: session.cookie, maxAgeSeconds: session.maxAgeSeconds, state }
  }

  async login(email: string, password: string, meta: RequestMeta): Promise<IssuedSession> {
    const { enabled } = await this.deps.settings.get('auth.localLogin')
    if (!enabled) throw new AppError('local_login_disabled')
    const key = normalizeEmail(email)
    if (this.accountLimiter.retryAfter(key) > 0) throw new AppError('rate_limited')

    const user = await this.deps.users.findByEmail(key)
    const valid = await verifyPassword(user?.password_hash ?? null, password)
    if (user === undefined || !valid) {
      this.accountLimiter.fail(key)
      await this.deps.audit.record(this.actor(user, meta, key), {
        action: 'auth.sign_in.failed',
        details: { method: 'password' },
      })
      throw new AppError('invalid_credentials')
    }
    if (user.status === 'disabled') throw new AppError('account_disabled')
    this.accountLimiter.reset(key)
    if (user.password_hash !== null && needsRehash(user.password_hash)) {
      await this.deps.users.update(
        user.id,
        { password_hash: await hashPassword(password) },
        this.clock(),
      )
    }
    const issued = await this.issue(user, 'password', meta)
    if (issued.state !== 'mfa_required') {
      await this.deps.audit.record(this.actor(user, meta), {
        action: 'auth.sign_in.succeeded',
        details: { method: 'password' },
      })
    }
    return issued
  }

  /** Accepts a TOTP code or an unused recovery code. */
  private async verifySecondFactor(user: UserRow, code: string): Promise<boolean> {
    const trimmed = code.trim()
    if (/^\d{6}$/.test(trimmed)) {
      if (user.totp_secret === null) return false
      const secret = decrypt(this.deps.keys, user.totp_secret, totpAad(user.id))
      const step = await verifyTotp(secret, trimmed, user.totp_last_step)
      if (step === undefined) return false
      await this.deps.users.update(user.id, { totp_last_step: step }, this.clock())
      return true
    }
    const used = await this.deps.db
      .updateTable('user_recovery_codes')
      .set({ used_at: this.clock() })
      .where('user_id', '=', user.id)
      .where('code_hash', '=', hashRecoveryCode(trimmed))
      .where('used_at', 'is', null)
      .executeTakeFirst()
    return Number(used.numUpdatedRows) === 1
  }

  async completeMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<IssuedSession> {
    const key = auth.session.id_hash
    if (this.mfaLimiter.retryAfter(key) > 0) throw new AppError('rate_limited')
    if (!(await this.verifySecondFactor(auth.user, code))) {
      this.mfaLimiter.fail(key)
      await this.deps.audit.record(this.actor(auth.user, meta), { action: 'auth.mfa.failed' })
      throw new AppError('invalid_code')
    }
    this.mfaLimiter.reset(key)
    const session = await this.deps.sessions.rotate(auth.session, 'active', meta.ip, meta.userAgent)
    await this.deps.users.update(auth.user.id, { last_login_at: this.clock() }, this.clock())
    await this.deps.audit.record(this.actor(auth.user, meta), {
      action: 'auth.sign_in.succeeded',
      details: { method: 'password', mfa: true },
    })
    return { cookie: session.cookie, maxAgeSeconds: session.maxAgeSeconds, state: 'active' }
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.deps.sessions.revoke(auth.session.id_hash)
  }

  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.deps.users.findByEmail(email)
    if (user === undefined || user.status !== 'active' || !this.deps.mailer.enabled) return
    const token = await this.deps.tokens.issue(user.id, 'password_reset', null)
    await this.deps.mailer.send(
      renderMail(
        'password_reset',
        user.locale,
        user.email,
        this.deps.appUrl(`/password-reset/${token}`),
        user.display_name,
      ),
    )
    await this.deps.audit.record(this.actor(user, meta), {
      action: 'user.password_reset_requested',
      subject: this.subject(user),
    })
  }

  async completePasswordReset(token: string, password: string, meta: RequestMeta): Promise<void> {
    const userId = await this.deps.tokens.peek(token, 'password_reset')
    const user = userId === undefined ? undefined : await this.deps.users.findById(userId)
    if (user === undefined || user.status === 'disabled') throw new AppError('link_invalid')
    checkPasswordPolicy(password, user.email)
    const hash = await hashPassword(password)
    await writeTransaction(this.deps.db, async (trx) => {
      if ((await this.deps.tokens.consume(token, 'password_reset', trx)) !== user.id) {
        throw new AppError('link_invalid')
      }
      await this.deps.users.update(user.id, { password_hash: hash }, this.clock(), trx)
      await this.deps.sessions.revokeAllForUser(user.id, trx)
    })
    this.accountLimiter.reset(user.email)
    await this.deps.audit.record(this.actor(user, meta), {
      action: 'user.password_reset',
      subject: this.subject(user),
    })
  }

  async invitationInfo(token: string): Promise<InvitationInfo> {
    const userId = await this.deps.tokens.peek(token, 'invitation')
    const user = userId === undefined ? undefined : await this.deps.users.findById(userId)
    if (user === undefined || user.status === 'disabled') throw new AppError('link_invalid')
    return { email: user.email, displayName: user.display_name }
  }

  async acceptInvitation(
    token: string,
    input: z.infer<typeof invitationAccept>,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const info = await this.invitationInfo(token)
    checkPasswordPolicy(input.password, info.email)
    const hash = await hashPassword(input.password)
    const userId = await writeTransaction(this.deps.db, async (trx) => {
      const id = await this.deps.tokens.consume(token, 'invitation', trx)
      if (id === undefined) throw new AppError('link_invalid')
      await this.deps.users.update(
        id,
        {
          password_hash: hash,
          ...(input.displayName !== undefined && { display_name: input.displayName }),
        },
        this.clock(),
        trx,
      )
      return id
    })
    const user = await this.deps.users.findById(userId)
    if (user === undefined) throw new AppError('link_invalid')
    await this.deps.audit.record(this.actor(user, meta), {
      action: 'user.invitation_accepted',
      subject: this.subject(user),
    })
    return this.issue(user, 'invitation', meta)
  }

  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!(await verifyPassword(auth.user.password_hash, currentPassword))) {
      throw fieldError('currentPassword', 'incorrect')
    }
    checkPasswordPolicy(newPassword, auth.user.email, 'newPassword')
    await this.deps.users.update(
      auth.user.id,
      { password_hash: await hashPassword(newPassword) },
      this.clock(),
    )
    // Other sessions end; the current one stays signed in.
    await this.deps.db
      .deleteFrom('sessions')
      .where('user_id', '=', auth.user.id)
      .where('id_hash', '!=', auth.session.id_hash)
      .execute()
    await this.deps.audit.record(this.actor(auth.user, meta), {
      action: 'user.password_changed',
      subject: this.subject(auth.user),
    })
  }

  async updateProfile(
    auth: AuthContext,
    input: z.infer<typeof profileUpdate>,
    meta: RequestMeta,
  ): Promise<void> {
    const changes: Record<string, [unknown, unknown]> = {}
    const values: Partial<UserRow> = {}
    const mapping = [
      ['displayName', 'display_name'],
      ['locale', 'locale'],
      ['formatLocale', 'format_locale'],
      ['theme', 'theme'],
    ] as const
    for (const [field, column] of mapping) {
      const next = input[field]
      if (next === undefined || next === auth.user[column]) continue
      changes[field] = [auth.user[column], next]
      ;(values as Record<string, unknown>)[column] = next
    }
    if (Object.keys(changes).length === 0) return
    await this.deps.users.update(auth.user.id, values, this.clock())
    await this.deps.audit.record(this.actor(auth.user, meta), {
      action: 'user.profile_updated',
      subject: this.subject(auth.user),
      changes,
    })
  }

  async startMfaSetup(auth: AuthContext): Promise<MfaSetup> {
    if (auth.user.totp_enabled_at !== null) throw new AppError('conflict')
    const secret = newTotpSecret()
    await this.deps.users.update(
      auth.user.id,
      { totp_secret: encrypt(this.deps.keys, secret, totpAad(auth.user.id)), totp_last_step: null },
      this.clock(),
    )
    const uri = totpUri(secret, auth.user.email)
    return { secret, uri, qrSvg: await totpQrSvg(uri) }
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const codes = newRecoveryCodes()
    await writeTransaction(this.deps.db, async (trx) => {
      await trx.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute()
      await trx
        .insertInto('user_recovery_codes')
        .values(
          codes.map((code) => ({
            id: uuidv7(),
            user_id: userId,
            code_hash: hashRecoveryCode(code),
            used_at: null,
          })),
        )
        .execute()
    })
    return codes
  }

  /** Activates 2FA. A session waiting for enforced enrollment becomes a full session. */
  async confirmMfa(
    auth: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<RecoveryCodes & { session?: IssuedSession }> {
    const user = auth.user
    if (user.totp_enabled_at !== null || user.totp_secret === null) throw new AppError('conflict')
    const secret = decrypt(this.deps.keys, user.totp_secret, totpAad(user.id))
    const step = await verifyTotp(secret, code.trim(), null)
    if (step === undefined) throw new AppError('invalid_code')
    await this.deps.users.update(
      user.id,
      { totp_enabled_at: this.clock(), totp_last_step: step },
      this.clock(),
    )
    const recoveryCodes = await this.replaceRecoveryCodes(user.id)
    await this.deps.audit.record(this.actor(user, meta), {
      action: 'user.mfa_enabled',
      subject: this.subject(user),
    })
    if (auth.session.state === 'active') return { recoveryCodes }
    const session = await this.deps.sessions.rotate(auth.session, 'active', meta.ip, meta.userAgent)
    await this.deps.users.update(user.id, { last_login_at: this.clock() }, this.clock())
    return {
      recoveryCodes,
      session: { cookie: session.cookie, maxAgeSeconds: session.maxAgeSeconds, state: 'active' },
    }
  }

  async disableMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<void> {
    const { enforced } = await this.deps.settings.get('auth.twoFactor')
    if (enforced) throw new AppError('forbidden')
    if (auth.user.totp_enabled_at === null) throw new AppError('conflict')
    if (!(await this.verifySecondFactor(auth.user, code))) throw new AppError('invalid_code')
    await this.clearMfa(auth.user.id)
    await this.deps.audit.record(this.actor(auth.user, meta), {
      action: 'user.mfa_disabled',
      subject: this.subject(auth.user),
    })
  }

  async clearMfa(userId: string): Promise<void> {
    await writeTransaction(this.deps.db, async (trx) => {
      await this.deps.users.update(
        userId,
        { totp_secret: null, totp_enabled_at: null, totp_last_step: null },
        this.clock(),
        trx,
      )
      await trx.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute()
    })
  }

  async regenerateRecoveryCodes(
    auth: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<RecoveryCodes> {
    if (auth.user.totp_enabled_at === null) throw new AppError('conflict')
    if (!(await this.verifySecondFactor(auth.user, code))) throw new AppError('invalid_code')
    const recoveryCodes = await this.replaceRecoveryCodes(auth.user.id)
    await this.deps.audit.record(this.actor(auth.user, meta), {
      action: 'user.recovery_codes_regenerated',
      subject: this.subject(auth.user),
    })
    return { recoveryCodes }
  }
}
