// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'

export const systemRoles = ['admin', 'manager', 'user'] as const
export type SystemRole = (typeof systemRoles)[number]

export const userStatuses = ['pending', 'active', 'disabled'] as const
export type UserStatus = (typeof userStatuses)[number]

export const themes = ['light', 'dark', 'system'] as const
export type Theme = (typeof themes)[number]

export const uiLocales = ['en', 'de'] as const
export type UiLocale = (typeof uiLocales)[number]

/** Formatting locales offered in the profile; null means the UI language decides. */
export const formatLocales = ['en-US', 'en-GB', 'de-DE', 'de-AT', 'de-CH'] as const

export const passwordMinLength = 12
export const passwordMaxLength = 256

export const sessionStates = [
  'anonymous',
  'mfa_required',
  'mfa_enrollment_required',
  'pending',
  'active',
] as const
export type SessionState = (typeof sessionStates)[number]

const email = z.email().max(254)
const password = z.string().min(1).max(passwordMaxLength)
const newPassword = z.string().min(passwordMinLength).max(passwordMaxLength)
const displayName = z.string().trim().min(1).max(120)
const code = z.string().trim().min(6).max(20)

export interface SessionUser {
  id: string
  email: string
  displayName: string
  systemRole: SystemRole
  status: UserStatus
  locale: UiLocale | null
  formatLocale: string | null
  theme: Theme
  mfaEnabled: boolean
  hasPassword: boolean
  /** Roles in their configured order. */
  roles: { id: string; name: string }[]
}

export interface SessionResponse {
  state: SessionState
  csrfToken: string
  user: SessionUser | null
  instance: {
    timeZone: string
    localLogin: boolean
    mfaEnforced: boolean
    providers: { slug: string; displayName: string }[]
    smtp: boolean
    /** Whether managers may create, rename and delete roles (D14). */
    managersCreateRoles: boolean
  }
}

export const loginRequest = z.object({ email, password })
export const mfaRequest = z.object({ code })
export const passwordResetRequest = z.object({ email })
/** One-time link tokens travel in the URL fragment and the request body, never in a path. */
const linkToken = z.string().min(16).max(100)
export const passwordResetComplete = z.object({ token: linkToken, password: newPassword })
export const invitationLookup = z.object({ token: linkToken })
export const invitationAccept = z.object({
  token: linkToken,
  password: newPassword,
  displayName: displayName.optional(),
})
export interface InvitationInfo {
  email: string
  displayName: string
}

export const profileUpdate = z.object({
  displayName: displayName.optional(),
  locale: z.enum(uiLocales).nullable().optional(),
  formatLocale: z.enum(formatLocales).nullable().optional(),
  theme: z.enum(themes).optional(),
})
export const passwordChange = z.object({ currentPassword: password, newPassword })

export interface MfaSetup {
  secret: string
  uri: string
  qrSvg: string
}
export const mfaConfirm = z.object({ code })
export interface RecoveryCodes {
  recoveryCodes: string[]
}

export interface AdminUser {
  id: string
  email: string
  displayName: string
  systemRole: SystemRole
  status: UserStatus
  mfaEnabled: boolean
  hasPassword: boolean
  identities: { id: string; provider: string; email: string | null }[]
  roleIds: string[]
  createdAt: string
  lastLoginAt: string | null
}

export const userInvite = z.object({ email, displayName, systemRole: z.enum(systemRoles) })
export const userUpdate = z.object({
  displayName: displayName.optional(),
  systemRole: z.enum(systemRoles).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})
/** A link is returned when no email could be sent. */
export interface LinkResult {
  link: string | null
  emailed: boolean
}

export interface IdentityProvider {
  id: string
  slug: string
  displayName: string
  issuerUrl: string
  clientId: string
  hasClientSecret: boolean
  scopes: string
  autoApproveDomains: string[]
  enabled: boolean
  callbackUrl: string
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)

export const identityProviderInput = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  displayName: z.string().trim().min(1).max(60),
  issuerUrl: z.url({ protocol: /^https?$/ }),
  clientId: z.string().trim().min(1).max(500),
  /** Omitted: keep the stored secret. Null: remove it. */
  clientSecret: z.string().min(1).max(2000).nullable().optional(),
  scopes: z.string().trim().min(1).max(500),
  autoApproveDomains: z.array(domain).max(50),
  enabled: z.boolean(),
})

export interface InstanceSettings {
  localLoginEnabled: boolean
  twoFactorEnforced: boolean
  sessionIdleMinutes: number
  sessionMaxAgeDays: number
  auditRetentionDays: number
  /** Whether managers may create, rename and delete roles. */
  managersCreateRoles: boolean
}

export const instanceSettingsUpdate = z.object({
  localLoginEnabled: z.boolean().optional(),
  twoFactorEnforced: z.boolean().optional(),
  sessionIdleMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 30)
    .optional(),
  sessionMaxAgeDays: z.number().int().min(1).max(90).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  managersCreateRoles: z.boolean().optional(),
})

export interface AuditEvent {
  id: string
  occurredAt: string
  actorKind: string
  actorId: string | null
  actorLabel: string | null
  action: string
  ip: string | null
  subjectKind: string | null
  subjectId: string | null
  subjectLabel: string | null
  changes: Record<string, [unknown, unknown]> | null
  details: Record<string, unknown> | null
}

export const auditQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  action: z.string().max(100).optional(),
  actor: z.string().max(254).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export interface Page<T> {
  data: T[]
  nextCursor: string | null
}
