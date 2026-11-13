// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import ipaddr from 'ipaddr.js'
import { TargetError } from './errors.ts'

type Address = ipaddr.IPv4 | ipaddr.IPv6

/** Ranges a target database may live in; everything else is refused. */
const allowedIPv4 = new Set(['unicast', 'private', 'carrierGradeNat'])
const globalUnicast = ipaddr.IPv6.parse('2000::')

/**
 * Parses an address in any notation. IPv4-mapped IPv6 addresses (`::ffff:7f00:1`,
 * `0:0:0:0:0:ffff:127.0.0.1`) become IPv4, so they get the IPv4 checks.
 */
function canonical(address: string): Address | undefined {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  return ipaddr.isValid(bare) ? ipaddr.process(bare) : undefined
}

function allowed(ip: Address): boolean {
  if (ip instanceof ipaddr.IPv4) return allowedIPv4.has(ip.range())
  // Global unicast (2000::/3) or unique local (fc00::/7). This leaves out loopback,
  // link-local, IPv4-compatible (::a.b.c.d) and the translation and tunnel prefixes
  // (NAT64, 6to4, Teredo) that can embed an IPv4 address.
  const range = ip.range()
  return range === 'uniqueLocal' || (range === 'unicast' && ip.match(globalUnicast, 3))
}

/**
 * Only public, private and carrier-grade NAT addresses can reach a target database.
 * Loopback, unspecified, link-local, multicast, reserved and documentation ranges never do.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = canonical(address)
  return ip === undefined || !allowed(ip)
}

function ownAddresses(): Set<string> {
  const own = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const ip = canonical(entry.address)
      if (ip !== undefined) own.add(ip.toNormalizedString())
    }
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
  if (addresses.length === 0) throw new TargetError('unreachable')
  const own = ownAddresses()
  const checked: string[] = []
  for (const address of addresses) {
    const ip = canonical(address)
    if (ip === undefined || !allowed(ip) || own.has(ip.toNormalizedString())) {
      throw new TargetError('host_not_allowed')
    }
    checked.push(ip.toString())
  }
  return checked[0] ?? literal
}
