// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import ipaddr from 'ipaddr.js'
import { describe, expect, it } from 'vitest'
import { isBlockedAddress, resolveTargetHost } from './address-guard.ts'
import { decodeDateTime, encodeValue } from './encoding.ts'
import { toTargetError } from './errors.ts'
import { TargetPools } from './pools.ts'
import { parseServerVersion } from './version.ts'

describe('address guard', () => {
  it('blocks loopback, link-local, special ranges and every notation of them', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.1',
      '0.0.0.0',
      '169.254.169.254',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '192.0.2.10',
      '::1',
      '::',
      'fe80::1',
      'fe80::1%eth0',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      // IPv4-mapped loopback and metadata addresses in every notation.
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '[::ffff:7f00:1]',
      '::ffff:a9fe:a9fe',
      // IPv4-compatible, NAT64, 6to4 and Teredo addresses can embed an IPv4 address.
      '::7f00:1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::1',
      '2001:0:4136:e378::1',
      'not-an-address',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    for (const address of [
      '10.0.0.5',
      '172.18.0.3',
      '192.168.1.20',
      '100.64.0.10',
      '8.8.8.8',
      '::ffff:10.0.0.5',
      '2a01:4f8::1',
      'fd12:3456::1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(false)
    }
  })

  it('refuses hosts that resolve to loopback or to Stashley itself', async () => {
    const refused = { failure: 'host_not_allowed' }
    await expect(resolveTargetHost('localhost')).rejects.toMatchObject(refused)
    await expect(resolveTargetHost('[::1]')).rejects.toMatchObject(refused)
    await expect(resolveTargetHost('::ffff:7f00:1')).rejects.toMatchObject(refused)
    await expect(resolveTargetHost('10.1.2.3')).resolves.toBe('10.1.2.3')
    // The socket connects to the checked address in canonical form.
    await expect(resolveTargetHost('::ffff:10.1.2.3')).resolves.toBe('10.1.2.3')
    await expect(resolveTargetHost('[2a01:4f8::1]')).resolves.toBe('2a01:4f8::1')
    const own = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && !entry.internal && entry.family === 'IPv4')
    if (own !== undefined) {
      await expect(resolveTargetHost(own.address)).rejects.toMatchObject(refused)
      const mapped = ipaddr.IPv4.parse(own.address).toIPv4MappedAddress().toString()
      await expect(resolveTargetHost(mapped)).rejects.toMatchObject(refused)
    }
  })
})

describe('pools', () => {
  it('resolve the host again after the pinned address could not be reached', async () => {
    // A port that was just free: connections are refused at once.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise((resolve) => probe.close(resolve))
    const resolved: string[] = []
    const pools = new TargetPools({
      resolveHost: (host) => {
        resolved.push(host)
        return Promise.resolve('127.0.0.1')
      },
    })
    const spec = {
      host: 'db.example.com',
      port,
      database: 'wanderverein',
      tls: { mode: 'disabled' as const, caPem: null, serverName: null },
      queryTimeoutMs: 1000,
    }
    const user = { purpose: 'read' as const, username: 'u', password: 'p' }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(pools.run('c1', spec, user, () => Promise.resolve())).rejects.toMatchObject({
        failure: 'unreachable',
      })
    }
    expect(resolved).toEqual(['db.example.com', 'db.example.com'])

    // Concurrent first requests share one pool, so the host is resolved once.
    resolved.length = 0
    const both = await Promise.allSettled([
      pools.run('c2', spec, user, () => Promise.resolve()),
      pools.run('c2', spec, user, () => Promise.resolve()),
    ])
    expect(both.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(resolved).toEqual(['db.example.com'])
    await pools.closeAll()
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

  it('flags invalid dates from legacy data instead of failing', () => {
    expect(encodeValue('date', '2025-02-30', 'UTC')).toEqual({ value: null, invalid: true })
    expect(encodeValue('datetime', '2025-02-30 10:00:00', 'UTC')).toEqual({
      value: null,
      invalid: true,
    })
    expect(encodeValue('timestamp', '2025-13-01 10:00:00', 'UTC')).toEqual({
      value: null,
      invalid: true,
    })
    expect(encodeValue('date', '2024-02-29', 'UTC')).toEqual({ value: '2024-02-29' })
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
