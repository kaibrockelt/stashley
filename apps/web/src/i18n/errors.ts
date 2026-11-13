// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode } from '@stashley/shared'
import { ApiError } from '../api/client.ts'
import type { MessageId } from './locale.ts'
import { useT } from './use-t.ts'

const errorMessages: Partial<Record<ErrorCode, MessageId>> = {
  invalid_credentials: 'error.invalidCredentials',
  invalid_code: 'error.invalidCode',
  rate_limited: 'error.rateLimited',
  account_disabled: 'error.accountDisabled',
  local_login_disabled: 'error.localLoginDisabled',
  link_invalid: 'error.linkInvalid',
  last_admin: 'error.lastAdmin',
  last_sign_in_path: 'error.lastSignInPath',
  provider_unreachable: 'error.providerUnreachable',
  forbidden: 'error.forbidden',
  not_found: 'error.notFound',
  conflict: 'error.conflict',
}

const fieldMessages: Record<string, MessageId> = {
  required: 'field.required',
  invalid: 'field.invalid',
  too_short: 'field.tooShort',
  too_long: 'field.tooLong',
  too_small: 'field.invalid',
  too_big: 'field.invalid',
  too_common: 'field.tooCommon',
  matches_email: 'field.matchesEmail',
  incorrect: 'field.incorrect',
  taken: 'field.taken',
  mismatch: 'field.mismatch',
  requirements_not_met: 'field.requirementsNotMet',
  not_allowed: 'field.invalid',
}

/** Sign-in errors passed back from the OIDC callback as `?error=`. */
const signInErrors: Record<string, MessageId> = {
  provider_unavailable: 'signIn.error.providerUnavailable',
  provider_unreachable: 'signIn.error.providerUnavailable',
  state_invalid: 'signIn.error.failed',
  sign_in_failed: 'signIn.error.failed',
  account_disabled: 'error.accountDisabled',
  email_missing: 'signIn.error.emailMissing',
  email_unverified: 'signIn.error.emailUnverified',
}

export function useErrorText() {
  const t = useT()
  return {
    /** General message for an error; field errors are shown at their fields. */
    message(error: unknown): string | undefined {
      if (error === null || error === undefined) return undefined
      if (error instanceof ApiError) {
        if (error.code === 'validation_failed') return undefined
        const id = errorMessages[error.code]
        if (id !== undefined) return t(id)
        if (error.errorId !== undefined) return t('error.withReference', { errorId: error.errorId })
      }
      return t('error.generic')
    },
    field(error: unknown, field: string): string | undefined {
      if (!(error instanceof ApiError)) return undefined
      const code = error.fieldError(field)
      return code === undefined ? undefined : t(fieldMessages[code] ?? 'field.invalid')
    },
    signIn(code: string): string {
      return t(signInErrors[code] ?? 'signIn.error.failed')
    },
  }
}
