// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CursorPosition } from './table-sql.ts'

/**
 * Keyset cursors (§10.6): base64url JSON signed with HMAC. A cursor carries the last sort
 * value and key, the direction, and a fingerprint of configuration, filters and sort, so it
 * cannot be reused for a different query or forged.
 */

export interface Cursor extends CursorPosition {
  fingerprint: string
}

const version = 1
const maxLength = 4096

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 22)
}

export function encodeCursor(key: Buffer, cursor: Cursor): string {
  const payload = Buffer.from(
    JSON.stringify([version, cursor.fingerprint, cursor.direction, cursor.sort, cursor.key]),
  ).toString('base64url')
  return `${payload}.${sign(key, payload)}`
}

/** The position in a cursor, or undefined if it is forged, damaged or for something else. */
export function decodeCursor(
  key: Buffer,
  text: string,
  fingerprint: string,
): CursorPosition | undefined {
  if (text.length > maxLength) return undefined
  const [payload, signature, extra] = text.split('.')
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined
  const expected = Buffer.from(sign(key, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return undefined
  const [v, print, direction, sort, position] = parsed as unknown[]
  if (v !== version || print !== fingerprint) return undefined
  if (direction !== 'next' && direction !== 'prev') return undefined
  const scalar = (value: unknown) =>
    value === null || typeof value === 'string' || typeof value === 'number'
  if (!scalar(sort) || !scalar(position) || position === null) return undefined
  return { direction, sort, key: position }
}
