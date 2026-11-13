// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { X509Certificate } from 'node:crypto'
import type {
  Connection,
  ConnectionCredential,
  ConnectionInput,
  ConnectionTestResult,
  CredentialPurpose,
  FieldError,
  GrantReport,
} from '@stashley/shared'
import { credentialPurposes, sameConnectionTarget } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import { writeTransaction } from '../../metastore/db.ts'
import type { ConnectionsTable, Database } from '../../metastore/schema.ts'
import { isoOrNull, systemClock, type Clock } from '../../platform/clock.ts'
import { decrypt, encrypt, type KeyRing } from '../../platform/crypto/keys.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import { TargetError } from '../../target/errors.ts'
import {
  type TargetPools,
  type TargetSession,
  type TargetSpec,
  type TargetUser,
} from '../../target/pools.ts'
import { isSupportedVersion, type ServerVersion } from '../../target/version.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import { inspectGrants } from './grants.ts'

export interface ConnectionsDeps {
  db: Kysely<Database>
  keys: KeyRing
  audit: AuditLog
  pools: TargetPools
  clock?: Clock
}

export interface ResolvedTarget {
  row: ConnectionsTable
  spec: TargetSpec
  users: Partial<Record<CredentialPurpose, TargetUser>>
  reports: Partial<Record<CredentialPurpose, GrantReport>>
}

function passwordAad(credentialId: string): string {
  return `connection_credentials:${credentialId}:password`
}

function specOf(input: ConnectionInput): TargetSpec {
  return {
    host: input.host,
    port: input.port,
    database: input.databaseName,
    tls: {
      mode: input.tls.mode,
      caPem: input.tls.caPem === '' ? null : input.tls.caPem,
      serverName: input.tls.serverName === '' ? null : input.tls.serverName,
    },
    queryTimeoutMs: input.queryTimeoutSeconds * 1000,
  }
}

/** A field error per database user that could not connect. */
function connectionFailed(errors: FieldError[]): AppError {
  return new AppError('connection_failed', { errors })
}

export class ConnectionsService {
  private readonly deps: ConnectionsDeps
  private readonly clock: Clock

  constructor(deps: ConnectionsDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  private validate(input: ConnectionInput): void {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone })
    } catch {
      throw fieldError('timezone', 'invalid')
    }
    const pem = input.tls.caPem
    if (pem !== null && pem !== '') {
      try {
        new X509Certificate(pem)
      } catch {
        throw fieldError('tls.caPem', 'invalid')
      }
    }
  }

  /**
   * Users for a test or save. An omitted password comes from the stored connection, but only
   * while the target is unchanged (`sameConnectionTarget`); otherwise it must be entered again.
   */
  private async usersFor(input: ConnectionInput, existingId: string | undefined) {
    const stored = existingId === undefined ? undefined : await this.resolve(existingId)
    const reusable = stored !== undefined && sameConnectionTarget(stored.spec, input)
    const users: Partial<Record<CredentialPurpose, TargetUser>> = {}
    const reused: CredentialPurpose[] = []
    const missing: FieldError[] = []
    for (const purpose of credentialPurposes) {
      const credential = input.credentials[purpose]
      if (credential === null) continue
      let password = credential.password
      if (password === undefined && reusable) {
        password = stored.users[purpose]?.password
        if (password !== undefined) reused.push(purpose)
      }
      if (password === undefined) {
        missing.push({ field: `credentials.${purpose}.password`, code: 'required' })
        continue
      }
      users[purpose] = { purpose, username: credential.username, password }
    }
    if (missing.length > 0) throw new AppError('validation_failed', { errors: missing })
    return { users, reused }
  }

  /** Connects with every user and reads its grants; fails if one cannot connect. */
  private async check(
    spec: TargetSpec,
    users: Partial<Record<CredentialPurpose, TargetUser>>,
  ): Promise<{ server: ServerVersion; reports: GrantReport[] }> {
    const errors: FieldError[] = []
    const reports: GrantReport[] = []
    let server: ServerVersion | undefined
    for (const purpose of credentialPurposes) {
      const user = users[purpose]
      if (user === undefined) continue
      try {
        const result = await this.deps.pools.once(spec, user, async (session) => ({
          server: session.server,
          report: await inspectGrants(session, purpose, spec.database),
        }))
        if (purpose === 'read') server = result.server
        reports.push(result.report)
      } catch (error) {
        if (!(error instanceof TargetError)) throw error
        errors.push({ field: `credentials.${purpose}`, code: error.failure })
      }
    }
    if (errors.length > 0 || server === undefined) throw connectionFailed(errors)
    return { server, reports }
  }

  /** Tests settings before they are saved. A test with stored passwords is audited. */
  async test(
    actor: Actor,
    input: ConnectionInput,
    existingId?: string,
  ): Promise<ConnectionTestResult> {
    this.validate(input)
    const { users, reused } = await this.usersFor(input, existingId)
    let outcome = 'failed'
    try {
      const { server, reports } = await this.check(specOf(input), users)
      outcome = 'succeeded'
      return {
        engine: server.engine,
        serverVersion: server.version,
        versionSupported: server.supported,
        grants: reports,
      }
    } finally {
      if (existingId !== undefined && reused.length > 0) {
        await this.deps.audit.record(actor, {
          action: 'connection.tested',
          subject: { kind: 'connection', id: existingId, label: input.name },
          connectionId: existingId,
          details: { host: input.host, port: input.port, storedPasswords: reused, outcome },
        })
      }
    }
  }

  async list(): Promise<Connection[]> {
    const rows = await this.deps.db.selectFrom('connections').select('id').orderBy('name').execute()
    return Promise.all(rows.map((row) => this.get(row.id)))
  }

  async get(id: string): Promise<Connection> {
    const db = this.deps.db
    const row = await db
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    const credentials = await db
      .selectFrom('connection_credentials')
      .select(['purpose', 'username', 'grant_report', 'checked_at'])
      .where('connection_id', '=', id)
      .execute()
    const snapshot = await db
      .selectFrom('schema_snapshots')
      .select('captured_at')
      .where('connection_id', '=', id)
      .orderBy('captured_at', 'desc')
      .limit(1)
      .executeTakeFirst()
    const drifts = await db
      .selectFrom('schema_drifts')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('connection_id', '=', id)
      .where('acknowledged_at', 'is', null)
      .executeTakeFirstOrThrow()
    const order = (purpose: CredentialPurpose) => credentialPurposes.indexOf(purpose)
    const tls = JSON.parse(row.tls) as Connection['tls']
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      databaseName: row.database_name,
      engine: row.engine,
      serverVersion: row.server_version,
      versionSupported:
        row.engine === null || row.server_version === null
          ? null
          : isSupportedVersion(row.engine, row.server_version),
      tls,
      timezone: row.timezone,
      queryTimeoutSeconds: row.query_timeout_ms / 1000,
      credentials: credentials
        .sort((a, b) => order(a.purpose) - order(b.purpose))
        .map((credential): ConnectionCredential => ({
          purpose: credential.purpose,
          username: credential.username,
          grants:
            credential.grant_report === null
              ? null
              : (JSON.parse(credential.grant_report) as GrantReport),
          checkedAt: isoOrNull(credential.checked_at),
        })),
      schemaCapturedAt: isoOrNull(snapshot?.captured_at ?? null),
      schemaCheck: {
        checkedAt: isoOrNull(row.schema_checked_at),
        failure: (row.schema_check_failure ?? null) as Connection['schemaCheck']['failure'],
      },
      openDrifts: Number(drifts.count),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  }

  private async ensureNameFree(name: string, id?: string): Promise<void> {
    let query = this.deps.db.selectFrom('connections').select('id').where('name', '=', name)
    if (id !== undefined) query = query.where('id', '!=', id)
    if ((await query.executeTakeFirst()) !== undefined) throw fieldError('name', 'taken')
  }

  private async saveCredentials(
    trx: Kysely<Database>,
    connectionId: string,
    users: Partial<Record<CredentialPurpose, TargetUser>>,
    reports: GrantReport[],
  ): Promise<void> {
    const now = this.clock()
    const existing = await trx
      .selectFrom('connection_credentials')
      .select(['id', 'purpose'])
      .where('connection_id', '=', connectionId)
      .execute()
    for (const purpose of credentialPurposes) {
      const user = users[purpose]
      const current = existing.find((credential) => credential.purpose === purpose)
      if (user === undefined) {
        if (current !== undefined) {
          await trx.deleteFrom('connection_credentials').where('id', '=', current.id).execute()
        }
        continue
      }
      const id = current?.id ?? uuidv7()
      const report = reports.find((entry) => entry.purpose === purpose)
      const values = {
        username: user.username,
        password: encrypt(this.deps.keys, user.password, passwordAad(id)),
        grant_report: report === undefined ? null : JSON.stringify(report),
        checked_at: report === undefined ? null : now,
      }
      if (current === undefined) {
        await trx
          .insertInto('connection_credentials')
          .values({ id, connection_id: connectionId, purpose, ...values })
          .execute()
      } else {
        await trx.updateTable('connection_credentials').set(values).where('id', '=', id).execute()
      }
    }
  }

  private usernames(input: ConnectionInput): Record<string, string | null> {
    return Object.fromEntries(
      credentialPurposes.map((purpose) => [purpose, input.credentials[purpose]?.username ?? null]),
    )
  }

  async create(actor: Actor, input: ConnectionInput): Promise<Connection> {
    this.validate(input)
    await this.ensureNameFree(input.name)
    const spec = specOf(input)
    const { users } = await this.usersFor(input, undefined)
    const { server, reports } = await this.check(spec, users)
    const id = uuidv7()
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .insertInto('connections')
        .values({
          id,
          name: input.name,
          host: input.host,
          port: input.port,
          database_name: input.databaseName,
          engine: server.engine,
          server_version: server.version,
          tls: JSON.stringify(spec.tls),
          timezone: input.timezone,
          query_timeout_ms: spec.queryTimeoutMs,
          created_at: now,
          updated_at: now,
          schema_checked_at: null,
          schema_check_failure: null,
        })
        .execute()
      await this.saveCredentials(trx, id, users, reports)
    })
    await this.deps.audit.record(actor, {
      action: 'connection.created',
      subject: { kind: 'connection', id, label: input.name },
      connectionId: id,
      details: {
        host: input.host,
        port: input.port,
        databaseName: input.databaseName,
        engine: server.engine,
        serverVersion: server.version,
        users: this.usernames(input),
        grantWarnings: reports.reduce((sum, report) => sum + report.warnings.length, 0),
      },
    })
    return this.get(id)
  }

  async update(actor: Actor, id: string, input: ConnectionInput): Promise<Connection> {
    this.validate(input)
    const before = await this.get(id)
    await this.ensureNameFree(input.name, id)
    const spec = specOf(input)
    const { users } = await this.usersFor(input, id)
    const { server, reports } = await this.check(spec, users)
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .updateTable('connections')
        .set({
          name: input.name,
          host: input.host,
          port: input.port,
          database_name: input.databaseName,
          engine: server.engine,
          server_version: server.version,
          tls: JSON.stringify(spec.tls),
          timezone: input.timezone,
          query_timeout_ms: spec.queryTimeoutMs,
          updated_at: this.clock(),
        })
        .where('id', '=', id)
        .execute()
      await this.saveCredentials(trx, id, users, reports)
    })
    await this.deps.pools.invalidate(id)
    const changes: Record<string, [unknown, unknown]> = {}
    const compare = (field: string, old: unknown, next: unknown) => {
      if (JSON.stringify(old) !== JSON.stringify(next)) changes[field] = [old, next]
    }
    compare('name', before.name, input.name)
    compare('host', before.host, input.host)
    compare('port', before.port, input.port)
    compare('databaseName', before.databaseName, input.databaseName)
    compare('tls.mode', before.tls.mode, spec.tls.mode)
    compare('tls.serverName', before.tls.serverName, spec.tls.serverName)
    if (before.tls.caPem !== spec.tls.caPem)
      changes['tls.caPem'] = ['…', spec.tls.caPem === null ? null : '…']
    compare('timezone', before.timezone, input.timezone)
    compare('queryTimeoutSeconds', before.queryTimeoutSeconds, input.queryTimeoutSeconds)
    for (const purpose of credentialPurposes) {
      const old = before.credentials.find((credential) => credential.purpose === purpose)
      const next = input.credentials[purpose]
      compare(`credentials.${purpose}.username`, old?.username ?? null, next?.username ?? null)
      if (next?.password !== undefined) changes[`credentials.${purpose}.password`] = ['***', '***']
    }
    if (Object.keys(changes).length > 0) {
      await this.deps.audit.record(actor, {
        action: 'connection.updated',
        subject: { kind: 'connection', id, label: input.name },
        connectionId: id,
        changes,
      })
    }
    return this.get(id)
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const connection = await this.get(id)
    const used = await this.deps.db
      .selectFrom('table_access')
      .select('id')
      .where('connection_id', '=', id)
      .executeTakeFirst()
    if (used !== undefined) throw new AppError('in_use')
    await this.deps.db.deleteFrom('connections').where('id', '=', id).execute()
    await this.deps.pools.invalidate(id)
    await this.deps.audit.record(actor, {
      action: 'connection.deleted',
      subject: { kind: 'connection', id, label: connection.name },
      connectionId: id,
    })
  }

  /** Reads the grants of every stored user again. */
  async recheckGrants(actor: Actor, id: string): Promise<Connection> {
    const target = await this.resolve(id)
    const { server, reports } = await this.check(target.spec, target.users)
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .updateTable('connections')
        .set({ engine: server.engine, server_version: server.version })
        .where('id', '=', id)
        .execute()
      await this.saveCredentials(trx, id, target.users, reports)
    })
    await this.deps.audit.record(actor, {
      action: 'connection.grants_checked',
      subject: { kind: 'connection', id, label: target.row.name },
      connectionId: id,
      details: {
        warnings: Object.fromEntries(
          reports.map((report) => [report.purpose, report.warnings.length]),
        ),
        missing: Object.fromEntries(reports.map((report) => [report.purpose, report.missing])),
      },
    })
    return this.get(id)
  }

  /** Stored settings with decrypted passwords; never leaves the server. */
  async resolve(id: string): Promise<ResolvedTarget> {
    const row = await this.deps.db
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    const credentials = await this.deps.db
      .selectFrom('connection_credentials')
      .selectAll()
      .where('connection_id', '=', id)
      .execute()
    const users: ResolvedTarget['users'] = {}
    const reports: ResolvedTarget['reports'] = {}
    for (const credential of credentials) {
      users[credential.purpose] = {
        purpose: credential.purpose,
        username: credential.username,
        password: decrypt(this.deps.keys, credential.password, passwordAad(credential.id)),
      }
      if (credential.grant_report !== null) {
        reports[credential.purpose] = JSON.parse(credential.grant_report) as GrantReport
      }
    }
    return {
      row,
      spec: {
        host: row.host,
        port: row.port,
        database: row.database_name,
        tls: JSON.parse(row.tls) as TargetSpec['tls'],
        queryTimeoutMs: row.query_timeout_ms,
      },
      users,
      reports,
    }
  }

  /** The stored grant reports and whether a write user exists; passwords stay encrypted. */
  async grantReports(id: string): Promise<{
    reports: ResolvedTarget['reports']
    hasWriter: boolean
  }> {
    const connection = await this.deps.db
      .selectFrom('connections')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (connection === undefined) throw new AppError('not_found')
    const credentials = await this.deps.db
      .selectFrom('connection_credentials')
      .select(['purpose', 'grant_report'])
      .where('connection_id', '=', id)
      .execute()
    const reports: ResolvedTarget['reports'] = {}
    for (const credential of credentials) {
      if (credential.grant_report !== null) {
        reports[credential.purpose] = JSON.parse(credential.grant_report) as GrantReport
      }
    }
    return { reports, hasWriter: credentials.some((entry) => entry.purpose === 'write') }
  }

  /** Runs `fn` on a pooled connection of the read user. */
  async withReader<T>(id: string, fn: (session: TargetSession) => Promise<T>): Promise<T> {
    const target = await this.resolve(id)
    const reader = target.users.read
    if (reader === undefined) throw new AppError('conflict')
    try {
      return await this.deps.pools.run(id, target.spec, reader, fn)
    } catch (error) {
      if (error instanceof TargetError) {
        throw connectionFailed([{ field: 'credentials.read', code: error.failure }])
      }
      throw error
    }
  }
}
