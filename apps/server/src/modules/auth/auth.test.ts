// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AdminUser,
  AuditEvent,
  IdentityProvider,
  InvitationInfo,
  LinkResult,
  MfaSetup,
  Page,
  ProblemDocument,
  RecoveryCodes,
} from '@stashley/shared'
import { generate } from 'otplib'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../../app.ts'
import { minute } from '../../platform/clock.ts'
import { logPath } from '../../platform/http/server.ts'
import { TestClient } from '../../test/client.ts'
import { testConfig } from '../../test/helpers.ts'
import type { MailMessage, Mailer } from '../mail/mailer.ts'
import type { OidcClaims, OidcClient } from './oidc.ts'

const adminEmail = 'admin@example.com'
const adminPassword = 'correct horse battery staple'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

interface Setup {
  server: Server
  admin: TestClient
  client: () => TestClient
  mails: MailMessage[]
  oidc: { claims: OidcClaims; failExchange: boolean }
  advance: (ms: number) => void
}

async function setup(options: { smtp?: boolean } = {}): Promise<Setup> {
  const config = testConfig({
    INITIAL_ADMIN_EMAIL: adminEmail,
    INITIAL_ADMIN_PASSWORD: adminPassword,
  })
  const mails: MailMessage[] = []
  const mailer: Mailer = {
    enabled: options.smtp === true,
    send(message) {
      if (options.smtp !== true) return Promise.resolve(false)
      mails.push(message)
      return Promise.resolve(true)
    },
  }
  const oidc = { claims: { sub: 'subject-1' } as OidcClaims, failExchange: false }
  const oidcClient: OidcClient = {
    authorizationUrl: (_provider, params) =>
      Promise.resolve(
        new URL(`https://idp.example.com/authorize?${new URLSearchParams(params).toString()}`),
      ),
    exchange: () =>
      oidc.failExchange ? Promise.reject(new Error('denied')) : Promise.resolve(oidc.claims),
    check: () => Promise.resolve(),
  }
  let offset = 0
  const server = await createServer(config, {
    quiet: true,
    listen: false,
    overrides: { mailer, oidcClient, clock: () => Date.now() + offset },
  })
  servers.push(server)
  await server.start()
  const admin = new TestClient(server.app)
  expect((await admin.login(adminEmail, adminPassword)).statusCode).toBe(200)
  return {
    server,
    admin,
    client: () => new TestClient(server.app),
    mails,
    oidc,
    advance: (ms) => {
      offset += ms
    },
  }
}

function problem(response: { json: () => unknown }): ProblemDocument {
  return response.json() as ProblemDocument
}

async function invite(
  s: Setup,
  email: string,
  systemRole: 'admin' | 'manager' | 'user' = 'user',
): Promise<{ user: AdminUser; link: string | null }> {
  const response = await s.admin.send('POST', '/internal/admin/users', {
    email,
    displayName: email.split('@')[0],
    systemRole,
  })
  expect(response.statusCode).toBe(201)
  return response.json()
}

async function createUser(
  s: Setup,
  email: string,
  password: string,
  systemRole: 'admin' | 'manager' | 'user' = 'user',
): Promise<{ user: AdminUser; client: TestClient }> {
  const { user, link } = await invite(s, email, systemRole)
  const token = link?.split('#').at(-1) ?? ''
  const client = s.client()
  const accepted = await client.send('POST', '/internal/invitations/accept', { token, password })
  expect(accepted.statusCode).toBe(200)
  return { user, client }
}

describe('local sign-in', () => {
  it('creates the initial admin and signs in', async () => {
    const { admin } = await setup()
    const session = await admin.session()
    expect(session.state).toBe('active')
    expect(session.user).toMatchObject({
      email: adminEmail,
      systemRole: 'admin',
      hasPassword: true,
    })
    expect(session.instance.localLogin).toBe(true)
  })

  it('rejects wrong passwords and records the failure', async () => {
    const s = await setup()
    const client = s.client()
    const response = await client.login(adminEmail, 'wrong password!!')
    expect(response.statusCode).toBe(401)
    expect(problem(response).code).toBe('invalid_credentials')
    const unknown = await client.login('nobody@example.com', 'wrong password!!')
    expect(problem(unknown).code).toBe('invalid_credentials')
    const audit = await s.admin.request('GET', '/internal/admin/audit?action=auth.sign_in.failed')
    expect(audit.json<Page<AuditEvent>>().data).toHaveLength(2)
  })

  it('blocks an account after repeated failures', async () => {
    const s = await setup()
    const client = s.client()
    for (let i = 0; i < 5; i += 1) await client.login(adminEmail, 'wrong password!!')
    const blocked = await client.login(adminEmail, adminPassword)
    expect(problem(blocked).code).toBe('rate_limited')
  })

  it('requires a CSRF token bound to the session and a same-origin request', async () => {
    const s = await setup()
    const client = s.client()
    await client.session()
    const missing = await client.request(
      'POST',
      '/internal/auth/login',
      { email: adminEmail, password: adminPassword },
      { 'x-csrf-token': '' },
    )
    expect(problem(missing).code).toBe('csrf_failed')
    const crossSite = await client.request(
      'POST',
      '/internal/auth/login',
      { email: adminEmail, password: adminPassword },
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(problem(crossSite).code).toBe('csrf_failed')
    // A token from before sign-in is not valid for the new session.
    const stale = await s.admin.request('POST', '/internal/auth/logout')
    expect(problem(stale).code).toBe('csrf_failed')
  })

  it('applies the CSRF checks to the matched route, not the raw URL', async () => {
    const s = await setup()
    const client = s.client()
    const { csrfToken } = await client.session()
    const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    const login = (url: string, headers: Record<string, string>) =>
      s.server.app.inject({
        method: 'POST',
        url,
        headers: { cookie, 'content-type': 'application/json', ...headers },
        payload: JSON.stringify({ email: adminEmail, password: adminPassword }),
      })
    // The router decodes `%69` to `i`; the checks must still apply.
    const encoded = await login('/%69nternal/auth/login', { 'sec-fetch-site': 'cross-site' })
    expect(problem(encoded).code).toBe('csrf_failed')
    // A valid token alone is not enough without Sec-Fetch-Site or Origin.
    const bare = await login('/internal/auth/login', { 'x-csrf-token': csrfToken })
    expect(problem(bare).code).toBe('csrf_failed')
    const foreign = await login('/internal/auth/login', {
      'x-csrf-token': csrfToken,
      origin: 'https://evil.example',
    })
    expect(problem(foreign).code).toBe('csrf_failed')
    const ok = await login('/internal/auth/login', {
      'x-csrf-token': csrfToken,
      origin: 'http://localhost:8080',
    })
    expect(ok.statusCode).toBe(200)
  })

  it('records why a sign-in failed', async () => {
    const s = await setup()
    const { user } = await createUser(s, 'eva@example.com', 'evas long passphrase')
    await s.admin.send('PATCH', `/internal/admin/users/${user.id}`, { status: 'disabled' })
    const client = s.client()
    const disabled = await client.login('eva@example.com', 'evas long passphrase')
    expect(problem(disabled).code).toBe('account_disabled')
    for (let i = 0; i < 5; i += 1) await client.login(adminEmail, 'wrong password!!')
    expect(problem(await client.login(adminEmail, adminPassword)).code).toBe('rate_limited')
    const audit = await s.admin.request('GET', '/internal/admin/audit?action=auth.sign_in.failed')
    const reasons = audit.json<Page<AuditEvent>>().data.map((event) => event.details?.reason)
    expect(new Set(reasons)).toEqual(
      new Set(['account_disabled', 'invalid_credentials', 'rate_limited']),
    )
  })

  it('sets a hardened session cookie and ends the session on logout', async () => {
    const s = await setup()
    const client = s.client()
    const response = await client.login(adminEmail, adminPassword)
    const cookie = response.cookies.find((c) => c.name === 'stashley_session')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
    expect(response.headers['cache-control']).toBe('no-store')
    expect((await client.send('POST', '/internal/auth/logout')).statusCode).toBe(204)
    expect((await client.session()).state).toBe('anonymous')
  })

  it('ends idle sessions', async () => {
    const s = await setup()
    s.advance(13 * 60 * minute)
    expect((await s.admin.session()).state).toBe('anonymous')
  })

  it('rejects forged session cookies', async () => {
    const s = await setup()
    const client = s.client()
    client.cookies.set('stashley_session', `${'a'.repeat(43)}.forged`)
    expect((await client.session()).state).toBe('anonymous')
  })
})

describe('passwords', () => {
  it('enforces the password policy', async () => {
    const s = await setup()
    const { link } = await invite(s, 'pat@example.com')
    const token = link?.split('#').at(-1) ?? ''
    const client = s.client()
    for (const [password, code] of [
      ['short', 'too_short'],
      ['123456789012', 'too_common'],
      ['pat@example.com', 'matches_email'],
    ] as const) {
      const response = await client.send('POST', '/internal/invitations/accept', {
        token,
        password,
      })
      expect(problem(response).errors?.[0]?.code).toBe(code)
    }
  })

  it('changes the password and ends other sessions', async () => {
    const s = await setup()
    const other = s.client()
    await other.login(adminEmail, adminPassword)
    const wrong = await s.admin.send('POST', '/internal/profile/password', {
      currentPassword: 'not the password',
      newPassword: 'another long passphrase',
    })
    expect(problem(wrong).errors?.[0]).toEqual({ field: 'currentPassword', code: 'incorrect' })
    const ok = await s.admin.send('POST', '/internal/profile/password', {
      currentPassword: adminPassword,
      newPassword: 'another long passphrase',
    })
    expect(ok.statusCode).toBe(204)
    expect((await s.admin.session()).state).toBe('active')
    expect((await other.session()).state).toBe('anonymous')
  })

  it('resets a password through an emailed link', async () => {
    const s = await setup({ smtp: true })
    const client = s.client()
    expect(
      (await client.send('POST', '/internal/auth/password-reset', { email: adminEmail }))
        .statusCode,
    ).toBe(202)
    // Unknown addresses get the same answer.
    expect(
      (await client.send('POST', '/internal/auth/password-reset', { email: 'x@example.com' }))
        .statusCode,
    ).toBe(202)
    await s.server.services.auth.idle()
    expect(s.mails).toHaveLength(1)
    const token = /password-reset#([\w-]+)/.exec(s.mails[0]?.text ?? '')?.[1] ?? ''
    const done = await client.send('POST', '/internal/auth/password-reset/complete', {
      token,
      password: 'a brand new passphrase',
    })
    expect(done.statusCode).toBe(204)
    expect((await s.admin.session()).state).toBe('anonymous')
    const reuse = await client.send('POST', '/internal/auth/password-reset/complete', {
      token,
      password: 'yet another passphrase',
    })
    expect(problem(reuse).code).toBe('link_invalid')
    expect((await client.login(adminEmail, 'a brand new passphrase')).statusCode).toBe(200)
  })
})

describe('link tokens and reset requests', () => {
  it('keeps link tokens out of request logs', () => {
    const token = 'a'.repeat(43)
    expect(logPath(`/invitation/${token}`)).toBe('/invitation/[redacted]')
    expect(logPath(`/password-reset/${token}?x=1`)).toBe('/password-reset/[redacted]')
    expect(logPath(`/internal/invitations/${token}`)).toBe('/internal/invitations/[redacted]')
    expect(logPath('/internal/invitations/lookup')).toBe('/internal/invitations/lookup')
    expect(logPath('/internal/auth/password-reset/complete')).toBe(
      '/internal/auth/password-reset/complete',
    )
  })

  it('limits reset emails per address', async () => {
    const s = await setup({ smtp: true })
    const client = s.client()
    for (let i = 0; i < 4; i += 1) {
      const response = await client.send('POST', '/internal/auth/password-reset', {
        email: adminEmail,
      })
      expect(response.statusCode).toBe(202)
    }
    await s.server.services.auth.idle()
    expect(s.mails).toHaveLength(3)
  })
})

describe('two-factor authentication', () => {
  async function enroll(client: TestClient): Promise<{ secret: string; codes: string[] }> {
    const setupResponse = await client.send('POST', '/internal/profile/mfa/setup')
    const { secret, uri, qrSvg } = setupResponse.json<MfaSetup>()
    expect(uri).toContain('otpauth://totp/Stashley')
    expect(qrSvg).toContain('<svg')
    const confirm = await client.send('POST', '/internal/profile/mfa/confirm', {
      code: await generate({ secret }),
    })
    expect(confirm.statusCode).toBe(200)
    return { secret, codes: confirm.json<RecoveryCodes>().recoveryCodes }
  }

  it('requires the second factor and rejects replayed codes', async () => {
    const s = await setup()
    const { secret, codes } = await enroll(s.admin)
    expect(codes).toHaveLength(10)

    const client = s.client()
    expect((await client.login(adminEmail, adminPassword)).json()).toEqual({
      state: 'mfa_required',
    })
    const blocked = await client.request('GET', '/internal/admin/users')
    expect(problem(blocked).code).toBe('mfa_required')

    const replay = await client.send('POST', '/internal/auth/mfa', {
      code: await generate({ secret }),
    })
    expect(problem(replay).code).toBe('invalid_code')
    const next = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 })
    expect((await client.send('POST', '/internal/auth/mfa', { code: next })).json()).toEqual({
      state: 'active',
    })
  })

  it('limits wrong codes per account, across sessions and 2FA settings', async () => {
    const s = await setup()
    await enroll(s.admin)
    const first = s.client()
    await first.login(adminEmail, adminPassword)
    for (let i = 0; i < 5; i += 1) {
      const response = await first.send('POST', '/internal/auth/mfa', { code: '000000' })
      expect(problem(response).code).toBe('invalid_code')
    }
    // A new sign-in does not reset the count.
    const second = s.client()
    await second.login(adminEmail, adminPassword)
    expect(problem(await second.send('POST', '/internal/auth/mfa', { code: '000000' })).code).toBe(
      'rate_limited',
    )
    const regenerate = await s.admin.send('POST', '/internal/profile/mfa/recovery-codes', {
      code: '000000',
    })
    expect(problem(regenerate).code).toBe('rate_limited')
  })

  it('accepts a code only once, even in parallel requests', async () => {
    const s = await setup()
    const { secret } = await enroll(s.admin)
    const a = s.client()
    const b = s.client()
    await a.login(adminEmail, adminPassword)
    await b.login(adminEmail, adminPassword)
    await a.session()
    await b.session()
    const code = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 })
    const results = await Promise.all([
      a.request('POST', '/internal/auth/mfa', { code }),
      b.request('POST', '/internal/auth/mfa', { code }),
    ])
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 422])
  })

  it('lets the CLI reset 2FA when the device is lost', async () => {
    const s = await setup()
    await enroll(s.admin)
    await s.server.services.usersService.resetMfaByEmail(
      { kind: 'cli', id: null, label: null, ip: null },
      adminEmail,
    )
    expect((await s.admin.session()).state).toBe('anonymous')
    expect((await s.client().login(adminEmail, adminPassword)).json()).toEqual({ state: 'active' })
  })

  it('accepts each recovery code once', async () => {
    const s = await setup()
    const { codes } = await enroll(s.admin)
    const first = s.client()
    await first.login(adminEmail, adminPassword)
    const code = codes[0] ?? ''
    expect(
      (await first.send('POST', '/internal/auth/mfa', { code: code.toUpperCase() })).statusCode,
    ).toBe(200)
    const second = s.client()
    await second.login(adminEmail, adminPassword)
    expect(problem(await second.send('POST', '/internal/auth/mfa', { code })).code).toBe(
      'invalid_code',
    )
  })

  it('makes users without 2FA enroll when it is enforced', async () => {
    const s = await setup()
    const { client } = await createUser(s, 'kim@example.com', 'kims long passphrase')
    expect(
      (await s.admin.send('PATCH', '/internal/admin/settings', { twoFactorEnforced: true }))
        .statusCode,
    ).toBe(200)
    expect((await client.session()).state).toBe('mfa_enrollment_required')
    expect(problem(await client.request('GET', '/internal/admin/users')).code).toBe('mfa_required')
    const disable = await s.admin.send('POST', '/internal/profile/mfa/disable', { code: '000000' })
    expect(disable.statusCode).toBe(403)
    await enroll(client)
    expect((await client.session()).state).toBe('active')
  })
})

describe('account administration', () => {
  it('invites a user who sets a password', async () => {
    const s = await setup()
    const { link } = await invite(s, 'lee@example.com', 'manager')
    // The token travels in the fragment, so it never reaches request logs.
    expect(link).toMatch(/^http:\/\/localhost:8080\/invitation#[\w-]{43}$/)
    const token = link?.split('#').at(-1) ?? ''
    const client = s.client()
    const info = await client.send('POST', '/internal/invitations/lookup', { token })
    expect(info.json<InvitationInfo>()).toEqual({ email: 'lee@example.com', displayName: 'lee' })
    await client.send('POST', '/internal/invitations/accept', {
      token,
      password: 'lees long passphrase',
    })
    const session = await client.session()
    expect(session.state).toBe('active')
    expect(session.user?.systemRole).toBe('manager')
    expect(problem(await client.send('POST', '/internal/invitations/lookup', { token })).code).toBe(
      'link_invalid',
    )
  })

  it('keeps audit events immutable', async () => {
    const s = await setup()
    await expect(
      s.server.store.db.updateTable('audit_events').set({ action: 'changed' }).execute(),
    ).rejects.toThrow(/immutable/)
  })

  it('rejects duplicate email addresses', async () => {
    const s = await setup()
    const response = await s.admin.send('POST', '/internal/admin/users', {
      email: 'ADMIN@example.com',
      displayName: 'Again',
      systemRole: 'user',
    })
    expect(problem(response).errors).toEqual([{ field: 'email', code: 'taken' }])
  })

  it('keeps admin routes for admins', async () => {
    const s = await setup()
    const { client } = await createUser(s, 'max@example.com', 'maxs long passphrase', 'manager')
    expect((await client.request('GET', '/internal/admin/users')).statusCode).toBe(403)
    expect((await s.client().request('GET', '/internal/admin/users')).statusCode).toBe(401)
  })

  it('protects the last active admin', async () => {
    const s = await setup()
    const self = (await s.admin.session()).user?.id ?? ''
    const own = await s.admin.send('PATCH', `/internal/admin/users/${self}`, { systemRole: 'user' })
    expect(problem(own).code).toBe('forbidden')

    const { user: ana, client } = await createUser(
      s,
      'ana@example.com',
      'anas long passphrase',
      'admin',
    )
    const disabled = await client.send('PATCH', `/internal/admin/users/${self}`, {
      status: 'disabled',
    })
    expect(disabled.statusCode).toBe(200)
    expect((await s.admin.session()).state).toBe('anonymous')

    // Ana is now the only active admin.
    await expect(
      s.server.services.usersService.update(
        { kind: 'cli', id: null, label: null, ip: null },
        ana.id,
        {
          systemRole: 'user',
        },
      ),
    ).rejects.toMatchObject({ code: 'last_admin' })
  })

  it('issues reset links without SMTP and records every change', async () => {
    const s = await setup()
    const { user } = await createUser(s, 'ida@example.com', 'idas long passphrase')
    const result = await s.admin.send('POST', `/internal/admin/users/${user.id}/password-reset`)
    expect(result.json<LinkResult>()).toMatchObject({ emailed: false })
    expect(result.json<LinkResult>().link).toContain('/password-reset#')
    const updated = await s.admin.send('PATCH', `/internal/admin/users/${user.id}`, {
      systemRole: 'manager',
    })
    expect(updated.json<AdminUser>().systemRole).toBe('manager')
    const audit = await s.admin.request('GET', '/internal/admin/audit?action=user.')
    const actions = audit.json<Page<AuditEvent>>().data.map((event) => event.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.created',
        'user.invited',
        'user.invitation_accepted',
        'user.updated',
        'user.password_reset_issued',
      ]),
    )
    const change = audit
      .json<Page<AuditEvent>>()
      .data.find((event) => event.action === 'user.updated')
    expect(change?.changes).toEqual({ systemRole: ['user', 'manager'] })
    const csv = await s.admin.request('GET', '/internal/admin/audit/export')
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body.split('\r\n')[0]).toBe(
      'time,actor_kind,actor,action,subject,ip,changes,details',
    )
  })
})

describe('OIDC sign-in', () => {
  async function provider(s: Setup, autoApproveDomains: string[] = []): Promise<IdentityProvider> {
    const response = await s.admin.send('POST', '/internal/admin/identity-providers', {
      slug: 'corp',
      displayName: 'Corp SSO',
      issuerUrl: 'https://idp.example.com',
      clientId: 'stashley',
      clientSecret: 'secret',
      scopes: 'openid email profile',
      autoApproveDomains,
      enabled: true,
    })
    expect(response.statusCode).toBe(201)
    return response.json<IdentityProvider>()
  }

  async function signIn(s: Setup, client: TestClient) {
    const start = await client.request('GET', '/auth/oidc/corp/start')
    expect(start.statusCode).toBe(302)
    const target = new URL(String(start.headers.location))
    const state = target.searchParams.get('state') ?? ''
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    return client.request('GET', `/auth/oidc/corp/callback?code=abc&state=${state}`)
  }

  it('registers a new account as pending until an admin approves it', async () => {
    const s = await setup()
    const created = await provider(s)
    expect(created.callbackUrl).toBe('http://localhost:8080/auth/oidc/corp/callback')
    expect(created.hasClientSecret).toBe(true)
    s.oidc.claims = { sub: 'u-1', email: 'Neu@Example.com', email_verified: true, name: 'Neu' }
    const client = s.client()
    const callback = await signIn(s, client)
    expect(callback.headers.location).toBe('/pending')
    expect((await client.session()).state).toBe('pending')
    expect(problem(await client.request('GET', '/internal/admin/users')).code).toBe(
      'account_pending',
    )

    const pending = await s.admin.request('GET', '/internal/admin/users?status=pending')
    const [user] = pending.json<{ data: AdminUser[] }>().data
    expect(user?.email).toBe('neu@example.com')
    await s.admin.send('PATCH', `/internal/admin/users/${user?.id ?? ''}`, { status: 'active' })
    // Approval takes effect on the existing session.
    expect((await client.session()).state).toBe('active')
    expect((await signIn(s, client)).headers.location).toBe('/')
  })

  it('approves configured domains automatically', async () => {
    const s = await setup()
    await provider(s, ['example.org'])
    s.oidc.claims = { sub: 'u-2', email: 'kai@example.org', email_verified: true }
    const client = s.client()
    expect((await signIn(s, client)).headers.location).toBe('/')
  })

  it('links existing accounts only through verified email addresses', async () => {
    const s = await setup()
    await provider(s)
    s.oidc.claims = { sub: 'u-3', email: adminEmail, email_verified: false }
    const client = s.client()
    expect((await signIn(s, client)).headers.location).toBe('/sign-in?error=email_unverified')
    const failed = await s.admin.request('GET', '/internal/admin/audit?action=auth.sign_in.failed')
    expect(failed.json<Page<AuditEvent>>().data[0]).toMatchObject({
      actorLabel: adminEmail,
      details: { method: 'oidc', provider: 'corp', reason: 'email_unverified' },
    })
    s.oidc.claims = { sub: 'u-3', email: adminEmail, email_verified: true }
    expect((await signIn(s, client)).headers.location).toBe('/')
    expect((await client.session()).user?.email).toBe(adminEmail)
  })

  it('rejects callbacks without a matching state cookie', async () => {
    const s = await setup()
    await provider(s)
    const response = await s.client().request('GET', '/auth/oidc/corp/callback?code=abc&state=x')
    expect(response.headers.location).toBe('/sign-in?error=state_invalid')
  })

  it('allows turning off password sign-in only with an OIDC admin', async () => {
    const s = await setup()
    await provider(s)
    const refused = await s.admin.send('PATCH', '/internal/admin/settings', {
      localLoginEnabled: false,
    })
    expect(problem(refused).errors).toEqual([
      { field: 'localLoginEnabled', code: 'requirements_not_met' },
    ])
    s.oidc.claims = { sub: 'admin-sub', email: adminEmail, email_verified: true }
    await signIn(s, s.client())
    const ok = await s.admin.send('PATCH', '/internal/admin/settings', { localLoginEnabled: false })
    expect(ok.statusCode).toBe(200)
    expect(problem(await s.client().login(adminEmail, adminPassword)).code).toBe(
      'local_login_disabled',
    )
    const enabled = await s.server.services.instanceSettings.enableLocalLogin({
      kind: 'cli',
      id: null,
      label: null,
      ip: null,
    })
    expect(enabled).toBe(true)
  })

  it('keeps an admin able to sign in while password sign-in is off', async () => {
    const s = await setup()
    const corp = await provider(s)
    const { client: ana } = await createUser(s, 'ana@example.com', 'anas long passphrase', 'admin')
    s.oidc.claims = { sub: 'admin-sub', email: adminEmail, email_verified: true }
    await signIn(s, s.client())
    const off = await s.admin.send('PATCH', '/internal/admin/settings', {
      localLoginEnabled: false,
    })
    expect(off.statusCode).toBe(200)
    const self = (await s.admin.session()).user?.id ?? ''
    const own = await s.admin.request('GET', `/internal/admin/users/${self}`)
    const identity = own.json<AdminUser>().identities[0]?.id ?? ''
    const refused = [
      await s.admin.send('DELETE', `/internal/admin/identity-providers/${corp.id}`),
      await s.admin.send('PUT', `/internal/admin/identity-providers/${corp.id}`, {
        slug: 'corp',
        displayName: 'Corp SSO',
        issuerUrl: 'https://idp.example.com',
        clientId: 'stashley',
        scopes: 'openid email profile',
        autoApproveDomains: [],
        enabled: false,
      }),
      await s.admin.send('DELETE', `/internal/admin/users/${self}/identities/${identity}`),
      // Ana has no identity, so disabling the only admin with one is refused too.
      await ana.send('PATCH', `/internal/admin/users/${self}`, { status: 'disabled' }),
    ]
    for (const response of refused) expect(problem(response).code).toBe('last_sign_in_path')
  })
})
