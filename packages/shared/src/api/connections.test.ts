// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { sameConnectionTarget, type ConnectionTarget } from './connections.ts'

const stored: ConnectionTarget = {
  host: 'db.example.com',
  port: 3306,
  tls: { mode: 'verify-full', caPem: '-----BEGIN CERTIFICATE-----\nabc\n', serverName: null },
}
const changed = (overrides: Partial<ConnectionTarget>) => ({ ...stored, ...overrides })

describe('sameConnectionTarget', () => {
  it('keeps stored passwords for the same server', () => {
    expect(sameConnectionTarget(stored, stored)).toBe(true)
    expect(
      sameConnectionTarget(
        stored,
        changed({
          host: ' DB.Example.com ',
          tls: { ...stored.tls, caPem: '-----BEGIN CERTIFICATE-----\nabc', serverName: '' },
        }),
      ),
    ).toBe(true)
  })

  it('asks for passwords again when host, port or TLS settings change', () => {
    for (const target of [
      changed({ host: 'attacker.example.net' }),
      changed({ port: 3307 }),
      changed({ tls: { ...stored.tls, mode: 'disabled' } }),
      changed({ tls: { ...stored.tls, mode: 'required' } }),
      changed({ tls: { ...stored.tls, caPem: null } }),
      changed({ tls: { ...stored.tls, serverName: 'other.example.com' } }),
    ]) {
      expect(sameConnectionTarget(stored, target), JSON.stringify(target)).toBe(false)
    }
  })
})
