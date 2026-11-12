// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { hash, verify, type Algorithm } from '@node-rs/argon2'
import { passwordMinLength } from '@stashley/shared'
import { fieldError } from '../../platform/http/validation.ts'
import { commonPasswords } from './common-passwords.ts'

/**
 * OWASP baseline for Argon2id. `2` is `Algorithm.Argon2id`; the const enum cannot be
 * referenced under verbatimModuleSyntax.
 */
const params = { algorithm: 2 as Algorithm, memoryCost: 19_456, timeCost: 2, parallelism: 1 }
const paramString = `m=${params.memoryCost},t=${params.timeCost},p=${params.parallelism}`

const common = new Set(commonPasswords)

export function hashPassword(password: string): Promise<string> {
  return hash(password, params)
}

/** Verifies a password. Without a stored hash, a dummy hash is checked so timing stays equal. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  const target = stored ?? (await dummyHash)
  try {
    const ok = await verify(target, password)
    return stored !== null && ok
  } catch {
    return false
  }
}

const dummyHash = hashPassword('stashley-dummy-password-for-timing')

export function needsRehash(stored: string): boolean {
  return !stored.startsWith('$argon2id$') || !stored.includes(paramString)
}

/** Rejects weak passwords with field errors on `field`. */
export function checkPasswordPolicy(password: string, email: string, field = 'password'): void {
  const lower = password.toLowerCase()
  if (password.length < passwordMinLength) throw fieldError(field, 'too_short')
  if (common.has(lower)) throw fieldError(field, 'too_common')
  const normalizedEmail = email.toLowerCase()
  const localPart = normalizedEmail.split('@')[0] ?? ''
  if (lower === normalizedEmail || (localPart.length >= 4 && lower === localPart)) {
    throw fieldError(field, 'matches_email')
  }
}
