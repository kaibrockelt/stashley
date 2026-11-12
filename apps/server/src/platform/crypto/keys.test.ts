// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { createKeyRing, decrypt, DecryptionError, encrypt } from './keys.ts'

const keys = createKeyRing('a'.repeat(32))
const other = createKeyRing('b'.repeat(32))

describe('key ring', () => {
  it('derives distinct keys per purpose', () => {
    expect(keys.key('credentials').equals(keys.key('session'))).toBe(false)
    expect(keys.key('credentials')).toHaveLength(32)
  })

  it('derives a stable key id that differs between secrets', () => {
    expect(createKeyRing('a'.repeat(32)).keyId).toBe(keys.keyId)
    expect(other.keyId).not.toBe(keys.keyId)
  })
})

describe('encrypt and decrypt', () => {
  it('round-trips with the same additional data', () => {
    const value = encrypt(keys, 'pässwörd', 'connection_credentials:1:password')
    expect(value.startsWith(`v1.${keys.keyId}.`)).toBe(true)
    expect(decrypt(keys, value, 'connection_credentials:1:password')).toBe('pässwörd')
  })

  it('uses a fresh IV for every value', () => {
    expect(encrypt(keys, 'x', 'a')).not.toBe(encrypt(keys, 'x', 'a'))
  })

  it('rejects values moved to another row', () => {
    const value = encrypt(keys, 'secret', 'connection_credentials:1:password')
    expect(() => decrypt(keys, value, 'connection_credentials:2:password')).toThrow(DecryptionError)
  })

  it('rejects values encrypted with another key', () => {
    const value = encrypt(other, 'secret', 'a')
    expect(() => decrypt(keys, value, 'a')).toThrow('Encrypted with a different key')
  })

  it('rejects tampered or malformed values', () => {
    const value = encrypt(keys, 'secret', 'a')
    const parts = value.split('.')
    parts[4] = Buffer.from('tampered').toString('base64url')
    expect(() => decrypt(keys, parts.join('.'), 'a')).toThrow(DecryptionError)
    expect(() => decrypt(keys, 'garbage', 'a')).toThrow('Unknown format')
  })
})
