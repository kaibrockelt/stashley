// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode, FieldError, ProblemDocument, SessionResponse } from '@stashley/shared'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly errors: FieldError[]
  readonly errorId: string | undefined
  /** The whole problem document, e.g. the current draft of a `409` conflict. */
  readonly body: Record<string, unknown>

  constructor(problem: ProblemDocument) {
    super(problem.title)
    this.body = problem as unknown as Record<string, unknown>
    this.name = 'ApiError'
    this.status = problem.status
    this.code = problem.code
    this.errors = problem.errors ?? []
    this.errorId = problem.errorId
  }

  fieldError(field: string): string | undefined {
    return this.errors.find((error) => error.field === field)?.code
  }
}

let csrfToken = ''

export function setCsrfToken(token: string): void {
  csrfToken = token
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    return new ApiError((await response.json()) as ProblemDocument)
  } catch {
    return new ApiError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: response.status >= 500 ? 'internal_error' : 'bad_request',
    })
  }
}

export async function fetchSession(): Promise<SessionResponse> {
  const response = await fetch('/internal/session', { credentials: 'same-origin' })
  if (!response.ok) throw await parseError(response)
  const session = (await response.json()) as SessionResponse
  setCsrfToken(session.csrfToken)
  return session
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/**
 * JSON request to the internal API. A rejected CSRF token is refreshed once, e.g. after
 * the session changed in another tab.
 */
export async function api<T>(
  method: Method,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  retry = true,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(method !== 'GET' && { 'x-csrf-token': csrfToken }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  if (response.ok) {
    if (response.status === 204 || response.status === 202) return undefined as T
    return (await response.json()) as T
  }
  const error = await parseError(response)
  if (error.code === 'csrf_failed' && retry) {
    await fetchSession()
    return api<T>(method, url, body, headers, false)
  }
  throw error
}
