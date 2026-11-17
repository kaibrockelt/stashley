// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'
import type {
  ApiOperation,
  ApiToken,
  ApiTokenCreated,
  ApiTokenGrant,
  apiTokenCreate,
  apiTokenUpdate,
} from '@stashley/shared'
import ipaddr from 'ipaddr.js'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { ApiTokensTable, Database } from '../../metastore/schema.ts'
import { minute, systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import { isApiOperation } from './endpoints.ts'

/**
 * API tokens (§16, §21.4, E20): `stl_api_`, 32 random bytes in base62 and a CRC32 checksum,
 * so secret scanners recognize them. Only the SHA-256 hash and a hint are stored; the token
 * is shown once. Tokens belong to the instance, not to the admin who created them.
 */

export const tokenPrefix = 'stl_api_'
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const bodyLength = 43
const checksumLength = 6
const tokenPattern = new RegExp(`^${tokenPrefix}[0-9A-Za-z]{${bodyLength + checksumLength}}$`)

function base62(value: bigint, length: number): string {
  let out = ''
  let rest = value
  while (rest > 0n) {
    out = alphabet[Number(rest % 62n)] + out
    rest /= 62n
  }
  return out.padStart(length, '0')
}

function checksum(body: string): string {
  return base62(BigInt(crc32(body)), checksumLength)
}

export function generateToken(): string {
  const body = base62(BigInt(`0x${randomBytes(32).toString('hex')}`), bodyLength)
  return `${tokenPrefix}${body}${checksum(body)}`
}

/** Format and checksum; a token that fails here is never looked up. */
export function wellFormed(token: string): boolean {
  if (!tokenPattern.test(token)) return false
  const body = token.slice(tokenPrefix.length, tokenPrefix.length + bodyLength)
  return token.endsWith(checksum(body))
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** Parses an allowlist entry: an address or a CIDR range, IPv4-mapped IPv6 as IPv4. */
function parseRange(entry: string): [ipaddr.IPv4 | ipaddr.IPv6, number] | undefined {
  try {
    if (entry.includes('/')) {
      const [address, bits] = ipaddr.parseCIDR(entry)
      if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
        return [(address as ipaddr.IPv6).toIPv4Address(), Math.max(0, bits - 96)]
      }
      return [address, bits]
    }
    const address = ipaddr.process(entry)
    return [address, address.kind() === 'ipv4' ? 32 : 128]
  } catch {
    return undefined
  }
}

/** Whether a client address is inside one of the ranges; an empty list allows any address. */
export function addressAllowed(allowlist: readonly string[], ip: string): boolean {
  if (allowlist.length === 0) return true
  let address: ipaddr.IPv4 | ipaddr.IPv6
  try {
    address = ipaddr.process(ip)
  } catch {
    return false
  }
  return allowlist.some((entry) => {
    const range = parseRange(entry)
    if (range === undefined || range[0].kind() !== address.kind()) return false
    return address.match(range)
  })
}

/** A resolved, valid token: what a request may do (§16). */
export interface ApiPrincipal {
  tokenId: string
  name: string
  rateLimitPerMinute: number
  /** Operations by table access ID. */
  grants: ReadonlyMap<string, ReadonlySet<ApiOperation>>
}

interface CachedToken {
  row: ApiTokensTable
  allowlist: string[]
  principal: ApiPrincipal
}

export type TokenCheck =
  { ok: true; principal: ApiPrincipal } | { ok: false; code: 'unauthenticated' | 'forbidden' }

type TokenInput = z.infer<typeof apiTokenCreate>

const flushInterval = 30_000

export class ApiTokens {
  private readonly deps: {
    db: Kysely<Database>
    audit: AuditLog
    events: EventBus
  }
  private readonly clock: Clock
  /** Resolved tokens by hash; dropped on every change (revocation takes effect at once). */
  private cache = new Map<string, Promise<CachedToken | undefined>>()
  private usage = new Map<string, { count: number; lastUsed: number }>()
  /** Requests per token in the current minute (E20). */
  private windows = new Map<string, { start: number; count: number }>()
  private timer: NodeJS.Timeout | undefined

  constructor(deps: ApiTokens['deps'] & { clock?: Clock }) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    deps.events.on('api.changed', () => {
      this.cache = new Map()
    })
    deps.events.on('table-access.changed', () => {
      this.cache = new Map()
    })
  }

  // Requests

  /** Resolves a bearer token: format, hash, revocation, expiry, then the IP allowlist. */
  async authenticate(token: string, ip: string): Promise<TokenCheck> {
    if (!wellFormed(token)) return { ok: false, code: 'unauthenticated' }
    const hash = hashToken(token)
    let entry = this.cache.get(hash)
    if (entry === undefined) {
      const cache = this.cache
      const loading = this.load(hash)
      // Unknown tokens are not kept: random well-formed ones would fill the cache.
      loading.then(
        (found) => {
          if (found === undefined && cache.get(hash) === loading) cache.delete(hash)
        },
        () => {
          if (cache.get(hash) === loading) cache.delete(hash)
        },
      )
      cache.set(hash, loading)
      entry = loading
    }
    const cached = await entry
    if (cached === undefined || cached.row.revoked_at !== null) {
      return { ok: false, code: 'unauthenticated' }
    }
    if (cached.row.expires_at !== null && cached.row.expires_at <= this.clock()) {
      return { ok: false, code: 'unauthenticated' }
    }
    if (!addressAllowed(cached.allowlist, ip)) return { ok: false, code: 'forbidden' }
    return { ok: true, principal: cached.principal }
  }

  private async load(hash: string): Promise<CachedToken | undefined> {
    const row = await this.deps.db
      .selectFrom('api_tokens')
      .selectAll()
      .where('token_hash', '=', hash)
      .executeTakeFirst()
    if (row === undefined) return undefined
    // Grants count only on enabled endpoints (§16).
    const grants = await this.deps.db
      .selectFrom('api_token_grants')
      .innerJoin('api_endpoints', (join) =>
        join
          .onRef('api_endpoints.table_access_id', '=', 'api_token_grants.table_access_id')
          .onRef('api_endpoints.operation', '=', 'api_token_grants.operation'),
      )
      .select(['api_token_grants.table_access_id', 'api_token_grants.operation'])
      .where('api_token_grants.token_id', '=', row.id)
      .execute()
    const byAccess = new Map<string, Set<ApiOperation>>()
    for (const grant of grants) {
      if (!isApiOperation(grant.operation)) continue
      const set = byAccess.get(grant.table_access_id) ?? new Set<ApiOperation>()
      set.add(grant.operation)
      byAccess.set(grant.table_access_id, set)
    }
    return {
      row,
      allowlist: JSON.parse(row.ip_allowlist) as string[],
      principal: {
        tokenId: row.id,
        name: row.name,
        rateLimitPerMinute: row.rate_limit_per_minute,
        grants: byAccess,
      },
    }
  }

  /** Counts a request; the seconds to wait when the token's limit is reached (E20). */
  take(principal: ApiPrincipal): number {
    const now = this.clock()
    const window = this.windows.get(principal.tokenId)
    if (window === undefined || now - window.start >= minute) {
      this.windows.set(principal.tokenId, { start: now, count: 1 })
    } else {
      if (window.count >= principal.rateLimitPerMinute) {
        return Math.max(1, Math.ceil((window.start + minute - now) / 1000))
      }
      window.count++
    }
    const usage = this.usage.get(principal.tokenId) ?? { count: 0, lastUsed: now }
    usage.count++
    usage.lastUsed = now
    this.usage.set(principal.tokenId, usage)
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, flushInterval).unref()
    return 0
  }

  /** Writes the usage counters in one batch (every 30 s and on shutdown). */
  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const pending = this.usage
    this.usage = new Map()
    if (pending.size === 0) return
    await writeTransaction(this.deps.db, async (trx) => {
      for (const [id, usage] of pending) {
        await trx
          .updateTable('api_tokens')
          .set((eb) => ({
            request_count: eb('request_count', '+', usage.count),
            last_used_at: usage.lastUsed,
          }))
          .where('id', '=', id)
          .execute()
      }
    })
  }

  // Administration

  private async grantsOf(ids: string[]): Promise<Map<string, ApiTokenGrant[]>> {
    const grants = new Map<string, ApiTokenGrant[]>()
    if (ids.length === 0) return grants
    const rows = await this.deps.db
      .selectFrom('api_token_grants')
      .select(['token_id', 'table_access_id', 'operation'])
      .where('token_id', 'in', ids)
      .orderBy('table_access_id')
      .orderBy('operation')
      .execute()
    for (const row of rows) {
      if (!isApiOperation(row.operation)) continue
      const list = grants.get(row.token_id) ?? []
      list.push({ tableAccessId: row.table_access_id, operation: row.operation })
      grants.set(row.token_id, list)
    }
    return grants
  }

  private toApi(
    row: ApiTokensTable & { creator: string | null },
    grants: ApiTokenGrant[],
    usage?: { count: number; lastUsed: number },
  ): ApiToken {
    return {
      id: row.id,
      name: row.name,
      hint: row.token_hint,
      expiresAt: row.expires_at,
      ipAllowlist: JSON.parse(row.ip_allowlist) as string[],
      rateLimitPerMinute: row.rate_limit_per_minute,
      createdBy: row.creator,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
      lastUsedAt: usage?.lastUsed ?? row.last_used_at,
      requestCount: row.request_count + (usage?.count ?? 0),
      grants,
    }
  }

  private rows() {
    return this.deps.db
      .selectFrom('api_tokens')
      .leftJoin('users', 'users.id', 'api_tokens.created_by')
      .selectAll('api_tokens')
      .select('users.email as creator')
  }

  async list(): Promise<ApiToken[]> {
    const rows = await this.rows().orderBy('api_tokens.created_at', 'desc').execute()
    const grants = await this.grantsOf(rows.map((row) => row.id))
    return rows.map((row) => this.toApi(row, grants.get(row.id) ?? [], this.usage.get(row.id)))
  }

  async get(id: string): Promise<ApiToken> {
    const row = await this.rows().where('api_tokens.id', '=', id).executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    const grants = await this.grantsOf([id])
    return this.toApi(row, grants.get(id) ?? [], this.usage.get(id))
  }

  /** Checks addresses and grants: each grant must be on an enabled endpoint (§16). */
  private async check(
    input: TokenInput,
  ): Promise<{ allowlist: string[]; grants: ApiTokenGrant[] }> {
    const errors: { field: string; code: string }[] = []
    const allowlist: string[] = []
    input.ipAllowlist.forEach((entry, index) => {
      const range = parseRange(entry)
      if (range === undefined) errors.push({ field: `ipAllowlist.${index}`, code: 'invalid' })
      else allowlist.push(entry)
    })
    if (input.expiresAt !== null && input.expiresAt <= this.clock()) {
      errors.push({ field: 'expiresAt', code: 'in_the_past' })
    }
    const unique = new Map(
      input.grants.map((grant) => [`${grant.tableAccessId}:${grant.operation}`, grant]),
    )
    const grants = [...unique.values()]
    if (grants.length > 0) {
      const enabled = await this.deps.db
        .selectFrom('api_endpoints')
        .select(['table_access_id', 'operation'])
        .where(
          'table_access_id',
          'in',
          grants.map((grant) => grant.tableAccessId),
        )
        .execute()
      const keys = new Set(enabled.map((row) => `${row.table_access_id}:${row.operation}`))
      input.grants.forEach((grant, index) => {
        if (!keys.has(`${grant.tableAccessId}:${grant.operation}`)) {
          errors.push({ field: `grants.${index}`, code: 'endpoint_disabled' })
        }
      })
    }
    if (errors.length > 0) throw new AppError('validation_failed', { errors })
    return { allowlist, grants }
  }

  private async saveGrants(
    trx: Kysely<Database>,
    tokenId: string,
    grants: ApiTokenGrant[],
  ): Promise<void> {
    await trx.deleteFrom('api_token_grants').where('token_id', '=', tokenId).execute()
    if (grants.length === 0) return
    await trx
      .insertInto('api_token_grants')
      .values(
        grants.map((grant) => ({
          token_id: tokenId,
          table_access_id: grant.tableAccessId,
          operation: grant.operation,
        })),
      )
      .execute()
  }

  async create(actor: Actor, input: TokenInput): Promise<ApiTokenCreated> {
    const { allowlist, grants } = await this.check(input)
    const secret = generateToken()
    const id = uuidv7()
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .insertInto('api_tokens')
        .values({
          id,
          name: input.name,
          token_hash: hashToken(secret),
          token_hint: secret.slice(-4),
          expires_at: input.expiresAt,
          ip_allowlist: JSON.stringify(allowlist),
          rate_limit_per_minute: input.rateLimitPerMinute,
          created_by: actor.kind === 'user' ? actor.id : null,
          created_at: now,
          updated_at: now,
          revoked_at: null,
          last_used_at: null,
          request_count: 0,
        })
        .execute()
      await this.saveGrants(trx, id, grants)
    })
    await this.deps.audit.record(actor, {
      action: 'api_token.created',
      subject: { kind: 'api_token', id, label: input.name },
      details: {
        expiresAt: input.expiresAt,
        ipAllowlist: allowlist,
        rateLimitPerMinute: input.rateLimitPerMinute,
        grants,
      },
    })
    this.deps.events.emit('api.changed', {})
    return { token: await this.get(id), secret }
  }

  async update(actor: Actor, id: string, input: z.infer<typeof apiTokenUpdate>): Promise<ApiToken> {
    const before = await this.get(id)
    if (before.revokedAt !== null) throw new AppError('conflict')
    const { allowlist, grants } = await this.check(input)
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .updateTable('api_tokens')
        .set({
          name: input.name,
          expires_at: input.expiresAt,
          ip_allowlist: JSON.stringify(allowlist),
          rate_limit_per_minute: input.rateLimitPerMinute,
          updated_at: this.clock(),
        })
        .where('id', '=', id)
        .execute()
      await this.saveGrants(trx, id, grants)
    })
    const after = await this.get(id)
    const changes: Record<string, [unknown, unknown]> = {}
    for (const field of [
      'name',
      'expiresAt',
      'ipAllowlist',
      'rateLimitPerMinute',
      'grants',
    ] as const) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
        changes[field] = [before[field], after[field]]
      }
    }
    if (Object.keys(changes).length > 0) {
      await this.deps.audit.record(actor, {
        action: 'api_token.updated',
        subject: { kind: 'api_token', id, label: after.name },
        changes,
      })
    }
    this.deps.events.emit('api.changed', {})
    return after
  }

  /** Revokes a token with immediate effect; revoked tokens stay listed. */
  async revoke(actor: Actor, id: string): Promise<ApiToken> {
    const before = await this.get(id)
    if (before.revokedAt === null) {
      await this.deps.db
        .updateTable('api_tokens')
        .set({ revoked_at: this.clock(), updated_at: this.clock() })
        .where('id', '=', id)
        .execute()
      this.deps.events.emit('api.changed', {})
      await this.deps.audit.record(actor, {
        action: 'api_token.revoked',
        subject: { kind: 'api_token', id, label: before.name },
      })
    }
    return this.get(id)
  }
}
