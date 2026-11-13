// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { TargetError } from './errors.ts'

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part)) ? parts : undefined
}

/** Unwraps `::ffff:1.2.3.4`, so mapped IPv4 addresses get the IPv4 checks. */
function normalize(address: string): string {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  return mapped?.[1] ?? lower
}

/** Loopback, unspecified and link-local addresses never reach a target database. */
export function isBlockedAddress(address: string): boolean {
  const ip = normalize(address)
  const v4 = isIP(ip) === 4 ? ipv4Parts(ip) : undefined
  if (v4 !== undefined) {
    const [a = 0, b = 0] = v4
    return a === 127 || a === 0 || (a === 169 && b === 254)
  }
  if (isIP(ip) !== 6) return true
  return ip === '::1' || ip === '::' || /^fe[89ab][0-9a-f]:/.test(ip)
}

function ownAddresses(): Set<string> {
  const own = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) own.add(normalize(entry.address))
  }
  return own
}

/**
 * Resolves a target host and returns the address to connect to. The check runs before every
 * pool is created, and the pool connects to the checked address, so DNS rebinding between
 * check and connect cannot redirect it to Stashley's own container (§9.1).
 */
export async function resolveTargetHost(host: string): Promise<string> {
  const literal = host.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (isIP(literal) !== 0) {
    addresses = [literal]
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
    } catch {
      throw new TargetError('unreachable')
    }
  }
  const own = ownAddresses()
  if (addresses.length === 0) throw new TargetError('unreachable')
  for (const address of addresses) {
    if (isBlockedAddress(address) || own.has(normalize(address))) {
      throw new TargetError('host_not_allowed')
    }
  }
  return addresses[0] ?? literal
}
