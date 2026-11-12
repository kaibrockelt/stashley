// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import fastifyCookie from '@fastify/cookie'
import csrfProtection from '@fastify/csrf-protection'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { clientState, type CookieSettings } from '../../modules/auth/context.ts'
import type { SessionService } from '../../modules/auth/sessions.ts'
import type { KeyRing } from '../crypto/keys.ts'
import { AppError } from './problem.ts'

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Paths whose requests carry the session cookie. */
function usesSession(url: string): boolean {
  return url.startsWith('/internal/') || url.startsWith('/auth/')
}

export function csrfUserInfo(request: FastifyRequest): string {
  return request.auth?.session.id_hash ?? 'anonymous'
}

export async function registerSecurity(
  app: FastifyInstance,
  deps: {
    keys: KeyRing
    sessions: SessionService
    settings: SettingsRepository
    cookie: CookieSettings
    origin: string
  },
): Promise<void> {
  await app.register(fastifyCookie)
  await app.register(rateLimit, { global: false })
  await app.register(csrfProtection, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: deps.cookie.secure ? '__Host-stashley_csrf' : 'stashley_csrf',
    cookieOpts: { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookie.secure },
    getUserInfo: csrfUserInfo,
    csrfOpts: { hmacKey: deps.keys.key('csrf'), userInfo: true },
  })

  app.decorateRequest('auth', null)

  app.addHook('onRequest', async (request) => {
    if (!usesSession(request.url)) return
    const idHash = deps.sessions.parseCookie(request.cookies[deps.cookie.name])
    if (idHash === undefined) return
    const resolved = await deps.sessions.resolve(idHash)
    if (resolved === undefined) return
    const { enforced } = await deps.settings.get('auth.twoFactor')
    request.auth = { ...resolved, state: clientState(resolved.session, resolved.user, enforced) }
  })

  // Every state-changing internal request needs a same-origin context and a CSRF token
  // bound to the current session.
  app.addHook('preHandler', (request, reply, done) => {
    if (!request.url.startsWith('/internal/') || safeMethods.has(request.method)) {
      done()
      return
    }
    const site = request.headers['sec-fetch-site']
    const origin = request.headers.origin
    if (
      (site !== undefined && site !== 'same-origin') ||
      (origin !== undefined && origin !== deps.origin)
    ) {
      done(new AppError('csrf_failed'))
      return
    }
    // Sends a CSRF error itself (mapped to `csrf_failed`) or calls done().
    app.csrfProtection(request, reply, done)
  })

  app.addHook('onSend', async (request, reply: FastifyReply) => {
    if (request.url.startsWith('/internal/')) void reply.header('cache-control', 'no-store')
  })
}
