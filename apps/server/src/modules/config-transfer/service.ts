// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import {
  checkParamValue,
  configFile,
  configFormat,
  configFormatVersion,
  type ConfigFile,
  type ConfigImportItem,
  type ConfigImportPlan,
  type PageDocument,
  type QueryAnalysis,
} from '@stashley/shared'
import { type Kysely, sql } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { parse } from '../../platform/http/validation.ts'
import type { CompileDeps } from '../access/compile.ts'
import type { AccessService } from '../access/service.ts'
import type { ConnectionFacts } from '../access/facts.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { ModelRelation } from '../execution/sql/table-model.ts'
import { keptVersions } from '../pages/service.ts'
import type { Executable } from '../queries/sql-guard/executable.ts'
import type { QueriesService, StoredVersion } from '../queries/service.ts'
import type { TableAccessService } from '../table-access/service.ts'
import type { VariablesService } from '../variables/service.ts'

export interface ConfigTransferDeps {
  db: Kysely<Database>
  audit: AuditLog
  events: EventBus
  tableAccess: TableAccessService
  /** Access facts and checks, for the imported pages as they will be on this instance. */
  facts: CompileDeps['facts']
  access: Pick<AccessService, 'checkWith'>
  queries: QueriesService
  variables: VariablesService
  appVersion: string
  clock?: Clock
}

export interface ImportInput {
  file: unknown
  connections: Record<string, string>
}

type Item = ConfigImportItem & {
  write?: (trx: Kysely<Database>) => Promise<void>
  /** What the item met on this instance; part of the fingerprint, so changes since count. */
  state?: unknown
  /** Old and new values for the audit event. */
  change?: Record<string, unknown>
}

/** A row changed since the plan read it; the import stops and asks for a new preview. */
class Outdated extends Error {}

function guard(result: { numUpdatedRows: bigint }): void {
  if (Number(result.numUpdatedRows) === 0) throw new Outdated()
}

const isConstraintError = (error: unknown) =>
  typeof (error as { code?: unknown }).code === 'string' &&
  (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')

/** The next free position, read in the import's transaction. */
async function nextPosition(
  trx: Kysely<Database>,
  table: 'sections' | 'pages' | 'roles',
): Promise<number> {
  const result = await sql<{
    next: number
  }>`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${sql.table(table)}`.execute(trx)
  return result.rows[0]?.next ?? 0
}

/** Keys that occur more than once. */
function repeated<T>(entries: readonly T[], keyOf: (entry: T) => string): Set<string> {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const entry of entries) {
    const key = keyOf(entry)
    if (seen.has(key)) twice.add(key)
    seen.add(key)
  }
  return twice
}

/**
 * Page issues that mean the target's schema or table access does not fit the page: a column
 * or relation is missing or hidden there. They block the import; other issues are shown.
 */
const schemaIssueCodes = new Set([
  'unknown_column',
  'excluded_column',
  'unsupported_column',
  'unknown_relation',
  'relation_ambiguous',
  'template_unknown_relation',
  'object_not_readable',
  'object_not_exposed',
])

/**
 * Access facts as they will be after the import: relations and display templates of the file
 * added to those of the target.
 */
function pendingFacts(
  base: CompileDeps['facts'],
  relations: ReadonlyMap<string, ModelRelation[]>,
  templates: ReadonlyMap<string, ReadonlyMap<string, string>>,
): CompileDeps['facts'] {
  const views = new Map<string, ConnectionFacts>()
  const view = (connection: ConnectionFacts): ConnectionFacts => {
    let result = views.get(connection.connectionId)
    if (result === undefined) {
      const own = templates.get(connection.connectionId)
      const objects = new Map(
        [...connection.objects].map(([name, object]) => {
          const template = own?.get(name)
          return [
            name,
            template === undefined ? object : { ...object, effectiveTemplate: template },
          ]
        }),
      )
      result = {
        ...connection,
        relations: [...connection.relations, ...(relations.get(connection.connectionId) ?? [])],
        objects,
        access: (name) => objects.get(name),
      }
      views.set(connection.connectionId, result)
    }
    return result
  }
  return {
    connection: async (connectionId) => view(await base.connection(connectionId)),
    table: async (tableAccessId) => {
      const found = await base.table(tableAccessId)
      if (found === undefined) return undefined
      const connection = view(found.connection)
      const object = connection.objects.get(found.object.objectName)
      return object === undefined ? undefined : { connection, object }
    },
  }
}

/** The column or object name at a document path, e.g. `table.table.columns.0.column`. */
function nameAt(document: unknown, path: string): string | undefined {
  let value = document
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['column', 'target', 'name']) {
    if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

/** Pages a document links to, e.g. "open a page after saving". */
function pageRefsOf(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) pageRefsOf(entry, refs)
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.action === 'navigate' && typeof record.pageId === 'string') refs.push(record.pageId)
    for (const entry of Object.values(record)) pageRefsOf(entry, refs)
  }
  return refs
}

const tableRefPattern = /^table:([0-9a-f-]{36})$/

/**
 * Rewrites the table access IDs of a page document: `tableAccessId` of table sources and the
 * `table:<id>` source keys of grants (§13.1). Everything else stays as it is.
 */
function mapTableIds(value: unknown, map: (id: string) => string): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapTableIds(entry, map))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === 'tableAccessId' && typeof entry === 'string') return [key, map(entry)]
      if (key === 'source' && typeof entry === 'string') {
        const match = tableRefPattern.exec(entry)
        if (match?.[1] !== undefined) return [key, `table:${map(match[1])}`]
      }
      return [key, mapTableIds(entry, map)]
    }),
  )
}

/** Every query a page document uses, with the pinned version where there is one. */
function queryRefsOf(value: unknown, refs: { queryId: string; version?: number }[] = []) {
  if (Array.isArray(value)) for (const entry of value) queryRefsOf(entry, refs)
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.kind === 'query' && typeof record.queryId === 'string') {
      refs.push({
        queryId: record.queryId,
        ...(typeof record.version === 'number' && { version: record.version }),
      })
    }
    for (const entry of Object.values(record)) queryRefsOf(entry, refs)
  }
  return refs
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function conflictOf(error: unknown): string {
  if (error instanceof AppError) return error.errors?.[0]?.code ?? error.code
  throw error
}

/**
 * Configuration export and import (§24). The import is planned first: every item of the file
 * is compared with the target and marked new, changed, unchanged or in conflict. Conflicts
 * block it; they are resolved by hand on either instance. The import then writes everything
 * in one metadata store transaction.
 */
export class ConfigTransferService {
  private readonly deps: ConfigTransferDeps
  private readonly clock: Clock

  constructor(deps: ConfigTransferDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  async export(actor: Actor): Promise<ConfigFile> {
    const db = this.deps.db
    const connections = await db.selectFrom('connections').select(['id', 'name']).execute()
    const connectionName = new Map(connections.map((row) => [row.id, row.name]))
    const used = new Set<string>()
    const ref = (connectionId: string) => {
      used.add(connectionId)
      return connectionName.get(connectionId) ?? connectionId
    }
    const accesses = await db
      .selectFrom('table_access')
      .select(['id', 'connection_id', 'object_name', 'display_template'])
      .orderBy('object_name')
      .execute()
    const accessById = new Map(accesses.map((row) => [row.id, row]))

    const pageRows = await db
      .selectFrom('pages')
      .selectAll()
      .where('archived_at', 'is', null)
      .orderBy('position')
      .execute()
    const versions = await db.selectFrom('page_versions').selectAll().execute()
    const tableIds = new Set<string>()
    const collect = (document: unknown) =>
      mapTableIds(document, (id) => {
        tableIds.add(id)
        return id
      })
    const pages = pageRows.map((row) => {
      const draft = JSON.parse(row.draft) as PageDocument
      const publishedRow = versions.find(
        (version) => version.page_id === row.id && version.version === row.published_version,
      )
      const published =
        publishedRow === undefined ? null : (JSON.parse(publishedRow.document) as PageDocument)
      collect(draft)
      collect(published)
      return { id: row.id, sectionId: row.section_id, slug: row.slug, draft, published }
    })

    // Queries carry their latest version and every version a published page pins.
    const pinned = new Map<string, Set<number>>()
    for (const page of pages) {
      for (const queryRef of queryRefsOf(page.published)) {
        if (queryRef.version === undefined) continue
        const set = pinned.get(queryRef.queryId) ?? new Set<number>()
        set.add(queryRef.version)
        pinned.set(queryRef.queryId, set)
      }
    }
    const queryRows = await db
      .selectFrom('queries')
      .selectAll()
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute()
    const queries = []
    for (const row of queryRows) {
      const wanted = [...new Set([row.latest_version, ...(pinned.get(row.id) ?? [])])]
      const versionRows = await db
        .selectFrom('query_versions')
        .selectAll()
        .where('query_id', '=', row.id)
        .where('version', 'in', wanted)
        .orderBy('version')
        .execute()
      queries.push({
        id: row.id,
        connectionRef: ref(row.connection_id),
        name: row.name,
        description: row.description,
        cacheTtlSeconds: row.cache_ttl_seconds,
        versions: versionRows.map((version) => ({
          version: version.version,
          sql: version.sql_text,
          builder:
            version.builder_spec === null
              ? null
              : (JSON.parse(
                  version.builder_spec,
                ) as ConfigFile['queries'][number]['versions'][number]['builder']),
          parameters: JSON.parse(
            version.parameters,
          ) as ConfigFile['queries'][number]['versions'][number]['parameters'],
        })),
      })
    }

    const tables = [...tableIds].flatMap((id) => {
      const access = accessById.get(id)
      return access === undefined
        ? []
        : [{ id, connectionRef: ref(access.connection_id), object: access.object_name }]
    })
    const displayTemplates = accesses.flatMap((access) =>
      access.display_template === null
        ? []
        : [
            {
              connectionRef: ref(access.connection_id),
              object: access.object_name,
              template: access.display_template,
            },
          ],
    )
    const relations = (
      await db.selectFrom('virtual_relations').selectAll().orderBy('created_at').execute()
    ).map((row) => ({
      connectionRef: ref(row.connection_id),
      sourceObject: row.source_object,
      sourceColumn: row.source_column,
      targetObject: row.target_object,
      targetColumn: row.target_column,
      kind: row.kind,
    }))
    const pageIds = new Set(pages.map((page) => page.id))
    const roles = (await db.selectFrom('roles').selectAll().orderBy('position').execute()).map(
      (row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        homePageId:
          row.home_page_id !== null && pageIds.has(row.home_page_id) ? row.home_page_id : null,
      }),
    )
    const variables = (
      await db.selectFrom('instance_variables').selectAll().orderBy('name').execute()
    ).map((row) => ({
      name: row.name,
      type: row.type,
      value: JSON.parse(row.value) as string | number | boolean,
      description: row.description,
    }))
    const sections = (
      await db.selectFrom('sections').select(['id', 'name']).orderBy('position').execute()
    ).map((row) => ({ id: row.id, name: row.name }))

    const file: ConfigFile = {
      format: configFormat,
      formatVersion: configFormatVersion,
      appVersion: this.deps.appVersion,
      exportedAt: new Date(this.clock()).toISOString(),
      connections: [...used].map((id) => ({ ref: connectionName.get(id) ?? id })),
      tables,
      roles,
      variables,
      relations,
      displayTemplates,
      queries,
      sections,
      pages,
    }
    await this.deps.audit.record(actor, {
      action: 'config.exported',
      details: {
        roles: roles.length,
        queries: queries.length,
        sections: sections.length,
        pages: pages.length,
      },
    })
    return file
  }

  /** Compares the file with this instance without writing anything. */
  async preview(input: ImportInput): Promise<ConfigImportPlan> {
    return (await this.plan(input)).plan
  }

  async apply(
    actor: Actor,
    input: ImportInput & { fingerprint: string },
  ): Promise<ConfigImportPlan> {
    const { plan, items, file, hash, after } = await this.plan(input)
    if (plan.fingerprint !== input.fingerprint) {
      throw new AppError('conflict', { detail: 'preview_outdated' })
    }
    if (plan.counts.conflict > 0) throw new AppError('conflict', { detail: 'import_conflicts' })
    try {
      await writeTransaction(this.deps.db, async (trx) => {
        for (const item of items) if (item.write !== undefined) await item.write(trx)
      })
    } catch (error) {
      // Something changed between the plan and the transaction.
      if (error instanceof Outdated || isConstraintError(error)) {
        throw new AppError('conflict', { detail: 'preview_outdated' })
      }
      throw error
    }
    after()
    await this.deps.audit.record(actor, {
      action: 'config.imported',
      details: {
        fileSha256: hash,
        appVersion: file.appVersion,
        exportedAt: file.exportedAt,
        connections: plan.connections,
        new: plan.counts.new,
        changed: plan.counts.changed,
        unchanged: plan.counts.unchanged,
        items: items
          .filter((item) => item.status !== 'unchanged')
          .map((item) => ({
            kind: item.kind,
            key: item.key,
            status: item.status,
            ...(item.restored === true && { restored: true }),
            ...(item.change !== undefined && { change: item.change }),
            ...(item.issues !== undefined && { issues: item.issues.length }),
          })),
      },
    })
    return plan
  }

  private async plan(input: ImportInput) {
    const file = parse(configFile, input.file)
    const hash = sha256(JSON.stringify(input.file))
    const db = this.deps.db
    const now = this.clock()
    const items: Item[] = []
    const notices = new Set<() => void>()
    const add = (
      item: Omit<Item, 'conflicts' | 'status'> & { conflicts?: Item['conflicts'] },
      status: Item['status'],
    ) => {
      const conflicts = dedupe(item.conflicts ?? [])
      const entry: Item = { ...item, conflicts, status: conflicts.length > 0 ? 'conflict' : status }
      if (entry.status === 'unchanged' || entry.status === 'conflict') {
        delete entry.write
        delete entry.change
      }
      items.push(entry)
    }
    const duplicate = (detail: string) => ({ code: 'duplicate' as const, detail })

    // Connections, mapped by the admin.
    const connectionRows = await db.selectFrom('connections').select(['id', 'name']).execute()
    const mapped = new Map<string, string>()
    for (const { ref } of file.connections) {
      const id = input.connections[ref]
      if (id !== undefined && connectionRows.some((row) => row.id === id)) mapped.set(ref, id)
    }
    const connectionOf = (ref: string) => mapped.get(ref)
    const unmapped = (ref: string) =>
      connectionOf(ref) === undefined ? [{ code: 'connection_unmapped' as const, detail: ref }] : []

    // Table access on the target, by connection and object.
    const accessRows = await db.selectFrom('table_access').selectAll().execute()
    const accessOf = (ref: string, object: string) => {
      const connectionId = connectionOf(ref)
      return accessRows.find(
        (row) => row.connection_id === connectionId && row.object_name === object,
      )
    }
    const repeatedTables = repeated(file.tables, (table) => table.id)
    const tableTarget = new Map<string, { id?: string; detail: string }>()
    for (const table of file.tables) {
      const access = accessOf(table.connectionRef, table.object)
      tableTarget.set(table.id, {
        ...(access !== undefined && { id: access.id }),
        detail: `${table.connectionRef}/${table.object}`,
      })
    }

    // Sections.
    const sectionRows = await db.selectFrom('sections').selectAll().execute()
    const repeatedSections = repeated(file.sections, (section) => section.id)
    for (const section of file.sections) {
      const existing = sectionRows.find((row) => row.id === section.id)
      add(
        {
          kind: 'section',
          key: section.id,
          label: section.name,
          conflicts: repeatedSections.has(section.id) ? [duplicate(section.id)] : [],
          state: existing?.updated_at ?? null,
          ...(existing !== undefined && { change: { name: [existing.name, section.name] } }),
          write: async (trx) => {
            if (existing === undefined) {
              await trx
                .insertInto('sections')
                .values({
                  id: section.id,
                  name: section.name,
                  position: await nextPosition(trx, 'sections'),
                  created_at: now,
                  updated_at: now,
                })
                .execute()
            } else {
              guard(
                await trx
                  .updateTable('sections')
                  .set({ name: section.name, updated_at: now })
                  .where('id', '=', section.id)
                  .where('updated_at', '=', existing.updated_at)
                  .executeTakeFirst(),
              )
            }
          },
        },
        existing === undefined ? 'new' : existing.name === section.name ? 'unchanged' : 'changed',
      )
    }

    // Instance variables, by name.
    const variableRows = await db.selectFrom('instance_variables').selectAll().execute()
    const repeatedVariables = repeated(file.variables, (variable) => variable.name)
    const changedVariables: string[] = []
    for (const variable of file.variables) {
      const existing = variableRows.find((row) => row.name === variable.name)
      const conflicts: Item['conflicts'] = []
      if (repeatedVariables.has(variable.name)) conflicts.push(duplicate(variable.name))
      if (existing !== undefined && existing.type !== variable.type) {
        conflicts.push({ code: 'type_differs', detail: `${existing.type} → ${variable.type}` })
      }
      const checked = checkParamValue(variable.type, variable.value)
      if (!checked.ok) conflicts.push({ code: 'type_differs', detail: checked.code })
      const value = JSON.stringify(checked.ok ? checked.value : variable.value)
      const status =
        existing === undefined
          ? 'new'
          : existing.value === value && existing.description === variable.description
            ? 'unchanged'
            : 'changed'
      add(
        {
          kind: 'variable',
          key: variable.name,
          label: variable.name,
          conflicts,
          state: existing?.updated_at ?? null,
          change: {
            value: [
              existing === undefined ? null : (JSON.parse(existing.value) as unknown),
              JSON.parse(value) as unknown,
            ],
          },
          write: async (trx) => {
            changedVariables.push(variable.name)
            if (existing === undefined) {
              await trx
                .insertInto('instance_variables')
                .values({
                  id: uuidv7(),
                  name: variable.name,
                  type: variable.type,
                  value,
                  description: variable.description,
                  updated_by: null,
                  created_at: now,
                  updated_at: now,
                })
                .execute()
            } else {
              guard(
                await trx
                  .updateTable('instance_variables')
                  .set({ value, description: variable.description, updated_at: now })
                  .where('id', '=', existing.id)
                  .where('updated_at', '=', existing.updated_at)
                  .executeTakeFirst(),
              )
            }
          },
        },
        status,
      )
    }
    const variableNames = new Set([
      ...variableRows.map((row) => row.name),
      ...file.variables.map((variable) => variable.name),
    ])
    notices.add(() => {
      for (const name of changedVariables) this.deps.variables.changed(name)
    })

    // Virtual relations, by source column and target object.
    const changedConnections = new Set<string>()
    const pendingRelations = new Map<string, ModelRelation[]>()
    const relationKey = (relation: ConfigFile['relations'][number]) =>
      `${relation.connectionRef}/${relation.sourceObject}.${relation.sourceColumn}/${relation.targetObject}`
    const repeatedRelations = repeated(file.relations, relationKey)
    const relationsByConnection = new Map<
      string,
      Awaited<ReturnType<TableAccessService['relations']>>
    >()
    for (const relation of file.relations) {
      const connectionId = connectionOf(relation.connectionRef)
      const label = `${relation.sourceObject}.${relation.sourceColumn} → ${relation.targetObject}.${relation.targetColumn}`
      const key = relationKey(relation)
      const conflicts: Item['conflicts'] = repeatedRelations.has(key) ? [duplicate(label)] : []
      if (connectionId === undefined) {
        add(
          {
            kind: 'relation',
            key,
            label,
            conflicts: [...conflicts, ...unmapped(relation.connectionRef)],
          },
          'new',
        )
        continue
      }
      let existing = relationsByConnection.get(connectionId)
      if (existing === undefined) {
        existing = await this.deps.tableAccess.relations(connectionId)
        relationsByConnection.set(connectionId, existing)
      }
      const match = existing.find(
        (entry) =>
          entry.sourceObject === relation.sourceObject &&
          entry.sourceColumn === relation.sourceColumn &&
          entry.targetObject === relation.targetObject,
      )
      if (match !== undefined) {
        const identical =
          match.targetColumn === relation.targetColumn && match.kind === relation.kind
        if (!identical) {
          conflicts.push({
            code: 'relation_differs',
            detail: `${match.targetObject}.${match.targetColumn}`,
          })
        }
        add({ kind: 'relation', key, label, conflicts }, 'unchanged')
        continue
      }
      try {
        await this.deps.tableAccess.checkRelation({ ...relation, connectionId })
      } catch (error) {
        conflicts.push({ code: 'relation_invalid', detail: conflictOf(error) })
      }
      if (conflicts.length === 0) {
        const list = pendingRelations.get(connectionId) ?? []
        list.push({
          sourceObject: relation.sourceObject,
          sourceColumn: relation.sourceColumn,
          targetObject: relation.targetObject,
          targetColumn: relation.targetColumn,
        })
        pendingRelations.set(connectionId, list)
      }
      add(
        {
          kind: 'relation',
          key,
          label,
          conflicts,
          state: null,
          write: async (trx) => {
            changedConnections.add(connectionId)
            await trx
              .insertInto('virtual_relations')
              .values({
                id: uuidv7(),
                connection_id: connectionId,
                source_object: relation.sourceObject,
                source_column: relation.sourceColumn,
                target_object: relation.targetObject,
                target_column: relation.targetColumn,
                kind: relation.kind,
                created_at: now,
              })
              .execute()
          },
        },
        'new',
      )
    }

    // Display templates on the target's table access. A template that does not fit shows
    // as `template_invalid` on the table access and falls back to the default.
    const pendingTemplates = new Map<string, Map<string, string>>()
    const repeatedTemplates = repeated(
      file.displayTemplates,
      (entry) => `${entry.connectionRef}/${entry.object}`,
    )
    for (const entry of file.displayTemplates) {
      const key = `${entry.connectionRef}/${entry.object}`
      const access = accessOf(entry.connectionRef, entry.object)
      const conflicts: Item['conflicts'] = unmapped(entry.connectionRef)
      if (repeatedTemplates.has(key)) conflicts.push(duplicate(key))
      if (conflicts.length === 0 && access === undefined) {
        conflicts.push({ code: 'table_access_missing', detail: key })
      }
      if (conflicts.length === 0 && access !== undefined) {
        const own = pendingTemplates.get(access.connection_id) ?? new Map<string, string>()
        own.set(access.object_name, entry.template)
        pendingTemplates.set(access.connection_id, own)
      }
      add(
        {
          kind: 'display_template',
          key,
          label: entry.object,
          conflicts,
          state: access?.updated_at ?? null,
          change: { template: [access?.display_template ?? null, entry.template] },
          write: async (trx) => {
            if (access === undefined) return
            changedConnections.add(access.connection_id)
            guard(
              await trx
                .updateTable('table_access')
                .set({ display_template: entry.template, updated_at: now })
                .where('id', '=', access.id)
                .where('updated_at', '=', access.updated_at)
                .executeTakeFirst(),
            )
          },
        },
        access?.display_template === entry.template ? 'unchanged' : 'changed',
      )
    }
    notices.add(() => {
      for (const connectionId of changedConnections) {
        this.deps.events.emit('table-access.changed', { connectionId })
      }
    })

    // Queries, by ID; their names are unique.
    const queryRows = await db.selectFrom('queries').selectAll().execute()
    const versionRows = await db
      .selectFrom('query_versions')
      .select(['query_id', 'version', 'sql_text', 'builder_spec', 'parameters'])
      .execute()
    const repeatedQueryIds = repeated(file.queries, (query) => query.id)
    const repeatedQueryNames = repeated(file.queries, (query) => query.name)
    /** Versions the import adds, as page checks will find them. */
    const pendingQueries = new Map<
      string,
      { connectionId: string; latest: number; versions: Map<number, StoredVersion> }
    >()
    const changedQueries: string[] = []
    for (const query of file.queries) {
      const connectionId = connectionOf(query.connectionRef)
      const existing = queryRows.find((row) => row.id === query.id)
      const conflicts: Item['conflicts'] = unmapped(query.connectionRef)
      const issues: NonNullable<ConfigImportItem['issues']> = []
      if (repeatedQueryIds.has(query.id)) conflicts.push(duplicate(query.id))
      if (repeatedQueryNames.has(query.name)) conflicts.push(duplicate(query.name))
      if (existing?.archived_at != null) conflicts.push({ code: 'archived' })
      if (
        existing !== undefined &&
        connectionId !== undefined &&
        existing.connection_id !== connectionId
      ) {
        conflicts.push({ code: 'connection_differs' })
      }
      if (queryRows.some((row) => row.name === query.name && row.id !== query.id)) {
        conflicts.push({ code: 'name_taken', detail: query.name })
      }
      if (repeated(query.versions, (version) => String(version.version)).size > 0) {
        conflicts.push(duplicate(`${query.name} versions`))
      }
      const additions: {
        version: (typeof query.versions)[number]
        analysis: QueryAnalysis
        executable: Executable
      }[] = []
      for (const [index, version] of query.versions.entries()) {
        const stored = versionRows.find(
          (row) => row.query_id === query.id && row.version === version.version,
        )
        if (stored !== undefined) {
          const identical =
            stored.sql_text === version.sql &&
            same(JSON.parse(stored.parameters), version.parameters) &&
            same(
              stored.builder_spec === null ? null : JSON.parse(stored.builder_spec),
              version.builder,
            )
          if (!identical)
            conflicts.push({ code: 'version_differs', detail: String(version.version) })
          continue
        }
        if (connectionId === undefined) continue
        try {
          const validated = await this.deps.queries.validate(
            connectionId,
            version.sql,
            version.parameters,
            variableNames,
          )
          additions.push({ version, ...validated })
        } catch (error) {
          conflicts.push({
            code: 'query_invalid',
            detail: `${String(version.version)}: ${conflictOf(error)}`,
          })
          continue
        }
        // A builder version whose spec gives other SQL here runs the file's SQL, while the
        // editor shows the spec (e.g. another time zone of the connection).
        if (version.builder !== null) {
          const at = `versions.${String(index)}.builder`
          try {
            const built = await this.deps.queries.toSql(
              connectionId,
              { builder: version.builder.spec },
              version.parameters,
            )
            if (built.sql !== version.sql) issues.push({ path: at, code: 'builder_differs' })
          } catch (error) {
            issues.push({ path: at, code: conflictOf(error) })
          }
        }
      }
      const latest = Math.max(
        existing?.latest_version ?? 0,
        ...query.versions.map((v) => v.version),
      )
      if (connectionId !== undefined && additions.length > 0) {
        pendingQueries.set(query.id, {
          connectionId,
          latest,
          versions: new Map(
            additions.map((addition) => [
              addition.version.version,
              {
                queryId: query.id,
                connectionId,
                version: addition.version.version,
                cacheTtlSeconds: query.cacheTtlSeconds,
                parameters: addition.version.parameters,
                analysis: addition.analysis,
                executable: addition.executable,
                resultColumns: null,
              },
            ]),
          ),
        })
      }
      const latestFile = query.versions[query.versions.length - 1]
      const mode = (latestFile?.builder ?? null) === null ? 'sql' : 'builder'
      const fieldsChanged =
        existing !== undefined &&
        (existing.name !== query.name ||
          existing.description !== query.description ||
          existing.cache_ttl_seconds !== query.cacheTtlSeconds)
      add(
        {
          kind: 'query',
          key: query.id,
          label: query.name,
          conflicts,
          ...(issues.length > 0 && { issues }),
          state:
            existing === undefined
              ? null
              : { latest: existing.latest_version, updated: existing.updated_at },
          change: {
            latestVersion: [existing?.latest_version ?? null, latest],
            ...(existing !== undefined &&
              existing.name !== query.name && { name: [existing.name, query.name] }),
          },
          write: async (trx) => {
            if (connectionId === undefined) return
            changedQueries.push(query.id)
            if (existing === undefined) {
              await trx
                .insertInto('queries')
                .values({
                  id: query.id,
                  connection_id: connectionId,
                  name: query.name,
                  description: query.description,
                  mode,
                  cache_ttl_seconds: query.cacheTtlSeconds,
                  latest_version: latest,
                  created_by: null,
                  created_at: now,
                  updated_at: now,
                  archived_at: null,
                })
                .execute()
            } else {
              guard(
                await trx
                  .updateTable('queries')
                  .set({
                    name: query.name,
                    description: query.description,
                    cache_ttl_seconds: query.cacheTtlSeconds,
                    latest_version: latest,
                    ...(latest > existing.latest_version && { mode }),
                    updated_at: now,
                  })
                  .where('id', '=', query.id)
                  .where('latest_version', '=', existing.latest_version)
                  .where('updated_at', '=', existing.updated_at)
                  .executeTakeFirst(),
              )
            }
            for (const addition of additions) {
              await trx
                .insertInto('query_versions')
                .values({
                  query_id: query.id,
                  version: addition.version.version,
                  sql_text: addition.version.sql,
                  builder_spec:
                    addition.version.builder === null
                      ? null
                      : JSON.stringify(addition.version.builder),
                  parameters: JSON.stringify(addition.version.parameters),
                  analysis: JSON.stringify(addition.analysis),
                  executable: JSON.stringify(addition.executable),
                  result_columns: null,
                  created_by: null,
                  created_at: now,
                })
                .execute()
            }
          },
        },
        existing === undefined
          ? 'new'
          : additions.length > 0 || fieldsChanged
            ? 'changed'
            : 'unchanged',
      )
    }
    notices.add(() => {
      for (const queryId of changedQueries) this.deps.events.emit('query.changed', { queryId })
    })

    // Pages are checked as they will be: the file's relations, templates, queries and roles
    // added to this instance's.
    const roleRows = await db.selectFrom('roles').selectAll().execute()
    const compileDeps: CompileDeps = {
      facts: pendingFacts(this.deps.facts, pendingRelations, pendingTemplates),
      queries: {
        stored: async (queryId, version) => {
          const pending = pendingQueries.get(queryId)
          const added = pending?.versions.get(version ?? pending.latest)
          if (added !== undefined) return added
          return this.deps.queries.stored(queryId, version ?? pending?.latest)
        },
      },
      roleIds: new Set([...roleRows.map((row) => row.id), ...file.roles.map((role) => role.id)]),
    }

    // Pages, by ID; their slugs are unique.
    const pageRows = await db.selectFrom('pages').selectAll().execute()
    const publishedRows = await db
      .selectFrom('page_versions')
      .innerJoin('pages', (join) =>
        join
          .onRef('pages.id', '=', 'page_versions.page_id')
          .onRef('pages.published_version', '=', 'page_versions.version'),
      )
      .select(['page_versions.page_id', 'page_versions.document'])
      .execute()
    const sectionIds = new Set([
      ...sectionRows.map((row) => row.id),
      ...file.sections.map((s) => s.id),
    ])
    const queryIds = new Set([
      ...queryRows.filter((row) => row.archived_at === null).map((row) => row.id),
      ...file.queries.map((query) => query.id),
    ])
    const queryVersions = new Set([
      ...versionRows.map((row) => `${row.query_id}@${String(row.version)}`),
      ...file.queries.flatMap((query) =>
        query.versions.map((v) => `${query.id}@${String(v.version)}`),
      ),
    ])
    const pageIds = new Set([
      ...pageRows.filter((row) => row.archived_at === null).map((row) => row.id),
      ...file.pages.map((page) => page.id),
    ])
    const repeatedPageIds = repeated(file.pages, (page) => page.id)
    const repeatedSlugs = repeated(file.pages, (page) => page.slug)
    const pageEvents: { pageId: string; published: boolean }[] = []
    for (const page of file.pages) {
      const existing = pageRows.find((row) => row.id === page.id)
      // A page deleted here comes back (§24): deleting only archives it.
      const restored = existing?.archived_at != null
      const conflicts: Item['conflicts'] = []
      if (repeatedPageIds.has(page.id)) conflicts.push(duplicate(page.id))
      if (repeatedSlugs.has(page.slug)) conflicts.push(duplicate(page.slug))
      if (existing !== undefined && !restored && existing.kind !== page.draft.kind)
        conflicts.push({ code: 'kind_differs' })
      if (page.published !== null && page.published.kind !== page.draft.kind)
        conflicts.push({ code: 'kind_differs', detail: 'published' })
      if (pageRows.some((row) => row.slug === page.slug && row.id !== page.id)) {
        conflicts.push({ code: 'name_taken', detail: page.slug })
      }
      if (page.sectionId !== null && !sectionIds.has(page.sectionId)) {
        conflicts.push({ code: 'reference_missing', detail: `section ${page.sectionId}` })
      }
      const missingTables = new Set<string>()
      const unknownTables = new Set<string>()
      const doubledTables = new Set<string>()
      const mapDocument = (document: unknown) =>
        mapTableIds(document, (id) => {
          const target = tableTarget.get(id)
          if (target === undefined) unknownTables.add(id)
          else if (repeatedTables.has(id)) doubledTables.add(id)
          else if (target.id === undefined) missingTables.add(target.detail)
          return target?.id ?? id
        }) as PageDocument
      const draft = mapDocument(page.draft)
      const published = page.published === null ? null : mapDocument(page.published)
      for (const detail of missingTables) {
        const ref = detail.split('/')[0] ?? ''
        conflicts.push(
          connectionOf(ref) === undefined
            ? { code: 'connection_unmapped', detail: ref }
            : { code: 'table_access_missing', detail },
        )
      }
      for (const id of unknownTables) conflicts.push({ code: 'table_unknown', detail: id })
      for (const id of doubledTables) conflicts.push(duplicate(`table ${id}`))
      for (const queryRef of queryRefsOf(draft)) {
        if (!queryIds.has(queryRef.queryId)) {
          conflicts.push({ code: 'reference_missing', detail: `query ${queryRef.queryId}` })
        }
      }
      for (const queryRef of queryRefsOf(published)) {
        if (
          queryRef.version !== undefined &&
          !queryVersions.has(`${queryRef.queryId}@${String(queryRef.version)}`)
        ) {
          conflicts.push({
            code: 'reference_missing',
            detail: `query ${queryRef.queryId} version ${String(queryRef.version)}`,
          })
        }
      }
      for (const pageId of pageRefsOf([draft, published])) {
        if (!pageIds.has(pageId)) {
          conflicts.push({ code: 'reference_missing', detail: `page ${pageId}` })
        }
      }

      // Checked against this instance as the editor would check it: columns and relations
      // missing here block; other problems are shown and stay visible in the editor.
      const issues: NonNullable<ConfigImportItem['issues']> = []
      if (conflicts.length === 0) {
        const documents = [
          { document: draft, version: null, prefix: 'draft' },
          ...(published === null ? [] : [{ document: published, version: 1, prefix: 'published' }]),
        ]
        for (const { document, version, prefix } of documents) {
          const found = await this.deps.access.checkWith(
            {
              pageId: page.id,
              slug: page.slug,
              sectionId: page.sectionId,
              position: 0,
              version,
              revision: 0,
              document,
            },
            compileDeps,
          )
          for (const issue of found) {
            if (issue.severity !== 'error') continue
            if (schemaIssueCodes.has(issue.code)) {
              const name = nameAt(document, issue.path) ?? issue.params?.column
              conflicts.push({
                code: 'column_missing',
                detail: `${name === undefined ? issue.path : String(name)} (${issue.code})`,
              })
            } else if (
              !issues.some(
                (entry) => entry.code === issue.code && entry.path.endsWith(`.${issue.path}`),
              )
            ) {
              issues.push({
                path: `${prefix}.${issue.path}`,
                code: issue.code,
                ...(issue.params !== undefined && { params: issue.params }),
              })
            }
          }
        }
      }

      const currentDraft =
        existing === undefined ? undefined : (JSON.parse(existing.draft) as unknown)
      const currentPublished = publishedRows.find((row) => row.page_id === page.id)
      const draftChanged = !same(currentDraft, draft)
      const publishChanged =
        published !== null &&
        (currentPublished === undefined || !same(JSON.parse(currentPublished.document), published))
      const moved =
        existing !== undefined &&
        (existing.slug !== page.slug || existing.section_id !== page.sectionId)
      const nextVersion = (existing?.published_version ?? 0) + (publishChanged ? 1 : 0)
      const nextPublished = publishChanged
        ? nextVersion
        : restored && published === null
          ? null
          : (existing?.published_version ?? null)
      add(
        {
          kind: 'page',
          key: page.id,
          label: page.draft.title,
          conflicts,
          ...(restored && { restored: true as const }),
          ...(issues.length > 0 && { issues: issues.slice(0, 20) }),
          state:
            existing === undefined
              ? null
              : {
                  revision: existing.draft_revision,
                  published: existing.published_version,
                  archived: existing.archived_at !== null,
                },
          change: {
            draftRevision: [
              existing?.draft_revision ?? null,
              existing === undefined ? 1 : existing.draft_revision + (draftChanged ? 1 : 0),
            ],
            publishedVersion: [existing?.published_version ?? null, nextPublished],
            ...(existing !== undefined && moved && { slug: [existing.slug, page.slug] }),
          },
          write: async (trx) => {
            pageEvents.push({ pageId: page.id, published: publishChanged || restored })
            if (existing === undefined) {
              await trx
                .insertInto('pages')
                .values({
                  id: page.id,
                  section_id: page.sectionId,
                  position: await nextPosition(trx, 'pages'),
                  kind: page.draft.kind,
                  slug: page.slug,
                  draft: JSON.stringify(draft),
                  draft_revision: 1,
                  draft_updated_by: null,
                  draft_updated_at: now,
                  published_version: publishChanged ? nextVersion : null,
                  created_at: now,
                  archived_at: null,
                })
                .execute()
            } else {
              let update = trx
                .updateTable('pages')
                .set({
                  section_id: page.sectionId,
                  slug: page.slug,
                  ...(restored && {
                    archived_at: null,
                    kind: page.draft.kind,
                    position: await nextPosition(trx, 'pages'),
                  }),
                  ...(draftChanged && {
                    draft: JSON.stringify(draft),
                    draft_revision: existing.draft_revision + 1,
                    draft_updated_by: null,
                    draft_updated_at: now,
                  }),
                  published_version: nextPublished,
                })
                .where('id', '=', page.id)
                .where('draft_revision', '=', existing.draft_revision)
              update =
                existing.published_version === null
                  ? update.where('published_version', 'is', null)
                  : update.where('published_version', '=', existing.published_version)
              update = restored
                ? update.where('archived_at', 'is not', null)
                : update.where('archived_at', 'is', null)
              guard(await update.executeTakeFirst())
            }
            if (publishChanged) {
              await trx
                .insertInto('page_versions')
                .values({
                  page_id: page.id,
                  version: nextVersion,
                  document: JSON.stringify(published),
                  source_revision:
                    existing === undefined ? 1 : existing.draft_revision + (draftChanged ? 1 : 0),
                  published_by: null,
                  published_at: now,
                })
                .execute()
              await trx
                .deleteFrom('page_versions')
                .where('page_id', '=', page.id)
                .where('version', '<=', nextVersion - keptVersions)
                .execute()
            }
          },
        },
        existing === undefined || restored
          ? 'new'
          : draftChanged || publishChanged || moved
            ? 'changed'
            : 'unchanged',
      )
    }
    notices.add(() => {
      for (const { pageId, published } of pageEvents) {
        this.deps.events.emit('page.changed', { pageId })
        if (published) this.deps.events.emit('page.published', { pageId })
      }
    })

    // Roles, by ID; their names are unique. They come after pages for their home pages.
    const repeatedRoleIds = repeated(file.roles, (role) => role.id)
    const repeatedRoleNames = repeated(file.roles, (role) => role.name.toLowerCase())
    let rolesChanged = false
    for (const role of file.roles) {
      const existing = roleRows.find((row) => row.id === role.id)
      const conflicts: Item['conflicts'] = []
      if (repeatedRoleIds.has(role.id)) conflicts.push(duplicate(role.id))
      if (repeatedRoleNames.has(role.name.toLowerCase())) conflicts.push(duplicate(role.name))
      if (
        roleRows.some(
          (row) => row.name.toLowerCase() === role.name.toLowerCase() && row.id !== role.id,
        )
      ) {
        conflicts.push({ code: 'name_taken', detail: role.name })
      }
      if (role.homePageId !== null && !pageIds.has(role.homePageId)) {
        conflicts.push({ code: 'reference_missing', detail: `page ${role.homePageId}` })
      }
      add(
        {
          kind: 'role',
          key: role.id,
          label: role.name,
          conflicts,
          state: existing?.updated_at ?? null,
          ...(existing !== undefined &&
            existing.name !== role.name && { change: { name: [existing.name, role.name] } }),
          write: async (trx) => {
            rolesChanged = true
            if (existing === undefined) {
              await trx
                .insertInto('roles')
                .values({
                  id: role.id,
                  name: role.name,
                  description: role.description,
                  home_page_id: role.homePageId,
                  position: await nextPosition(trx, 'roles'),
                  created_at: now,
                  updated_at: now,
                })
                .execute()
            } else {
              guard(
                await trx
                  .updateTable('roles')
                  .set({
                    name: role.name,
                    description: role.description,
                    home_page_id: role.homePageId,
                    updated_at: now,
                  })
                  .where('id', '=', role.id)
                  .where('updated_at', '=', existing.updated_at)
                  .executeTakeFirst(),
              )
            }
          },
        },
        existing === undefined
          ? 'new'
          : existing.name === role.name &&
              existing.description === role.description &&
              existing.home_page_id === role.homePageId
            ? 'unchanged'
            : 'changed',
      )
    }
    notices.add(() => {
      if (rolesChanged) this.deps.events.emit('roles.changed', {})
    })

    // Writes follow foreign keys: sections, variables, relations, templates, queries, pages,
    // roles; that is the order they were planned in.
    const counts = { new: 0, changed: 0, unchanged: 0, conflict: 0 }
    for (const item of items) counts[item.status] += 1
    const visible = items.map(
      ({ write: _write, state: _state, change: _change, ...item }): ConfigImportItem => item,
    )
    const connections = file.connections.map(({ ref }) => ({
      ref,
      connectionId: connectionOf(ref) ?? null,
    }))
    // The target's state belongs in it, so a change here since the preview stops the import.
    const fingerprint = sha256(
      JSON.stringify({
        hash,
        connections,
        items: visible,
        state: items.map((item) => item.state ?? null),
      }),
    )
    const plan: ConfigImportPlan = {
      fingerprint,
      appVersion: file.appVersion,
      exportedAt: file.exportedAt,
      connections,
      items: visible,
      counts,
    }
    return {
      plan,
      items,
      file,
      hash,
      after: () => {
        for (const notice of notices) notice()
      },
    }
  }
}

function dedupe(conflicts: Item['conflicts']): Item['conflicts'] {
  const seen = new Set<string>()
  return conflicts.filter((conflict) => {
    const key = `${conflict.code}:${conflict.detail ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
