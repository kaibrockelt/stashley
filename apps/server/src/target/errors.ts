// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ConnectionFailure } from '@stashley/shared'

/** A target database problem. It carries only a code; server messages can contain data. */
export class TargetError extends Error {
  readonly failure: ConnectionFailure
  /** The driver's error code, safe to log (e.g. `ER_ACCESS_DENIED_ERROR`). */
  readonly driverCode: string | undefined

  constructor(failure: ConnectionFailure, driverCode?: string) {
    super(`Target database: ${failure}`)
    this.name = 'TargetError'
    this.failure = failure
    this.driverCode = driverCode
  }
}

const failures: Record<string, ConnectionFailure> = {
  ECONNREFUSED: 'unreachable',
  ENOTFOUND: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ECONNRESET: 'unreachable',
  EAI_AGAIN: 'unreachable',
  ETIMEDOUT: 'timeout',
  PROTOCOL_SEQUENCE_TIMEOUT: 'timeout',
  ER_ACCESS_DENIED_ERROR: 'access_denied',
  ER_ACCESS_DENIED_NO_PASSWORD_ERROR: 'access_denied',
  ER_DBACCESS_DENIED_ERROR: 'access_denied',
  ER_BAD_DB_ERROR: 'unknown_database',
  HANDSHAKE_SSL_ERROR: 'tls_failed',
  HANDSHAKE_NO_SSL_SUPPORT: 'tls_failed',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_failed',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_failed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_failed',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_failed',
  CERT_HAS_EXPIRED: 'tls_failed',
}

/** Maps a driver error to a failure code without reading its message. */
export function toTargetError(error: unknown): TargetError {
  if (error instanceof TargetError) return error
  const code = (error as { code?: unknown }).code
  const driverCode = typeof code === 'string' ? code : undefined
  const failure =
    driverCode !== undefined
      ? (failures[driverCode] ?? (driverCode.startsWith('ERR_TLS') ? 'tls_failed' : 'failed'))
      : 'failed'
  return new TargetError(failure, driverCode)
}
