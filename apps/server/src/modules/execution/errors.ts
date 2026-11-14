// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '../../platform/http/problem.ts'
import { TargetError } from '../../target/errors.ts'
import { timeoutErrnos } from '../../target/pools.ts'

/** Missing privileges of the read user: table, column, schema, routine, other. */
const permissionErrnos = new Set([1044, 1142, 1143, 1227, 1370])

/**
 * Translates a failed read into a stable code (§10.5). Messages from the database are
 * never passed on or logged; the error number is, since it carries no data.
 */
export function translateReadError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (!(error instanceof TargetError)) throw error
  if (
    (error.errno !== undefined && timeoutErrnos.has(error.errno)) ||
    error.driverCode === 'PROTOCOL_SEQUENCE_TIMEOUT'
  ) {
    return new AppError('query_timeout')
  }
  if (error.errno !== undefined && permissionErrnos.has(error.errno)) {
    return new AppError('target_permission_denied')
  }
  if (error.errno === undefined || error.failure !== 'failed') {
    return new AppError('target_unavailable')
  }
  return new AppError('query_failed', {
    errors: [{ field: 'sql', code: 'query_failed', params: { errno: error.errno } }],
  })
}

/** Errors after which a stale cache entry may be served instead (§12). */
export function isUnavailable(error: AppError): boolean {
  return error.code === 'target_unavailable' || error.code === 'target_permission_denied'
}
