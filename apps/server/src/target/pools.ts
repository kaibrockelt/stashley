// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import type { CredentialPurpose, Engine, TlsMode } from '@stashley/shared'
import mysql, {
  type Connection,
  type ConnectionOptions,
  type Pool,
  type PoolConnection,
} from 'mysql2/promise'
import { resolveTargetHost } from './address-guard.ts'
import { toTargetError } from './errors.ts'
import { parseServerVersion, type ServerVersion } from './version.ts'

/** Where and how to reach a target database. */
export interface TargetSpec {
  host: string
  port: number
  database: string
  tls: { mode: TlsMode; caPem: string | null; serverName: string | null }
  queryTimeoutMs: number
}

export interface TargetUser {
  purpose: CredentialPurpose
  username: string
  password: string
}

/** An open database session with its session setup applied. */
export interface TargetSession {
  readonly server: ServerVersion
  readonly engine: Engine
  query<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

const poolSizes: Record<CredentialPurpose, number> = { read: 10, write: 4, schema: 1 }

/**
 * SQL modes that change how the server reads string literals, quotes or the grammar. Stored
 * queries are validated with MySQL's default rules (§10.2), so the read session runs without
 * them: with `ANSI_QUOTES` a "string" would be an identifier, with `NO_BACKSLASH_ESCAPES`
 * a string could end where the validation saw none.
 */
const unsafeReadModes = new Set([
  'ANSI',
  'ANSI_QUOTES',
  'NO_BACKSLASH_ESCAPES',
  'ORACLE',
  'MSSQL',
  'DB2',
  'POSTGRESQL',
  'MAXDB',
])

/** The session's SQL mode without the modes that change how statements are read. */
export function readSqlMode(current: string): string {
  return current
    .split(',')
    .map((mode) => mode.trim())
    .filter((mode) => mode !== '' && !unsafeReadModes.has(mode.toUpperCase()))
    .join(',')
}
const connectTimeoutMs = 10_000

function sslOptions(spec: TargetSpec): ConnectionOptions['ssl'] {
  const { mode, caPem } = spec.tls
  if (mode === 'disabled') return undefined
  const ca = caPem === null || caPem === '' ? {} : { ca: caPem }
  if (mode === 'required') return { rejectUnauthorized: false }
  return { ...ca, rejectUnauthorized: true, verifyIdentity: mode === 'verify-full' }
}

/**
 * Driver options (§9.1). The socket goes to the address the guard checked, while `host`
 * stays the name, so TLS can verify the certificate against it.
 */
function driverOptions(spec: TargetSpec, user: TargetUser, address: string): ConnectionOptions {
  const ssl = sslOptions(spec)
  return {
    host: spec.tls.serverName ?? spec.host,
    port: spec.port,
    stream: () => connect({ host: address, port: spec.port }),
    user: user.username,
    password: user.password,
    database: spec.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    // JSON stays the raw text (§9.5); the driver would otherwise parse it into objects.
    jsonStrings: true,
    flags: ['FOUND_ROWS'],
    connectTimeout: connectTimeoutMs,
    ...(ssl !== undefined && { ssl }),
  }
}

interface RawSession {
  query(options: { sql: string; values?: unknown[]; timeout?: number }): Promise<[unknown, unknown]>
}

/** Session setup (§9.2), run once on every new connection. */
async function setUp(raw: RawSession, spec: TargetSpec, purpose: CredentialPurpose) {
  const [rows] = await raw.query({ sql: 'SELECT VERSION() AS v, @@version_comment AS c' })
  const first = (rows as { v: string; c: string | null }[])[0]
  const server = parseServerVersion(first?.v ?? '', first?.c ?? '')
  await raw.query({ sql: 'SET NAMES utf8mb4' })
  await raw.query({ sql: "SET time_zone = '+00:00'" })
  if (purpose === 'read') {
    const [modes] = await raw.query({ sql: 'SELECT @@SESSION.sql_mode AS m' })
    const current = (modes as { m: string | null }[])[0]?.m ?? ''
    await raw.query({ sql: 'SET SESSION sql_mode = ?', values: [readSqlMode(current)] })
    await raw.query({ sql: 'SET SESSION TRANSACTION READ ONLY' })
    if (server.engine === 'mariadb') {
      await raw.query({
        sql: 'SET SESSION max_statement_time = ?',
        values: [spec.queryTimeoutMs / 1000],
      })
    } else {
      await raw.query({ sql: 'SET SESSION max_execution_time = ?', values: [spec.queryTimeoutMs] })
    }
  }
  if (purpose === 'write') {
    await raw.query({
      sql: "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')",
    })
  }
  return server
}

function session(raw: RawSession, server: ServerVersion, spec: TargetSpec): TargetSession {
  return {
    server,
    engine: server.engine,
    async query<T extends object>(sql: string, params: unknown[] = []) {
      try {
        const [rows] = await raw.query({
          sql,
          values: params,
          timeout: spec.queryTimeoutMs + 2_000,
        })
        return rows as T[]
      } catch (error) {
        throw toTargetError(error)
      }
    },
  }
}

/** Resolves and checks a target host; tests on a developer machine may relax it. */
export type HostResolver = (host: string) => Promise<string>

async function once<T>(
  resolveHost: HostResolver,
  spec: TargetSpec,
  user: TargetUser,
  fn: (session: TargetSession) => Promise<T>,
): Promise<T> {
  const address = await resolveHost(spec.host)
  let connection: Connection
  try {
    connection = await mysql.createConnection(driverOptions(spec, user, address))
  } catch (error) {
    throw toTargetError(error)
  }
  try {
    let server: ServerVersion
    try {
      server = await setUp(connection, spec, user.purpose)
    } catch (error) {
      throw toTargetError(error)
    }
    return await fn(session(connection, server, spec))
  } finally {
    await connection.end().catch(() => undefined)
  }
}

interface PoolEntry {
  fingerprint: string
  pool: Pool
  servers: WeakMap<object, ServerVersion>
}

/**
 * One lazily created pool per connection and purpose (§9.1). A pool is recreated when its
 * settings change, and the host is checked again each time.
 */
export class TargetPools {
  private readonly pools = new Map<string, PoolEntry>()
  private readonly pending = new Map<string, Promise<PoolEntry>>()
  private readonly resolveHost: HostResolver

  constructor(options: { resolveHost?: HostResolver } = {}) {
    this.resolveHost = options.resolveHost ?? resolveTargetHost
  }

  /** Opens one connection outside the pools, e.g. to test settings before they are saved. */
  once<T>(
    spec: TargetSpec,
    user: TargetUser,
    fn: (session: TargetSession) => Promise<T>,
  ): Promise<T> {
    return once(this.resolveHost, spec, user, fn)
  }

  private entry(connectionId: string, spec: TargetSpec, user: TargetUser): Promise<PoolEntry> {
    const key = `${connectionId}:${user.purpose}`
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([spec, user.username, user.password]))
      .digest('hex')
    const existing = this.pools.get(key)
    if (existing?.fingerprint === fingerprint) return Promise.resolve(existing)
    // Concurrent first requests share one pool instead of each creating (and leaking) one.
    const pendingKey = `${key}:${fingerprint}`
    let creating = this.pending.get(pendingKey)
    if (creating === undefined) {
      creating = this.create(key, fingerprint, spec, user).finally(() =>
        this.pending.delete(pendingKey),
      )
      this.pending.set(pendingKey, creating)
    }
    return creating
  }

  private async create(
    key: string,
    fingerprint: string,
    spec: TargetSpec,
    user: TargetUser,
  ): Promise<PoolEntry> {
    const address = await this.resolveHost(spec.host)
    const pool = mysql.createPool({
      ...driverOptions(spec, user, address),
      connectionLimit: poolSizes[user.purpose],
      maxIdle: poolSizes[user.purpose],
      idleTimeout: 60_000,
      waitForConnections: true,
      queueLimit: 100,
    })
    const created: PoolEntry = { fingerprint, pool, servers: new WeakMap() }
    const replaced = this.pools.get(key)
    this.pools.set(key, created)
    if (replaced !== undefined) void replaced.pool.end().catch(() => undefined)
    return created
  }

  async run<T>(
    connectionId: string,
    spec: TargetSpec,
    user: TargetUser,
    fn: (session: TargetSession) => Promise<T>,
  ): Promise<T> {
    const entry = await this.entry(connectionId, spec, user)
    const { pool, servers } = entry
    let connection: PoolConnection
    try {
      connection = await pool.getConnection()
    } catch (error) {
      const failure = toTargetError(error)
      // The pool is pinned to the address checked at creation. When the server cannot be
      // reached there (e.g. its container got a new address), the next call resolves again.
      if (failure.failure === 'unreachable' || failure.failure === 'timeout') {
        this.drop(`${connectionId}:${user.purpose}`, entry)
      }
      throw failure
    }
    let reusable = true
    try {
      let server = servers.get(connection.connection)
      if (server === undefined) {
        try {
          server = await setUp(connection, spec, user.purpose)
        } catch (error) {
          reusable = false
          throw toTargetError(error)
        }
        servers.set(connection.connection, server)
      }
      return await fn(session(connection, server, spec))
    } catch (error) {
      // A failed call may leave a transaction open; the next caller must not inherit it.
      if (reusable) {
        reusable = await connection.query('ROLLBACK').then(
          () => true,
          () => false,
        )
      }
      throw error
    } finally {
      if (reusable) connection.release()
      else connection.destroy()
    }
  }

  private drop(key: string, entry: PoolEntry): void {
    if (this.pools.get(key) !== entry) return
    this.pools.delete(key)
    void entry.pool.end().catch(() => undefined)
  }

  /** Closes the pools of a connection, e.g. after its settings changed or it was removed. */
  async invalidate(connectionId: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [key, entry] of this.pools) {
      if (key.startsWith(`${connectionId}:`)) {
        this.pools.delete(key)
        closing.push(entry.pool.end().catch(() => undefined))
      }
    }
    await Promise.all(closing)
  }

  async closeAll(): Promise<void> {
    const entries = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(entries.map((entry) => entry.pool.end().catch(() => undefined)))
  }
}
