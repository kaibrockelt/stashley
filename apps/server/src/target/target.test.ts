// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { isBlockedAddress, resolveTargetHost } from './address-guard.ts'
import { decodeDateTime, encodeValue } from './encoding.ts'
import { toTargetError } from './errors.ts'
import { parseServerVersion } from './version.ts'

describe('address guard', () => {
  it('blocks loopback, unspecified and link-local addresses', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.1',
      '0.0.0.0',
      '169.254.1.1',
      '::1',
      '::',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    for (const address of ['10.0.0.5', '172.18.0.3', '192.168.1.20', '2001:db8::1', '8.8.8.8']) {
      expect(isBlockedAddress(address), address).toBe(false)
    }
  })

  it('refuses hosts that resolve to loopback', async () => {
    await expect(resolveTargetHost('localhost')).rejects.toMatchObject({
      failure: 'host_not_allowed',
    })
    await expect(resolveTargetHost('[::1]')).rejects.toMatchObject({ failure: 'host_not_allowed' })
    await expect(resolveTargetHost('10.1.2.3')).resolves.toBe('10.1.2.3')
  })
})

describe('server versions', () => {
  it('detects engine and vendor support', () => {
    expect(parseServerVersion('11.4.2-MariaDB-ubu2404', 'mariadb.org binary distribution')).toEqual(
      {
        engine: 'mariadb',
        version: '11.4.2',
        supported: true,
      },
    )
    expect(parseServerVersion('10.6.18-MariaDB', '')).toMatchObject({ supported: false })
    expect(parseServerVersion('8.4.2', 'MySQL Community Server - GPL')).toEqual({
      engine: 'mysql',
      version: '8.4.2',
      supported: true,
    })
    expect(parseServerVersion('8.0.39', 'MySQL Community Server - GPL').supported).toBe(false)
  })
})

describe('driver errors', () => {
  it('map to failure codes without messages', () => {
    const error = Object.assign(new Error("Access denied for user 'x'@'1.2.3.4'"), {
      code: 'ER_ACCESS_DENIED_ERROR',
    })
    const mapped = toTargetError(error)
    expect(mapped.failure).toBe('access_denied')
    expect(mapped.message).not.toContain('1.2.3.4')
    expect(toTargetError(Object.assign(new Error(), { code: 'ECONNREFUSED' })).failure).toBe(
      'unreachable',
    )
    expect(toTargetError(new Error('?')).failure).toBe('failed')
  })
})

describe('value encoding', () => {
  it('encodes driver values as JSON (§9.5)', () => {
    expect(encodeValue('boolean', 1, 'UTC').value).toBe(true)
    expect(encodeValue('bigint', '9007199254740993', 'UTC').value).toBe('9007199254740993')
    expect(encodeValue('decimal', '25.00', 'UTC').value).toBe('25.00')
    expect(encodeValue('set', 'a,b', 'UTC').value).toEqual(['a', 'b'])
    expect(encodeValue('date', '0000-00-00', 'UTC')).toEqual({ value: null, invalid: true })
    expect(encodeValue('timestamp', '2025-05-01 08:00:00', 'Europe/Berlin').value).toBe(
      '2025-05-01T08:00:00Z',
    )
  })

  it('reads DATETIME in the connection time zone and writes it back', () => {
    expect(encodeValue('datetime', '2025-05-01 10:00:00', 'Europe/Berlin').value).toBe(
      '2025-05-01T08:00:00Z',
    )
    expect(decodeDateTime('2025-05-01T08:00:00Z', 'Europe/Berlin')).toBe('2025-05-01 10:00:00')
    // A wall time in the spring gap resolves forward ("compatible").
    expect(encodeValue('datetime', '2025-03-30 02:30:00', 'Europe/Berlin').value).toBe(
      '2025-03-30T01:30:00Z',
    )
  })
})
