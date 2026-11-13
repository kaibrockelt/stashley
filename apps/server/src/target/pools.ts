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

/** Opens one connection outside the pools, e.g. to test settings before they are saved. */
export async function withTargetConnection<T>(
  spec: TargetSpec,
  user: TargetUser,
  fn: (session: TargetSession) => Promise<T>,
): Promise<T> {
  const address = await resolveTargetHost(spec.host)
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

  private async entry(connectionId: string, spec: TargetSpec, user: TargetUser) {
    const key = `${connectionId}:${user.purpose}`
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([spec, user.username, user.password]))
      .digest('hex')
    const existing = this.pools.get(key)
    if (existing?.fingerprint === fingerprint) return existing
    if (existing !== undefined) {
      this.pools.delete(key)
      void existing.pool.end().catch(() => undefined)
    }
    const address = await resolveTargetHost(spec.host)
    const pool = mysql.createPool({
      ...driverOptions(spec, user, address),
      connectionLimit: poolSizes[user.purpose],
      maxIdle: poolSizes[user.purpose],
      idleTimeout: 60_000,
      waitForConnections: true,
      queueLimit: 100,
    })
    const created: PoolEntry = { fingerprint, pool, servers: new WeakMap() }
    this.pools.set(key, created)
    return created
  }

  async run<T>(
    connectionId: string,
    spec: TargetSpec,
    user: TargetUser,
    fn: (session: TargetSession) => Promise<T>,
  ): Promise<T> {
    const { pool, servers } = await this.entry(connectionId, spec, user)
    let connection: PoolConnection
    try {
      connection = await pool.getConnection()
    } catch (error) {
      throw toTargetError(error)
    }
    try {
      let server = servers.get(connection.connection)
      if (server === undefined) {
        try {
          server = await setUp(connection, spec, user.purpose)
        } catch (error) {
          connection.destroy()
          throw toTargetError(error)
        }
        servers.set(connection.connection, server)
      }
      return await fn(session(connection, server, spec))
    } finally {
      connection.release()
    }
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
