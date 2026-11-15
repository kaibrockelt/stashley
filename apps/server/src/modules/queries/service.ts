// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DesignCatalog,
  DesignConnection,
  FieldError,
  ImpactItem,
  ObjectAccess,
  Query,
  QueryAnalysis,
  QueryParameter,
  QueryResult,
  QuerySpec,
  QueryVersion,
  ResultColumn,
  SchemaDiff,
  queryCreate,
  queryTestRun,
  queryUpdate,
} from '@stashley/shared'
import { checkParamList, checkParamValue, isUserContextParam, toMask } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, QueriesTable, QueryVersionsTable } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { CatalogService } from '../catalog/service.ts'
import type { ConnectionsService } from '../connections/service.ts'
import type { ReadExecutor } from '../execution/executor.ts'
import { normalizeResult } from '../execution/results.ts'
import { ParameterError, resolveParameters } from '../execution/sql/parameters.ts'
import type { TableAccessService } from '../table-access/service.ts'
import type { VariablesService } from '../variables/service.ts'
import { BuilderError, compileSpec } from './builder/compile.ts'
import { buildStatement, type Executable } from './sql-guard/executable.ts'
import { SqlGuardError } from './sql-guard/lexer.ts'
import { guardSql, type GuardContext } from './sql-guard/validate.ts'

/** How long a version whose description failed waits before it is tried again. */
export const describeRetryMs = 10 * 60_000

export interface QueriesDeps {
  db: Kysely<Database>
  connections: ConnectionsService
  catalog: CatalogService
  tableAccess: TableAccessService
  variables: VariablesService
  executor: ReadExecutor
  audit: AuditLog
  events: EventBus
  clock?: Clock
}

/** Pages that use a query, for the editor and to refuse deleting a used query. */
export type QueryUsage = (queryId: string) => Promise<Query['usedBy']>

/** Rows of a test run in the SQL editor (§ SQL-Editor). */
export const testRunRows = 100

/** A stored query version, as execution and access control need it. */
export interface StoredVersion {
  queryId: string
  connectionId: string
  version: number
  cacheTtlSeconds: number
  parameters: QueryParameter[]
  analysis: QueryAnalysis
  executable: Executable
  /** Columns of the result, known after the version was described or run; for issues. */
  resultColumns: ResultColumn[] | null
}

type CreateInput = z.infer<typeof queryCreate>
type UpdateInput = z.infer<typeof queryUpdate>

/** SQL validation failures become field errors on `sql`. */
export function guardError(error: SqlGuardError): AppError {
  const params: Record<string, string | number> = {}
  if (error.detail !== undefined) params.detail = error.detail
  if (error.position !== undefined) params.position = error.position
  return new AppError('validation_failed', {
    errors: [
      {
        field: 'sql',
        code: error.code,
        ...(Object.keys(params).length > 0 && { params }),
      },
    ],
  })
}

/**
 * Checks the manager's parameter definitions against the names the SQL uses: every
 * selectable parameter needs exactly one definition; user context and instance variables
 * are set by the server and cannot be defined (§10.4).
 */
export function checkDefinitions(
  analysis: QueryAnalysis,
  definitions: readonly QueryParameter[],
  variables: ReadonlySet<string>,
): FieldError[] {
  const errors: FieldError[] = []
  const used = new Set(analysis.parameters)
  const seen = new Set<string>()
  definitions.forEach((definition, index) => {
    const field = `parameters.${index}`
    if (isUserContextParam(definition.name) || variables.has(definition.name)) {
      errors.push({ field: `${field}.name`, code: 'server_value' })
    } else if (seen.has(definition.name)) {
      errors.push({ field: `${field}.name`, code: 'duplicate' })
    } else if (!used.has(definition.name)) {
      errors.push({ field: `${field}.name`, code: 'unused' })
    }
    seen.add(definition.name)
    if (definition.defaultValue !== null) {
      const checked = definition.list
        ? checkParamList(definition.type, definition.defaultValue)
        : checkParamValue(definition.type, definition.defaultValue)
      if (!checked.ok) errors.push({ field: `${field}.defaultValue`, code: checked.code })
    }
  })
  for (const name of analysis.parameters) {
    if (isUserContextParam(name) || variables.has(name) || seen.has(name)) continue
    errors.push({ field: 'parameters', code: 'missing', params: { name } })
  }
  return errors
}

/** SQL text, or a builder spec to compile into it. */
export interface QuerySource {
  sql?: string | undefined
  builder?: QuerySpec | undefined
}

interface StoredBuilder {
  spec: QuerySpec
  notes: string[]
}

export class QueriesService {
  private readonly deps: QueriesDeps
  private readonly clock: Clock
  private usage: QueryUsage = () => Promise.resolve([])
  private readonly zoneTables = new Map<string, Promise<boolean>>()

  constructor(deps: QueriesDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    deps.events.on('connection.changed', ({ connectionId }) => this.zoneTables.delete(connectionId))
    deps.variables.addUsage(async (name) => {
      const rows = await deps.db
        .selectFrom('query_versions')
        .innerJoin('queries', (join) =>
          join
            .onRef('queries.id', '=', 'query_versions.query_id')
            .onRef('queries.latest_version', '=', 'query_versions.version'),
        )
        .select('query_versions.analysis')
        .execute()
      return rows.some((row) =>
        (JSON.parse(row.analysis) as QueryAnalysis).variables.includes(name),
      )
    })
    deps.catalog.addImpactProvider((connectionId, diff) => this.impact(connectionId, diff))
  }

  setUsage(usage: QueryUsage): void {
    this.usage = usage
  }

  /** What stored SQL of a connection is validated against: catalog, table access, variables. */
  async guardContext(connectionId: string): Promise<GuardContext> {
    const connection = await this.deps.connections.get(connectionId)
    const snapshot = await this.deps.catalog.current(connectionId)
    if (snapshot === undefined) throw fieldError('connectionId', 'schema_missing')
    const accesses = await this.deps.tableAccess.list(connectionId)
    const byName = new Map<string, ObjectAccess>(
      accesses.map((access) => [
        access.objectName,
        {
          ceiling: toMask(access.ops),
          excluded: new Set(
            access.exclusions.filter((entry) => entry.scope === 'all').map((entry) => entry.column),
          ),
          active: access.state === 'active',
        },
      ]),
    )
    return {
      engine: connection.engine ?? 'mysql',
      database: connection.databaseName,
      catalog: new Map(snapshot.objects.map((object) => [object.name, object])),
      access: (name) => byName.get(name),
      variables: new Set((await this.deps.variables.current()).keys()),
    }
  }

  /** Whether the server can convert time zones; then TIMESTAMP buckets follow the connection. */
  private timeZoneTables(connectionId: string): Promise<boolean> {
    let probe = this.zoneTables.get(connectionId)
    if (probe === undefined) {
      probe = this.deps.executor.target(connectionId).then(async (target) => {
        const result = await this.deps.executor.execute(connectionId, {
          sql: "SELECT CONVERT_TZ('2000-01-01 00:00:00', '+00:00', ?) IS NOT NULL AS ok",
          values: [target.timeZone],
        })
        return Number(result.rows[0]?.[0] ?? 0) === 1
      })
      probe.catch(() => this.zoneTables.delete(connectionId))
      this.zoneTables.set(connectionId, probe)
    }
    return probe
  }

  /** The SQL text of a source; a builder spec is compiled first (§10.3). */
  async toSql(
    connectionId: string,
    source: QuerySource,
    definitions: readonly QueryParameter[] = [],
  ): Promise<{ sql: string; builder: StoredBuilder | null }> {
    if (source.builder === undefined) return { sql: source.sql ?? '', builder: null }
    const spec = source.builder
    const snapshot = await this.deps.catalog.current(connectionId)
    if (snapshot === undefined) throw fieldError('connectionId', 'schema_missing')
    const catalog = new Map(snapshot.objects.map((object) => [object.name, object]))
    const connection = await this.deps.connections.get(connectionId)
    const sourceObject = (alias: string) =>
      alias === 'base' ? spec.base : spec.joins.find((join) => join.alias === alias)?.target
    const needsZones = spec.columns.some((column) => {
      if (column.bucket === undefined || column.column === null) return false
      const object = catalog.get(sourceObject(column.source) ?? '')
      return object?.columns.some(
        (entry) => entry.name === column.column && entry.kind === 'timestamp',
      )
    })
    const relations = (await this.deps.tableAccess.relations(connectionId)).map((relation) => ({
      sourceObject: relation.sourceObject,
      sourceColumn: relation.sourceColumn,
      targetObject: relation.targetObject,
      targetColumn: relation.targetColumn,
    }))
    try {
      const compiled = compileSpec(spec, {
        catalog,
        relations,
        timeZone: connection.timezone,
        timeZoneTables: needsZones ? await this.timeZoneTables(connectionId) : true,
        parameterLists: new Map(
          definitions.map((definition) => [definition.name, definition.list]),
        ),
      })
      return { sql: compiled.sql, builder: { spec, notes: compiled.notes } }
    } catch (error) {
      if (error instanceof BuilderError)
        throw new AppError('validation_failed', { errors: error.errors })
      throw error
    }
  }

  /** Validates SQL and parameter definitions; throws field errors. */
  async validate(
    connectionId: string,
    sql: string,
    definitions: readonly QueryParameter[],
  ): Promise<{ analysis: QueryAnalysis; executable: Executable }> {
    const ctx = await this.guardContext(connectionId)
    let guarded
    try {
      guarded = guardSql(sql, ctx)
    } catch (error) {
      if (error instanceof SqlGuardError) throw guardError(error)
      throw error
    }
    const errors = checkDefinitions(guarded.analysis, definitions, ctx.variables)
    if (errors.length > 0) throw new AppError('validation_failed', { errors })
    return {
      analysis: guarded.analysis,
      executable: { segments: guarded.segments, params: guarded.params, limit: guarded.limit },
    }
  }

  private async row(id: string): Promise<QueriesTable> {
    const row = await this.deps.db
      .selectFrom('queries')
      .selectAll()
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    return row
  }

  private async versionRow(id: string, version: number): Promise<QueryVersionsTable> {
    const row = await this.deps.db
      .selectFrom('query_versions')
      .selectAll()
      .where('query_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    return row
  }

  private toVersion(row: QueryVersionsTable, createdBy: string | null): QueryVersion {
    return {
      version: row.version,
      sql: row.sql_text,
      parameters: JSON.parse(row.parameters) as QueryParameter[],
      analysis: JSON.parse(row.analysis) as QueryAnalysis,
      resultColumns:
        row.result_columns === null ? null : (JSON.parse(row.result_columns) as ResultColumn[]),
      createdAt: new Date(row.created_at).toISOString(),
      createdBy,
    }
  }

  private async email(userId: string | null): Promise<string | null> {
    if (userId === null) return null
    const user = await this.deps.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirst()
    return user?.email ?? null
  }

  async get(id: string): Promise<Query> {
    const row = await this.row(id)
    const version = await this.versionRow(id, row.latest_version)
    return {
      id: row.id,
      connectionId: row.connection_id,
      name: row.name,
      description: row.description,
      mode: row.mode,
      cacheTtlSeconds: row.cache_ttl_seconds,
      latestVersion: row.latest_version,
      current: this.toVersion(version, await this.email(version.created_by)),
      builder:
        version.builder_spec === null ? null : (JSON.parse(version.builder_spec) as StoredBuilder),
      usedBy: await this.usage(id),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  }

  async list(connectionId?: string): Promise<Omit<Query, 'current' | 'usedBy' | 'builder'>[]> {
    let query = this.deps.db.selectFrom('queries').selectAll().where('archived_at', 'is', null)
    if (connectionId !== undefined) query = query.where('connection_id', '=', connectionId)
    const rows = await query.orderBy('name').execute()
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      name: row.name,
      description: row.description,
      mode: row.mode,
      cacheTtlSeconds: row.cache_ttl_seconds,
      latestVersion: row.latest_version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }))
  }

  async versions(id: string): Promise<QueryVersion[]> {
    await this.row(id)
    const rows = await this.deps.db
      .selectFrom('query_versions')
      .leftJoin('users', 'users.id', 'query_versions.created_by')
      .selectAll('query_versions')
      .select('users.email')
      .where('query_id', '=', id)
      .orderBy('version', 'desc')
      .execute()
    return rows.map((row) => this.toVersion(row, row.email ?? null))
  }

  /** A version for execution; the latest when `version` is undefined (drafts). */
  async stored(id: string, version?: number): Promise<StoredVersion | undefined> {
    const query = await this.deps.db
      .selectFrom('queries')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (query === undefined) return undefined
    const row = await this.deps.db
      .selectFrom('query_versions')
      .selectAll()
      .where('query_id', '=', id)
      .where('version', '=', version ?? query.latest_version)
      .executeTakeFirst()
    if (row === undefined) return undefined
    return {
      queryId: id,
      connectionId: query.connection_id,
      version: row.version,
      cacheTtlSeconds: query.cache_ttl_seconds,
      parameters: JSON.parse(row.parameters) as QueryParameter[],
      analysis: JSON.parse(row.analysis) as QueryAnalysis,
      executable: JSON.parse(row.executable) as Executable,
      resultColumns: this.resultColumns(id, row),
    }
  }

  /** Runs in flight, so concurrent callers share one, and when a version last failed. */
  private readonly describing = new Map<string, Promise<ResultColumn[] | null>>()
  private readonly failed = new Map<string, number>()

  /** Stored result columns; a version without them is described in the background. */
  private resultColumns(id: string, row: QueryVersionsTable): ResultColumn[] | null {
    if (row.result_columns !== null) return JSON.parse(row.result_columns) as ResultColumn[]
    void this.describe(id, row.version).catch(() => undefined)
    return null
  }

  /**
   * Learns the result columns of a version (§10.8) by running it for one row with every
   * parameter unset, and stores them. Concurrent calls share one run. A failing run leaves
   * them unknown and is tried again after `describeRetryMs`. Returns the columns, or null.
   */
  describe(id: string, version: number): Promise<ResultColumn[] | null> {
    const key = `${id}:${version}`
    const running = this.describing.get(key)
    if (running !== undefined) return running
    const failedAt = this.failed.get(key)
    if (failedAt !== undefined && this.clock() - failedAt < describeRetryMs) {
      return Promise.resolve(null)
    }
    const run = this.runDescribe(id, version)
      .then((columns) => {
        if (columns === null) this.failed.set(key, this.clock())
        else this.failed.delete(key)
        return columns
      })
      .finally(() => this.describing.delete(key))
    this.describing.set(key, run)
    return run
  }

  private async runDescribe(id: string, version: number): Promise<ResultColumn[] | null> {
    const query = await this.deps.db
      .selectFrom('queries')
      .select('connection_id')
      .where('id', '=', id)
      .executeTakeFirst()
    const row = await this.deps.db
      .selectFrom('query_versions')
      .selectAll()
      .where('query_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirst()
    if (query === undefined || row === undefined) return null
    if (row.result_columns !== null) return JSON.parse(row.result_columns) as ResultColumn[]
    const executable = JSON.parse(row.executable) as Executable
    const lists = new Set(
      (JSON.parse(row.parameters) as QueryParameter[])
        .filter((parameter) => parameter.list)
        .map((parameter) => parameter.name),
    )
    const values = new Map(executable.params.map((name) => [name, lists.has(name) ? [] : null]))
    try {
      const raw = await this.deps.executor.execute(
        query.connection_id,
        buildStatement(executable, values, 1),
      )
      const { columns } = normalizeResult(raw.rows, raw.fields, 1, raw.timeZone)
      await this.storeColumns(id, version, columns)
      return columns
    } catch {
      return null
    }
  }

  private async storeColumns(id: string, version: number, columns: ResultColumn[]) {
    const result = await this.deps.db
      .updateTable('query_versions')
      .set({ result_columns: JSON.stringify(columns) })
      .where('query_id', '=', id)
      .where('version', '=', version)
      .where('result_columns', 'is', null)
      .executeTakeFirst()
    // Compiled pages checked their settings without these columns.
    if (Number(result.numUpdatedRows) > 0) this.deps.events.emit('query.described', { queryId: id })
  }

  /**
   * A test run of exactly the SQL and parameters of a version without known columns teaches
   * them, e.g. when the run with unset parameters failed (§10.8).
   */
  private async learnFromRun(
    connectionId: string,
    sql: string,
    parameters: readonly QueryParameter[],
    columns: ResultColumn[],
  ) {
    const versions = await this.deps.db
      .selectFrom('query_versions')
      .innerJoin('queries', 'queries.id', 'query_versions.query_id')
      .select(['query_versions.query_id', 'query_versions.version'])
      .where('queries.connection_id', '=', connectionId)
      .where('query_versions.result_columns', 'is', null)
      .where('query_versions.sql_text', '=', sql)
      .where('query_versions.parameters', '=', JSON.stringify(parameters))
      .execute()
    for (const entry of versions) await this.storeColumns(entry.query_id, entry.version, columns)
  }

  /** Connections for the query editor; managers see names only. */
  async designConnections(): Promise<DesignConnection[]> {
    return (await this.deps.connections.list()).map((connection) => ({
      id: connection.id,
      name: connection.name,
      engine: connection.engine,
    }))
  }

  /**
   * Exposed objects and their columns for the builder and the SQL editor's completion. Only
   * objects whose ceiling allows reading appear, without columns excluded for everyone.
   */
  async designCatalog(connectionId: string): Promise<DesignCatalog> {
    await this.deps.connections.get(connectionId)
    const snapshot = await this.deps.catalog.current(connectionId)
    const accesses = (await this.deps.tableAccess.list(connectionId)).filter((access) =>
      access.ops.includes('read'),
    )
    const catalog = new Map((snapshot?.objects ?? []).map((object) => [object.name, object]))
    const objects: DesignCatalog['objects'] = []
    const visible = new Map<string, Set<string>>()
    for (const access of accesses) {
      const object = catalog.get(access.objectName)
      if (object === undefined) continue
      const excluded = new Set(
        access.exclusions.filter((entry) => entry.scope === 'all').map((entry) => entry.column),
      )
      const key = new Set(access.keyColumn === null ? object.primaryKey : [access.keyColumn])
      const columns = object.columns
        .filter((column) => !excluded.has(column.name))
        .map((column) => ({
          name: column.name,
          kind: column.kind,
          nullable: column.nullable,
          key: key.has(column.name),
        }))
      visible.set(object.name, new Set(columns.map((column) => column.name)))
      objects.push({
        tableAccessId: access.id,
        name: object.name,
        type: object.type,
        keyColumn:
          access.keyColumn ??
          (object.primaryKey.length === 1 ? (object.primaryKey[0] ?? null) : null),
        ceiling: access.ops,
        columns,
      })
    }
    const relations = (await this.deps.tableAccess.relations(connectionId))
      .filter(
        (relation) =>
          visible.get(relation.sourceObject)?.has(relation.sourceColumn) === true &&
          visible.get(relation.targetObject)?.has(relation.targetColumn) === true,
      )
      .map(({ sourceObject, sourceColumn, targetObject, targetColumn, kind }) => ({
        sourceObject,
        sourceColumn,
        targetObject,
        targetColumn,
        kind,
      }))
    return { connectionId, objects, relations }
  }

  private async ensureNameFree(name: string, id?: string): Promise<void> {
    let query = this.deps.db.selectFrom('queries').select('id').where('name', '=', name)
    if (id !== undefined) query = query.where('id', '!=', id)
    if ((await query.executeTakeFirst()) !== undefined) throw fieldError('name', 'taken')
  }

  async create(actor: Actor, input: CreateInput): Promise<Query> {
    await this.ensureNameFree(input.name)
    const { sql, builder } = await this.toSql(input.connectionId, input, input.parameters)
    const { analysis, executable } = await this.validate(input.connectionId, sql, input.parameters)
    const id = uuidv7()
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .insertInto('queries')
        .values({
          id,
          connection_id: input.connectionId,
          name: input.name,
          description: input.description,
          mode: builder === null ? 'sql' : 'builder',
          cache_ttl_seconds: input.cacheTtlSeconds,
          latest_version: 1,
          created_by: actor.id,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })
        .execute()
      await trx
        .insertInto('query_versions')
        .values({
          query_id: id,
          version: 1,
          sql_text: sql,
          builder_spec: builder === null ? null : JSON.stringify(builder),
          parameters: JSON.stringify(input.parameters),
          analysis: JSON.stringify(analysis),
          executable: JSON.stringify(executable),
          result_columns: null,
          created_by: actor.id,
          created_at: now,
        })
        .execute()
    })
    await this.deps.audit.record(actor, {
      action: 'query.created',
      subject: { kind: 'query', id, label: input.name },
      connectionId: input.connectionId,
      details: { version: 1, objects: analysis.objects, cacheTtlSeconds: input.cacheTtlSeconds },
    })
    this.deps.events.emit('query.changed', { queryId: id })
    return this.get(id)
  }

  /**
   * Name, description and cache duration belong to the query; changed SQL or parameters
   * create a new immutable version, which reaches users when a page is published again.
   */
  async update(actor: Actor, id: string, input: UpdateInput): Promise<Query> {
    const row = await this.row(id)
    const current = await this.versionRow(id, row.latest_version)
    if (input.name !== undefined) await this.ensureNameFree(input.name, id)
    if (row.mode === 'sql' && input.builder !== undefined) {
      throw fieldError('builder', 'not_allowed')
    }
    const storedBuilder =
      current.builder_spec === null ? null : (JSON.parse(current.builder_spec) as StoredBuilder)
    // New SQL text converts a builder query; a new spec recompiles it.
    const source: QuerySource =
      input.sql !== undefined
        ? { sql: input.sql }
        : input.builder !== undefined
          ? { builder: input.builder }
          : storedBuilder === null
            ? { sql: current.sql_text }
            : { builder: storedBuilder.spec }
    const parameters = input.parameters ?? (JSON.parse(current.parameters) as QueryParameter[])
    const { sql, builder } =
      input.sql === undefined && input.builder === undefined
        ? { sql: current.sql_text, builder: storedBuilder }
        : await this.toSql(row.connection_id, source, parameters)
    const mode = builder === null ? 'sql' : 'builder'
    const builderText = builder === null ? null : JSON.stringify(builder)
    const versioned =
      sql !== current.sql_text ||
      JSON.stringify(parameters) !== current.parameters ||
      builderText !== current.builder_spec
    const changes: Record<string, [unknown, unknown]> = {}
    for (const [key, before, after] of [
      ['name', row.name, input.name],
      ['description', row.description, input.description],
      ['cacheTtlSeconds', row.cache_ttl_seconds, input.cacheTtlSeconds],
      ['mode', row.mode, mode],
    ] as const) {
      if (after !== undefined && after !== before) changes[key] = [before, after]
    }
    let version = row.latest_version
    let validated: { analysis: QueryAnalysis; executable: Executable } | undefined
    if (versioned) {
      validated = await this.validate(row.connection_id, sql, parameters)
      version += 1
      changes.version = [row.latest_version, version]
    }
    if (Object.keys(changes).length === 0) return this.get(id)
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      if (validated !== undefined) {
        await trx
          .insertInto('query_versions')
          .values({
            query_id: id,
            version,
            sql_text: sql,
            builder_spec: builderText,
            parameters: JSON.stringify(parameters),
            analysis: JSON.stringify(validated.analysis),
            executable: JSON.stringify(validated.executable),
            result_columns: null,
            created_by: actor.id,
            created_at: now,
          })
          .execute()
      }
      await trx
        .updateTable('queries')
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.cacheTtlSeconds !== undefined && { cache_ttl_seconds: input.cacheTtlSeconds }),
          mode,
          latest_version: version,
          updated_at: now,
        })
        .where('id', '=', id)
        .execute()
    })
    await this.deps.audit.record(actor, {
      action: 'query.updated',
      subject: { kind: 'query', id, label: input.name ?? row.name },
      connectionId: row.connection_id,
      changes,
    })
    this.deps.events.emit('query.changed', { queryId: id })
    return this.get(id)
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const row = await this.row(id)
    if ((await this.usage(id)).length > 0) throw new AppError('in_use')
    await this.deps.db.deleteFrom('queries').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'query.deleted',
      subject: { kind: 'query', id, label: row.name },
      connectionId: row.connection_id,
    })
    this.deps.events.emit('query.changed', { queryId: id })
  }

  /**
   * Runs unsaved SQL with test values and returns the first 100 rows (§ SQL-Editor). Test
   * values may stand in for instance variables; the user context is always the caller.
   */
  async testRun(
    user: { id: string; email: string },
    input: z.infer<typeof queryTestRun>,
  ): Promise<QueryResult & { durationMs: number }> {
    const { sql } = await this.toSql(input.connectionId, input, input.parameters)
    const { analysis, executable } = await this.validate(input.connectionId, sql, input.parameters)
    const target = await this.deps.executor.target(input.connectionId)
    let resolved
    try {
      resolved = resolveParameters({
        names: analysis.parameters,
        definitions: input.parameters,
        user,
        variables: await this.deps.variables.current(),
        input: input.values,
        overrideVariables: true,
        timeZone: target.timeZone,
      })
    } catch (error) {
      if (error instanceof ParameterError) {
        throw new AppError('validation_failed', { errors: error.errors })
      }
      throw error
    }
    const statement = buildStatement(executable, resolved.values, testRunRows + 1)
    const raw = await this.deps.executor.execute(input.connectionId, statement)
    const result = normalizeResult(raw.rows, raw.fields, testRunRows, raw.timeZone)
    await this.learnFromRun(input.connectionId, sql, input.parameters, result.columns)
    return {
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      ...(result.invalidRows !== undefined && { invalidRows: result.invalidRows }),
      durationMs: Math.round(raw.durationMs),
    }
  }

  /** Queries of a connection whose latest version uses a removed or changed object (§9.3). */
  private async impact(connectionId: string, diff: SchemaDiff): Promise<ImpactItem[]> {
    const rows = await this.deps.db
      .selectFrom('queries')
      .innerJoin('query_versions', (join) =>
        join
          .onRef('query_versions.query_id', '=', 'queries.id')
          .onRef('query_versions.version', '=', 'queries.latest_version'),
      )
      .select(['queries.id', 'queries.name', 'query_versions.analysis'])
      .where('queries.connection_id', '=', connectionId)
      .where('queries.archived_at', 'is', null)
      .execute()
    const removed = new Set(diff.removedObjects)
    const items: ImpactItem[] = []
    for (const row of rows) {
      const analysis = JSON.parse(row.analysis) as QueryAnalysis
      const item = (reason: ImpactItem['reason']) =>
        items.push({ kind: 'query', id: row.id, label: row.name, reason })
      if (analysis.objects.some((object) => removed.has(object))) {
        item('object_removed')
        continue
      }
      const used = (object: string, column: string) =>
        analysis.columns.some(
          (entry) => entry.object === object && entry.column.toLowerCase() === column.toLowerCase(),
        )
      for (const change of diff.changedObjects) {
        if (!analysis.objects.includes(change.object)) continue
        if (change.typeChanged !== undefined) item('type_changed')
        else if (change.removedColumns.some((column) => used(change.object, column))) {
          item('column_removed')
        } else if (
          change.changedColumns.some((entry) => used(change.object, entry.column)) ||
          (analysis.stars.includes(change.object) &&
            change.addedColumns.length + change.removedColumns.length > 0)
        ) {
          item('column_changed')
        } else continue
        break
      }
    }
    return items
  }
}
