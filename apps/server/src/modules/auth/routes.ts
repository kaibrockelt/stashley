// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  invitationAccept,
  invitationLookup,
  loginRequest,
  mfaConfirm,
  mfaRequest,
  passwordChange,
  passwordResetComplete,
  passwordResetRequest,
  profileUpdate,
  type SessionResponse,
} from '@stashley/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { parse } from '../../platform/http/validation.ts'
import { csrfUserInfo } from '../../platform/http/security.ts'
import type { Mailer } from '../mail/mailer.ts'
import { toSessionUser } from '../users/repository.ts'
import {
  clearSessionCookie,
  requireActive,
  requireSession,
  setSessionCookie,
  type CookieSettings,
} from './context.ts'
import { OidcError, oidcStateCookie, type OidcService } from './oidc.ts'
import type { AuthService, IssuedSession, RequestMeta } from './service.ts'

export interface AuthRouteDeps {
  auth: AuthService
  oidc: OidcService
  settings: SettingsRepository
  mailer: Mailer
  cookie: CookieSettings
  timeZone: string
  baseUrl: string
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null }
}

const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } }
const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,40}$/) })

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const issue = (reply: FastifyReply, session: IssuedSession) => {
    setSessionCookie(reply, deps.cookie, session.cookie, session.maxAgeSeconds)
    return { state: session.state }
  }

  app.get('/internal/session', async (request, reply): Promise<SessionResponse> => {
    const [localLogin, twoFactor, providers] = await Promise.all([
      deps.settings.get('auth.localLogin'),
      deps.settings.get('auth.twoFactor'),
      deps.oidc.enabledProviders(),
    ])
    const auth = request.auth
    return {
      state: auth?.state ?? 'anonymous',
      csrfToken: reply.generateCsrf({ userInfo: csrfUserInfo(request) }),
      user: auth === null ? null : toSessionUser(auth.user),
      instance: {
        timeZone: deps.timeZone,
        localLogin: localLogin.enabled,
        mfaEnforced: twoFactor.enforced,
        providers,
        smtp: deps.mailer.enabled,
      },
    }
  })

  app.post('/internal/auth/login', { config: strictLimit }, async (request, reply) => {
    const body = parse(loginRequest, request.body)
    return issue(reply, await deps.auth.login(body.email, body.password, meta(request)))
  })

  app.post('/internal/auth/mfa', { config: strictLimit }, async (request, reply) => {
    const auth = requireSession(request, ['mfa_required'])
    const body = parse(mfaRequest, request.body)
    return issue(reply, await deps.auth.completeMfa(auth, body.code, meta(request)))
  })

  app.post('/internal/auth/logout', async (request, reply) => {
    if (request.auth !== null) await deps.auth.logout(request.auth)
    clearSessionCookie(reply, deps.cookie)
    return reply.code(204).send()
  })

  app.post('/internal/auth/password-reset', { config: strictLimit }, async (request, reply) => {
    const body = parse(passwordResetRequest, request.body)
    deps.auth.requestPasswordReset(body.email, meta(request))
    return reply.code(202).send()
  })

  app.post(
    '/internal/auth/password-reset/complete',
    { config: strictLimit },
    async (request, reply) => {
      const body = parse(passwordResetComplete, request.body)
      await deps.auth.completePasswordReset(body.token, body.password, meta(request))
      return reply.code(204).send()
    },
  )

  // Tokens come in the body, so they never appear in request logs.
  app.post('/internal/invitations/lookup', { config: strictLimit }, async (request) => {
    const { token } = parse(invitationLookup, request.body)
    return deps.auth.invitationInfo(token)
  })

  app.post('/internal/invitations/accept', { config: strictLimit }, async (request, reply) => {
    const body = parse(invitationAccept, request.body)
    return issue(reply, await deps.auth.acceptInvitation(body, meta(request)))
  })

  app.get('/auth/oidc/:slug/start', { config: strictLimit }, async (request, reply) => {
    const { slug } = parse(slugParams, request.params)
    try {
      const flow = await deps.oidc.start(slug)
      void reply.setCookie(oidcStateCookie, flow.cookie, {
        path: '/auth/oidc/',
        httpOnly: true,
        secure: deps.cookie.secure,
        sameSite: 'lax',
        maxAge: flow.maxAgeSeconds,
      })
      return reply.redirect(flow.url)
    } catch (error) {
      if (error instanceof OidcError) return reply.redirect(`/sign-in?error=${error.code}`)
      throw error
    }
  })

  app.get('/auth/oidc/:slug/callback', { config: strictLimit }, async (request, reply) => {
    const { slug } = parse(slugParams, request.params)
    const stateCookie = request.cookies[oidcStateCookie]
    void reply.clearCookie(oidcStateCookie, { path: '/auth/oidc/' })
    try {
      const callbackUrl = new URL(request.url, `${deps.baseUrl}/`)
      const session = await deps.oidc.callback(slug, callbackUrl, stateCookie, meta(request))
      setSessionCookie(reply, deps.cookie, session.cookie, session.maxAgeSeconds)
      return reply.redirect(session.state === 'pending' ? '/pending' : '/')
    } catch (error) {
      if (error instanceof OidcError) {
        request.log.warn({ code: error.code, provider: slug }, 'OIDC sign-in failed')
        return reply.redirect(`/sign-in?error=${error.code}`)
      }
      throw error
    }
  })

  // Profile

  app.patch('/internal/profile', async (request, reply) => {
    const auth = requireActive(request)
    await deps.auth.updateProfile(auth, parse(profileUpdate.strict(), request.body), meta(request))
    return reply.code(204).send()
  })

  app.post('/internal/profile/password', { config: strictLimit }, async (request, reply) => {
    const auth = requireActive(request)
    const body = parse(passwordChange, request.body)
    await deps.auth.changePassword(auth, body.currentPassword, body.newPassword, meta(request))
    return reply.code(204).send()
  })

  app.post('/internal/profile/mfa/setup', async (request) => {
    const auth = requireSession(request, ['active', 'mfa_enrollment_required'])
    return deps.auth.startMfaSetup(auth)
  })

  app.post('/internal/profile/mfa/confirm', { config: strictLimit }, async (request, reply) => {
    const auth = requireSession(request, ['active', 'mfa_enrollment_required'])
    const body = parse(mfaConfirm, request.body)
    const result = await deps.auth.confirmMfa(auth, body.code, meta(request))
    if (result.session !== undefined) {
      setSessionCookie(reply, deps.cookie, result.session.cookie, result.session.maxAgeSeconds)
    }
    return { recoveryCodes: result.recoveryCodes }
  })

  app.post('/internal/profile/mfa/disable', { config: strictLimit }, async (request, reply) => {
    const auth = requireActive(request)
    const body = parse(mfaRequest, request.body)
    await deps.auth.disableMfa(auth, body.code, meta(request))
    return reply.code(204).send()
  })

  app.post('/internal/profile/mfa/recovery-codes', { config: strictLimit }, async (request) => {
    const auth = requireActive(request)
    const body = parse(mfaRequest, request.body)
    return deps.auth.regenerateRecoveryCodes(auth, body.code, meta(request))
  })
}
