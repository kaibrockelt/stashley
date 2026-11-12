// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IdentityProvider, identityProviderInput } from '@stashley/shared'
import type { Kysely } from 'kysely'
import * as client from 'openid-client'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import type { Database, IdentityProvidersTable } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { minute, systemClock, type Clock } from '../../platform/clock.ts'
import { decrypt, encrypt, type KeyRing } from '../../platform/crypto/keys.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import { normalizeEmail, type UserRow, type UsersRepository } from '../users/repository.ts'
import type { IssuedSession, RequestMeta } from './service.ts'
import type { SessionService } from './sessions.ts'

export type ProviderRow = IdentityProvidersTable

/** Claims Stashley reads from the ID token. */
export interface OidcClaims {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
}

/** Wraps openid-client so tests can replace the network side. */
export interface OidcClient {
  authorizationUrl(provider: ProviderRow, params: Record<string, string>): Promise<URL>
  exchange(
    provider: ProviderRow,
    callbackUrl: URL,
    checks: { verifier: string; state: string; nonce: string },
  ): Promise<OidcClaims>
  /** Fetches the provider metadata to check the issuer URL. */
  check(issuerUrl: string, clientId: string): Promise<void>
}

export function createOidcClient(options: { keys: KeyRing; allowHttp: boolean }): OidcClient {
  const configs = new Map<string, { updatedAt: number; config: Promise<client.Configuration> }>()

  function discover(issuerUrl: string, clientId: string, secret: string | undefined) {
    const url = new URL(issuerUrl)
    const insecure = url.protocol === 'http:'
    if (insecure && !options.allowHttp) throw new AppError('provider_unreachable')
    return client.discovery(url, clientId, secret, undefined, {
      ...(insecure && { execute: [client.allowInsecureRequests] }),
      timeout: 10,
    })
  }

  function configFor(provider: ProviderRow): Promise<client.Configuration> {
    const cached = configs.get(provider.id)
    if (cached !== undefined && cached.updatedAt === provider.updated_at) return cached.config
    const secret =
      provider.client_secret === null
        ? undefined
        : decrypt(
            options.keys,
            provider.client_secret,
            `identity_providers:${provider.id}:client_secret`,
          )
    const config = discover(provider.issuer_url, provider.client_id, secret)
    config.catch(() => configs.delete(provider.id))
    configs.set(provider.id, { updatedAt: provider.updated_at, config })
    return config
  }

  return {
    async authorizationUrl(provider, params) {
      return client.buildAuthorizationUrl(await configFor(provider), params)
    },
    async exchange(provider, callbackUrl, checks) {
      const tokens = await client.authorizationCodeGrant(await configFor(provider), callbackUrl, {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (claims === undefined) throw new Error('No ID token claims')
      return claims
    },
    async check(issuerUrl, clientId) {
      try {
        await discover(issuerUrl, clientId, undefined)
      } catch {
        throw new AppError('provider_unreachable')
      }
    },
  }
}

export interface OidcDeps {
  db: Kysely<Database>
  users: UsersRepository
  sessions: SessionService
  settings: SettingsRepository
  keys: KeyRing
  audit: AuditLog
  client: OidcClient
  appUrl: (path: string) => string
  clock?: Clock
}

/** Short-lived, signed state for one authorization request. */
interface FlowState {
  provider: string
  state: string
  nonce: string
  verifier: string
  expires: number
}

export const oidcStateCookie = 'stashley_oidc'
const flowLifetime = 10 * minute

export class OidcError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'OidcError'
    this.code = code
  }
}

export class OidcService {
  private readonly deps: OidcDeps
  private readonly clock: Clock

  constructor(deps: OidcDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  callbackUrl(slug: string): string {
    return this.deps.appUrl(`/auth/oidc/${slug}/callback`)
  }

  private secretAad(id: string): string {
    return `identity_providers:${id}:client_secret`
  }

  private toApi(row: ProviderRow): IdentityProvider {
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      issuerUrl: row.issuer_url,
      clientId: row.client_id,
      hasClientSecret: row.client_secret !== null,
      scopes: row.scopes,
      autoApproveDomains: JSON.parse(row.auto_approve_domains) as string[],
      enabled: row.enabled === 1,
      callbackUrl: this.callbackUrl(row.slug),
    }
  }

  async list(): Promise<IdentityProvider[]> {
    const rows = await this.deps.db
      .selectFrom('identity_providers')
      .selectAll()
      .orderBy('position')
      .orderBy('display_name')
      .execute()
    return rows.map((row) => this.toApi(row))
  }

  async enabledProviders(): Promise<{ slug: string; displayName: string }[]> {
    const rows = await this.deps.db
      .selectFrom('identity_providers')
      .select(['slug', 'display_name'])
      .where('enabled', '=', 1)
      .orderBy('position')
      .orderBy('display_name')
      .execute()
    return rows.map((row) => ({ slug: row.slug, displayName: row.display_name }))
  }

  async create(
    actor: Actor,
    input: z.infer<typeof identityProviderInput>,
  ): Promise<IdentityProvider> {
    await this.deps.client.check(input.issuerUrl, input.clientId)
    const existing = await this.deps.db
      .selectFrom('identity_providers')
      .select('id')
      .where('slug', '=', input.slug)
      .executeTakeFirst()
    if (existing !== undefined) throw fieldError('slug', 'taken')
    const id = uuidv7()
    const now = this.clock()
    const row: ProviderRow = {
      id,
      slug: input.slug,
      display_name: input.displayName,
      issuer_url: input.issuerUrl,
      client_id: input.clientId,
      client_secret:
        input.clientSecret === undefined || input.clientSecret === null
          ? null
          : encrypt(this.deps.keys, input.clientSecret, this.secretAad(id)),
      scopes: input.scopes,
      auto_approve_domains: JSON.stringify(input.autoApproveDomains),
      enabled: input.enabled ? 1 : 0,
      position: now,
      created_at: now,
      updated_at: now,
    }
    await this.deps.db.insertInto('identity_providers').values(row).execute()
    await this.deps.audit.record(actor, {
      action: 'identity_provider.created',
      subject: { kind: 'identity_provider', id, label: input.displayName },
      details: { issuerUrl: input.issuerUrl, enabled: input.enabled },
    })
    return this.toApi(row)
  }

  async update(
    actor: Actor,
    id: string,
    input: z.infer<typeof identityProviderInput>,
  ): Promise<IdentityProvider> {
    const row = await this.deps.db
      .selectFrom('identity_providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    if (input.issuerUrl !== row.issuer_url || input.clientId !== row.client_id) {
      await this.deps.client.check(input.issuerUrl, input.clientId)
    }
    const clash = await this.deps.db
      .selectFrom('identity_providers')
      .select('id')
      .where('slug', '=', input.slug)
      .where('id', '!=', id)
      .executeTakeFirst()
    if (clash !== undefined) throw fieldError('slug', 'taken')
    if (!input.enabled && row.enabled === 1) await this.ensureNotLastSignInPath(id)
    const next: ProviderRow = {
      ...row,
      slug: input.slug,
      display_name: input.displayName,
      issuer_url: input.issuerUrl,
      client_id: input.clientId,
      client_secret:
        input.clientSecret === undefined
          ? row.client_secret
          : input.clientSecret === null
            ? null
            : encrypt(this.deps.keys, input.clientSecret, this.secretAad(id)),
      scopes: input.scopes,
      auto_approve_domains: JSON.stringify(input.autoApproveDomains),
      enabled: input.enabled ? 1 : 0,
      updated_at: this.clock(),
    }
    await this.deps.db.updateTable('identity_providers').set(next).where('id', '=', id).execute()
    const changes: Record<string, [unknown, unknown]> = {}
    for (const key of [
      'slug',
      'display_name',
      'issuer_url',
      'client_id',
      'scopes',
      'auto_approve_domains',
      'enabled',
    ] as const) {
      if (row[key] !== next[key]) changes[key] = [row[key], next[key]]
    }
    if (input.clientSecret !== undefined)
      changes.client_secret = ['***', input.clientSecret === null ? null : '***']
    await this.deps.audit.record(actor, {
      action: 'identity_provider.updated',
      subject: { kind: 'identity_provider', id, label: next.display_name },
      changes,
    })
    return this.toApi(next)
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const row = await this.deps.db
      .selectFrom('identity_providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    if (row.enabled === 1) await this.ensureNotLastSignInPath(id)
    await this.deps.db.deleteFrom('identity_providers').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'identity_provider.deleted',
      subject: { kind: 'identity_provider', id, label: row.display_name },
    })
  }

  /** With password sign-in off, the last enabled provider cannot be removed or disabled. */
  private async ensureNotLastSignInPath(id: string): Promise<void> {
    const { enabled } = await this.deps.settings.get('auth.localLogin')
    if (enabled) return
    const others = await this.deps.db
      .selectFrom('identity_providers')
      .select('id')
      .where('enabled', '=', 1)
      .where('id', '!=', id)
      .execute()
    if (others.length === 0) throw new AppError('conflict')
  }

  private signState(payload: FlowState): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const mac = createHmac('sha256', this.deps.keys.key('state')).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  private readState(value: string | undefined): FlowState | undefined {
    if (value === undefined) return undefined
    const [body, mac] = value.split('.')
    if (body === undefined || mac === undefined) return undefined
    const expected = Buffer.from(
      createHmac('sha256', this.deps.keys.key('state')).update(body).digest('base64url'),
    )
    const actual = Buffer.from(mac)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    const state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FlowState
    return state.expires > this.clock() ? state : undefined
  }

  private async provider(slug: string): Promise<ProviderRow> {
    const row = await this.deps.db
      .selectFrom('identity_providers')
      .selectAll()
      .where('slug', '=', slug)
      .where('enabled', '=', 1)
      .executeTakeFirst()
    if (row === undefined) throw new OidcError('provider_unavailable')
    return row
  }

  /** Starts an authorization request; returns the redirect URL and the state cookie value. */
  async start(slug: string): Promise<{ url: string; cookie: string; maxAgeSeconds: number }> {
    const provider = await this.provider(slug)
    const verifier = client.randomPKCECodeVerifier()
    const flow: FlowState = {
      provider: slug,
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier,
      expires: this.clock() + flowLifetime,
    }
    let url: URL
    try {
      url = await this.deps.client.authorizationUrl(provider, {
        redirect_uri: this.callbackUrl(slug),
        scope: provider.scopes,
        response_type: 'code',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state: flow.state,
        nonce: flow.nonce,
      })
    } catch {
      throw new OidcError('provider_unreachable')
    }
    return { url: url.href, cookie: this.signState(flow), maxAgeSeconds: flowLifetime / 1000 }
  }

  /** Completes sign-in: matches or creates the account and opens a session. */
  async callback(
    slug: string,
    callbackUrl: URL,
    stateCookie: string | undefined,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const flow = this.readState(stateCookie)
    if (flow === undefined || flow.provider !== slug) throw new OidcError('state_invalid')
    const provider = await this.provider(slug)
    let claims: OidcClaims
    try {
      claims = await this.deps.client.exchange(provider, callbackUrl, flow)
    } catch {
      throw new OidcError('sign_in_failed')
    }
    const user = await this.matchAccount(provider, claims, meta)
    if (user.status === 'disabled') throw new OidcError('account_disabled')
    const session = await this.deps.sessions.create({
      userId: user.id,
      state: 'active',
      method: 'oidc',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    if (user.status === 'active') {
      await this.deps.users.update(user.id, { last_login_at: this.clock() }, this.clock())
    }
    await this.deps.audit.record(
      { kind: 'user', id: user.id, label: user.email, ip: meta.ip },
      { action: 'auth.sign_in.succeeded', details: { method: 'oidc', provider: slug } },
    )
    return {
      cookie: session.cookie,
      maxAgeSeconds: session.maxAgeSeconds,
      state: user.status === 'pending' ? 'pending' : 'active',
    }
  }

  /**
   * Finds the account for an identity. An existing account is linked only through an email
   * address the provider has verified; otherwise a new account is created, pending approval
   * unless its domain is approved automatically.
   */
  private async matchAccount(
    provider: ProviderRow,
    claims: OidcClaims,
    meta: RequestMeta,
  ): Promise<UserRow> {
    const linked = await this.deps.db
      .selectFrom('user_identities')
      .innerJoin('users', 'users.id', 'user_identities.user_id')
      .selectAll('users')
      .where('user_identities.provider_id', '=', provider.id)
      .where('user_identities.subject', '=', claims.sub)
      .executeTakeFirst()
    if (linked !== undefined) return linked

    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : undefined
    if (email === undefined || email === '') throw new OidcError('email_missing')
    const verified = claims.email_verified === true
    const now = this.clock()
    const actor: Actor = { kind: 'system', id: null, label: null, ip: meta.ip }

    let user = await this.deps.users.findByEmail(email)
    if (user !== undefined) {
      if (!verified) throw new OidcError('email_unverified')
    } else {
      const domain = email.split('@')[1] ?? ''
      const approved = (JSON.parse(provider.auto_approve_domains) as string[]).includes(domain)
      user = await this.deps.users.create(
        {
          email,
          displayName: claims.name?.trim() || (email.split('@')[0] ?? email),
          systemRole: 'user',
          status: approved && verified ? 'active' : 'pending',
        },
        now,
      )
      await this.deps.audit.record(actor, {
        action: 'user.registered',
        subject: { kind: 'user', id: user.id, label: user.email },
        details: { provider: provider.slug, status: user.status },
      })
    }
    await this.deps.db
      .insertInto('user_identities')
      .values({
        id: uuidv7(),
        user_id: user.id,
        provider_id: provider.id,
        subject: claims.sub,
        email,
        created_at: now,
      })
      .execute()
    await this.deps.audit.record(actor, {
      action: 'user.identity_linked',
      subject: { kind: 'user', id: user.id, label: user.email },
      details: { provider: provider.slug },
    })
    return user
  }
}
