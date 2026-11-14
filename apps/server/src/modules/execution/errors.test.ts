// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { AppError } from '../../platform/http/problem.ts'
import { TargetError } from '../../target/errors.ts'
import { isRefused, isUnreachable, translateReadError } from './errors.ts'

describe('read errors', () => {
  it('lets only an unreachable database fall back to stale results', () => {
    for (const error of [
      new TargetError('unreachable', 'ECONNREFUSED'),
      new TargetError('timeout', 'ETIMEDOUT'),
      new TargetError('tls_failed', 'HANDSHAKE_SSL_ERROR'),
      new TargetError('host_not_allowed'),
      new TargetError('failed', 'PROTOCOL_CONNECTION_LOST'),
    ]) {
      const translated = translateReadError(error)
      expect(translated.code).toBe('target_unavailable')
      expect(isUnreachable(translated)).toBe(true)
      expect(isRefused(translated)).toBe(false)
    }
  })

  it('treats refusals by the server as refused, never as an outage', () => {
    for (const error of [
      new TargetError('access_denied', 'ER_ACCESS_DENIED_ERROR', 1045),
      new TargetError('access_denied', 'ER_DBACCESS_DENIED_ERROR', 1044),
      new TargetError('unknown_database', 'ER_BAD_DB_ERROR', 1049),
      new TargetError('failed', 'ER_TABLEACCESS_DENIED_ERROR', 1142),
      new TargetError('failed', 'ER_COLUMNACCESS_DENIED_ERROR', 1143),
    ]) {
      const translated = translateReadError(error)
      expect(translated.code).toBe('target_permission_denied')
      expect(isUnreachable(translated)).toBe(false)
      expect(isRefused(translated)).toBe(true)
    }
  })

  it('keeps timeouts, query errors and app errors apart', () => {
    expect(translateReadError(new TargetError('failed', 'ER_QUERY_INTERRUPTED', 1317)).code).toBe(
      'query_timeout',
    )
    expect(translateReadError(new TargetError('timeout', 'PROTOCOL_SEQUENCE_TIMEOUT')).code).toBe(
      'query_timeout',
    )
    expect(
      translateReadError(new TargetError('failed', 'ER_SUBQUERY_NO_1_ROW', 1242)),
    ).toMatchObject({
      code: 'query_failed',
      errors: [{ field: 'sql', code: 'query_failed', params: { errno: 1242 } }],
    })
    const own = new AppError('target_unavailable')
    expect(translateReadError(own)).toBe(own)
    expect(isUnreachable(own)).toBe(false)
    expect(() => translateReadError(new Error('x'))).toThrow('x')
  })
})
