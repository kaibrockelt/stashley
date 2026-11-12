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
}

export const problemTypePrefix = 'urn:stashley:problem:'

export function problemType(code: ErrorCode): string {
  return `${problemTypePrefix}${code}`
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(errorCodes, value)
}
