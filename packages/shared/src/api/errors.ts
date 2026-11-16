// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stable error codes shared by all HTTP surfaces. The web client maps each code to a
 * localized message; `title` in problem documents is a fixed English summary.
 */
export const errorCodes = {
  bad_request: { status: 400, title: 'Bad request' },
  validation_failed: { status: 422, title: 'Validation failed' },
  unauthenticated: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not found' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  payload_too_large: { status: 413, title: 'Payload too large' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  rate_limited: { status: 429, title: 'Too many requests' },
  invalid_credentials: { status: 401, title: 'Invalid credentials' },
  invalid_code: { status: 422, title: 'Invalid code' },
  mfa_required: { status: 403, title: 'Two-factor authentication required' },
  account_pending: { status: 403, title: 'Account pending approval' },
  account_disabled: { status: 403, title: 'Account disabled' },
  csrf_failed: { status: 403, title: 'CSRF check failed' },
  local_login_disabled: { status: 403, title: 'Password sign-in disabled' },
  link_invalid: { status: 410, title: 'Link invalid or expired' },
  last_admin: { status: 409, title: 'Last active admin' },
  last_sign_in_path: { status: 409, title: 'No admin could sign in afterwards' },
  provider_unreachable: { status: 422, title: 'Identity provider unreachable' },
  connection_failed: { status: 422, title: 'Database connection failed' },
  in_use: { status: 409, title: 'Still in use' },
  query_failed: { status: 422, title: 'Query failed' },
  query_timeout: { status: 504, title: 'Query timed out' },
  target_unavailable: { status: 503, title: 'Database unavailable' },
  target_permission_denied: { status: 503, title: 'Database permission missing' },
  cursor_invalid: { status: 400, title: 'Invalid cursor' },
  cursor_expired: { status: 409, title: 'Cursor expired' },
  // Writes (§11 step 7). Field errors name the columns where they are known.
  version_conflict: { status: 409, title: 'Changed in the meantime' },
  base_filter_violation: { status: 403, title: 'Outside the base filter' },
  row_locked: { status: 409, title: 'Row locked' },
  unique_violation: { status: 409, title: 'Duplicate value' },
  foreign_key_violation: { status: 422, title: 'Referenced record missing' },
  still_referenced: { status: 409, title: 'Still referenced' },
  value_not_allowed: { status: 422, title: 'Value not allowed' },
  not_null_violation: { status: 422, title: 'Value required' },
  value_too_long: { status: 422, title: 'Value too long' },
  value_out_of_range: { status: 422, title: 'Value out of range' },
  invalid_value: { status: 422, title: 'Invalid value' },
  check_violation: { status: 422, title: 'Check failed' },
  write_failed: { status: 422, title: 'Write failed' },
  internal_error: { status: 500, title: 'Internal error' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, { status: number; title: string }>

export type ErrorCode = keyof typeof errorCodes

export interface FieldError {
  field: string
  code: string
  params?: Record<string, string | number>
}

/** RFC 9457 problem document with Stashley extension members. */
export interface ProblemDocument {
  type: string
  title: string
  status: number
  code: ErrorCode
  detail?: string
  errors?: FieldError[]
  errorId?: string
  /** `version_conflict`: the record as it is now, or null when it is gone. */
  current?: unknown
}

export const problemTypePrefix = 'urn:stashley:problem:'

export function problemType(code: ErrorCode): string {
  return `${problemTypePrefix}${code}`
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(errorCodes, value)
}
