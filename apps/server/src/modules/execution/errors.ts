// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ConnectionFailure } from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'
import { TargetError } from '../../target/errors.ts'
import { timeoutErrnos } from '../../target/pools.ts'

/** Missing privileges of the read user: table, column, schema, routine, other. */
const permissionErrnos = new Set([1044, 1142, 1143, 1227, 1370])

/** The read user or its schema was refused: the database answered, it said no. */
const refusedFailures = new Set<ConnectionFailure>(['access_denied', 'unknown_database'])

/**
 * The database could not be reached at all, so no server decided anything. Only this may
 * fall back to a stale cache entry (§12); a refusal by the server never does.
 */
export class TargetUnreachable extends AppError {
  constructor() {
    super('target_unavailable')
  }
}

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
  if (
    (error.errno !== undefined && permissionErrnos.has(error.errno)) ||
    refusedFailures.has(error.failure)
  ) {
    return new AppError('target_permission_denied')
  }
  // Without a server error number the driver lost or never had a connection.
  if (error.errno === undefined || error.failure !== 'failed') return new TargetUnreachable()
  return new AppError('query_failed', {
    errors: [{ field: 'sql', code: 'query_failed', params: { errno: error.errno } }],
  })
}

/** Errors after which a stale cache entry may be served instead (§12). */
export function isUnreachable(error: unknown): boolean {
  return error instanceof TargetUnreachable
}

/** The database refused the read; a cached result of it must not be served any more. */
export function isRefused(error: unknown): boolean {
  return error instanceof AppError && error.code === 'target_permission_denied'
}
