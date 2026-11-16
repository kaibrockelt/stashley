// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode, FieldError } from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'
import { TargetError } from '../../target/errors.ts'
import { translateReadError } from './errors.ts'

/**
 * Database errors of writes (§11 step 7), by error number. Messages never pass through; where
 * the column matters (duplicate keys, missing referenced rows) the writer finds it with its
 * own queries instead of reading the message.
 */
const byErrno: Record<number, ErrorCode> = {
  1062: 'unique_violation',
  1586: 'unique_violation',
  1452: 'foreign_key_violation',
  1216: 'foreign_key_violation',
  1451: 'still_referenced',
  1217: 'still_referenced',
  1048: 'not_null_violation',
  1364: 'not_null_violation',
  1406: 'value_too_long',
  1264: 'value_out_of_range',
  1690: 'value_out_of_range',
  1292: 'invalid_value',
  1366: 'invalid_value',
  1265: 'invalid_value',
  3819: 'check_violation',
  4025: 'check_violation',
  1205: 'row_locked',
}

/** Deadlocks: InnoDB rolled the transaction back; the writer tries once more. */
export const deadlockErrno = 1213

export function writeErrno(error: unknown): number | undefined {
  return error instanceof TargetError ? error.errno : undefined
}

export function translateWriteError(error: unknown, errors?: FieldError[]): AppError {
  if (error instanceof AppError) return error
  const errno = writeErrno(error)
  const code = errno === undefined ? undefined : byErrno[errno]
  if (code !== undefined) {
    return new AppError(code, errors !== undefined && errors.length > 0 ? { errors } : {})
  }
  if (errno === deadlockErrno) return new AppError('row_locked')
  // Timeouts, refused privileges and lost connections read like those of reads (§10.5).
  const read = translateReadError(error)
  if (read.code !== 'query_failed') return read
  return new AppError('write_failed', {
    errors: [
      { field: '_', code: 'write_failed', ...(errno !== undefined && { params: { errno } }) },
    ],
  })
}
