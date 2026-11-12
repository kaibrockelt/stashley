// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionState as ClientState, SystemRole } from '@stashley/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../platform/http/problem.ts'
import type { Actor } from '../audit/audit-log.ts'
import type { UserRow } from '../users/repository.ts'
import type { SessionRow } from './sessions.ts'

export interface AuthContext {
  session: SessionRow
  user: UserRow
  /** State as seen by the client, including enforced 2FA enrollment and pending accounts. */
  state: Exclude<ClientState, 'anonymous'>
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export function clientState(
  session: SessionRow,
  user: UserRow,
  mfaEnforced: boolean,
): AuthContext['state'] {
  if (user.status === 'pending') return 'pending'
  if (session.state !== 'active') return session.state
  const localAccount = session.auth_method !== 'oidc' && user.password_hash !== null
  if (mfaEnforced && localAccount && user.totp_enabled_at === null) return 'mfa_enrollment_required'
  return 'active'
}

/** Requires a session in one of the given states. */
export function requireSession(
  request: FastifyRequest,
  allowed: AuthContext['state'][],
): AuthContext {
  const auth = request.auth
  if (auth === null) throw new AppError('unauthenticated')
  if (!allowed.includes(auth.state)) {
    if (auth.state === 'pending') throw new AppError('account_pending')
    if (auth.state === 'active') throw new AppError('forbidden')
    throw new AppError('mfa_required')
  }
  return auth
}

/** Requires a fully signed-in, approved account. */
export function requireActive(request: FastifyRequest): AuthContext {
  return requireSession(request, ['active'])
}

export function requireRole(request: FastifyRequest, roles: SystemRole[]): AuthContext {
  const auth = requireActive(request)
  if (!roles.includes(auth.user.system_role)) throw new AppError('forbidden')
  return auth
}

export function actorOf(request: FastifyRequest): Actor {
  const user = request.auth?.user
  return {
    kind: 'user',
    id: user?.id ?? null,
    label: user?.email ?? null,
    ip: request.ip,
  }
}

export interface CookieSettings {
  name: string
  secure: boolean
}

export function setSessionCookie(
  reply: FastifyReply,
  cookie: CookieSettings,
  value: string,
  maxAgeSeconds: number,
): void {
  void reply.setCookie(cookie.name, value, {
    path: '/',
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'lax',
    maxAge: maxAgeSeconds,
  })
}

export function clearSessionCookie(reply: FastifyReply, cookie: CookieSettings): void {
  void reply.clearCookie(cookie.name, {
    path: '/',
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'lax',
  })
}
