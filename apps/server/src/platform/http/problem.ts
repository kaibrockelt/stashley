// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  errorCodes,
  problemType,
  type ErrorCode,
  type FieldError,
  type ProblemDocument,
} from '@stashley/shared'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly errors: FieldError[] | undefined
  readonly detail: string | undefined

  constructor(code: ErrorCode, options: { detail?: string; errors?: FieldError[] } = {}) {
    super(errorCodes[code].title)
    this.name = 'AppError'
    this.code = code
    this.errors = options.errors
    this.detail = options.detail
  }
}

export function problem(
  code: ErrorCode,
  extra: Partial<Pick<ProblemDocument, 'detail' | 'errors' | 'errorId'>> = {},
): ProblemDocument {
  const { status, title } = errorCodes[code]
  return { type: problemType(code), title, status, code, ...extra }
}

export function sendProblem(reply: FastifyReply, document: ProblemDocument): FastifyReply {
  return reply
    .code(document.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(document)
}

/** Maps Fastify's own error codes to stable Stashley codes. */
const fastifyErrorCodes: Record<string, ErrorCode> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'bad_request',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'bad_request',
  FST_ERR_VALIDATION: 'validation_failed',
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AppError) {
    return sendProblem(
      reply,
      problem(error.code, {
        ...(error.detail !== undefined && { detail: error.detail }),
        ...(error.errors !== undefined && { errors: error.errors }),
      }),
    )
  }
  const mapped = fastifyErrorCodes[error.code]
  if (mapped !== undefined) return sendProblem(reply, problem(mapped))
  if (error.statusCode === 400 || error instanceof SyntaxError) {
    return sendProblem(reply, problem('bad_request'))
  }
  if (error.statusCode === 429) return sendProblem(reply, problem('rate_limited'))
  if (error.statusCode === 403) return sendProblem(reply, problem('forbidden'))
  if (error.statusCode === 404) return sendProblem(reply, problem('not_found'))
  request.log.error({ err: error }, 'unhandled error')
  return sendProblem(reply, problem('internal_error', { errorId: request.id }))
}
