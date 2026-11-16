// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

const purposes = {
  credentials: 'stashley/credentials/v1',
  session: 'stashley/session/v1',
  cursor: 'stashley/cursor/v1',
  state: 'stashley/state/v1',
  csrf: 'stashley/csrf/v1',
  oauthCookies: 'stashley/oauth-cookies/v1',
  rowVersion: 'stashley/row-version/v1',
} as const

export type KeyPurpose = keyof typeof purposes

export interface KeyRing {
  /** Identifies the root key without revealing it; stored with every ciphertext. */
  readonly keyId: string
  key(purpose: KeyPurpose): Buffer
}

export function createKeyRing(secret: string): KeyRing {
  const root = Buffer.from(secret, 'utf8')
  const derived = new Map<KeyPurpose, Buffer>()
  for (const [purpose, info] of Object.entries(purposes) as [KeyPurpose, string][]) {
    derived.set(purpose, Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), info, 32)))
  }
  const keyId = createHmac('sha256', root).update('stashley/key-id').digest().subarray(0, 8)
  return {
    keyId: keyId.toString('hex'),
    key(purpose) {
      const value = derived.get(purpose)
      if (value === undefined) throw new Error(`Unknown key purpose ${purpose}`)
      return value
    },
  }
}

const version = 'v1'

/**
 * Encrypts with AES-256-GCM. The additional authenticated data binds the ciphertext to
 * its storage location (`<table>:<row id>:<column>`) so values cannot be swapped.
 */
export function encrypt(keys: KeyRing, plaintext: string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.key('credentials'), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [version, keys.keyId, iv, tag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.')
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

export function decrypt(keys: KeyRing, value: string, aad: string): string {
  const parts = value.split('.')
  if (parts.length !== 5 || parts[0] !== version) throw new DecryptionError('Unknown format')
  const [, keyId, iv, tag, ciphertext] = parts as [string, string, string, string, string]
  if (keyId !== keys.keyId) throw new DecryptionError('Encrypted with a different key')
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keys.key('credentials'),
      Buffer.from(iv, 'base64url'),
    )
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new DecryptionError('Authentication failed')
  }
}
