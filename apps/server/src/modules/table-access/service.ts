// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccessWarning,
  CatalogObject,
  ChangeConsequence,
  CatalogSnapshot,
  GrantReport,
  Relation,
  TableAccess,
  TableOp,
  UserScope,
  relationInput,
  tableAccessCreate,
  tableAccessUpdate,
} from '@stashley/shared'
import { lockStrategy, tableOps, type LockSetting } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, TableAccessTable } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { CatalogService } from '../catalog/service.ts'
import {
  columnPrivileged,
  columnReadable,
  objectPrivileges,
  privilegedColumns,
} from '../connections/grants.ts'
import type { ConnectionsService } from '../connections/service.ts'
import { userScope } from './user-scope.ts'
import { checkTemplate, defaultTemplate, type TemplateContext } from './templates.ts'

type CreateInput = z.infer<typeof tableAccessCreate>
type UpdateInput = z.infer<typeof tableAccessUpdate>

const opBits: Record<TableOp, number> = { read: 1, create: 2, update: 4, delete: 8 }

export function opsToMask(ops: TableOp[]): number {
  return ops.reduce((mask, op) => mask | opBits[op], 0)
}

export function maskToOps(mask: number): TableOp[] {
  return tableOps.filter((op) => (mask & opBits[op]) !== 0)
}

export interface TableAccessDeps {
  db: Kysely<Database>
  connections: ConnectionsService
  catalog: CatalogService
  audit: AuditLog
  clock?: Clock
  events?: EventBus
}

/** A change of a table access, as modules built on it see it (E15). */
export interface AccessChange {
  ops: TableOp[]
  objectType: 'table' | 'view'
  keyColumn: string | null
  apiResource: string
  removed: boolean
}

/**
 * A module built on table access (the public API): it lists what a change takes away, so
 * the admin confirms it first, and applies it in the same transaction (E15).
 */
export interface TableAccessDependent {
  /** What the change takes away; throws a field error to refuse it. */
  consequences(before: TableAccess, change: AccessChange): Promise<ChangeConsequence[]>
  apply(trx: Kysely<Database>, before: TableAccess, change: AccessChange): Promise<void>
}

/** A relation usable in display templates and linked columns. */
interface ResolvedRelation extends Relation {
  sourceUnique: boolean
}

function uniqueColumns(object: CatalogObject, viewKey: string | null): Set<string> {
  const unique = new Set<string>()
  if (object.primaryKey.length === 1 && object.primaryKey[0] !== undefined) {
    unique.add(object.primaryKey[0])
  }
  for (const key of object.uniqueKeys)
    if (key.length === 1 && key[0] !== undefined) unique.add(key[0])
  if (viewKey !== null) unique.add(viewKey)
  return unique
}

function excludedForAll(
  exclusions: { table_access_id: string; column_name: string; scope: 'all' | 'mcp' }[],
  accessId: string,
): Set<string> {
  return new Set(
    exclusions
      .filter((entry) => entry.table_access_id === accessId && entry.scope === 'all')
      .map((entry) => entry.column_name),
  )
}

/** Value kinds that can be joined with each other. */
function keyFamily(kind: string | undefined): string | undefined {
  if (kind === 'integer' || kind === 'bigint') return 'integer'
  if (kind === 'string' || kind === 'enum') return 'string'
  return kind
}

function lockOf(row: TableAccessTable): LockSetting {
  if (row.lock_mode === 'column' && row.lock_column !== null) {
    return { mode: 'column', column: row.lock_column }
  }
  return row.lock_mode === 'none' ? { mode: 'none' } : { mode: 'auto' }
}

function lockColumns(lock: LockSetting): Pick<TableAccessTable, 'lock_mode' | 'lock_column'> {
  return { lock_mode: lock.mode, lock_column: lock.mode === 'column' ? lock.column : null }
}

function defaultResource(objectName: string): string {
  const base = objectName.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return /^[a-z]/.test(base) ? base.slice(0, 63) : `t_${base}`.slice(0, 63)
}

export class TableAccessService {
  private readonly deps: TableAccessDeps
  private readonly clock: Clock
  private readonly dependents: TableAccessDependent[] = []

  constructor(deps: TableAccessDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  addDependent(dependent: TableAccessDependent): void {
    this.dependents.push(dependent)
  }

  /** Consequences of a change; without `confirm` a change with any is refused (E15). */
  private async consequences(
    before: TableAccess,
    change: AccessChange,
    confirm: boolean | undefined,
  ): Promise<ChangeConsequence[]> {
    const all: ChangeConsequence[] = []
    for (const dependent of this.dependents) {
      all.push(...(await dependent.consequences(before, change)))
    }
    if (all.length > 0 && confirm !== true) {
      throw new AppError('confirmation_required', { consequences: all })
    }
    return all
  }

  private async snapshot(connectionId: string): Promise<CatalogSnapshot> {
    const snapshot = await this.deps.catalog.current(connectionId)
    if (snapshot === undefined) throw fieldError('connectionId', 'schema_missing')
    return snapshot
  }

  private async rows(connectionId: string): Promise<TableAccessTable[]> {
    return this.deps.db
      .selectFrom('table_access')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .orderBy('object_name')
      .execute()
  }

  private async exclusions(ids: string[]) {
    if (ids.length === 0) return []
    return this.deps.db
      .selectFrom('column_exclusions')
      .selectAll()
      .where('table_access_id', 'in', ids)
      .orderBy('column_name')
      .execute()
  }

  /** Physical relations from foreign keys plus the virtual ones. */
  async relations(connectionId: string): Promise<Relation[]> {
    return (await this.resolvedRelations(connectionId)).map(
      ({ sourceUnique: _ignored, ...relation }) => relation,
    )
  }

  private async resolvedRelations(
    connectionId: string,
    snapshot?: CatalogSnapshot,
  ): Promise<ResolvedRelation[]> {
    const catalog = snapshot ?? (await this.deps.catalog.current(connectionId))
    const objects = new Map((catalog?.objects ?? []).map((object) => [object.name, object]))
    const accesses = await this.rows(connectionId)
    const viewKey = (name: string) =>
      accesses.find((access) => access.object_name === name)?.key_column ?? null
    const isUnique = (object: string, column: string) => {
      const entry = objects.get(object)
      return entry !== undefined && uniqueColumns(entry, viewKey(object)).has(column)
    }
    const relations: ResolvedRelation[] = []
    for (const object of objects.values()) {
      for (const fk of object.foreignKeys) {
        const [column] = fk.columns
        const [targetColumn] = fk.targetColumns
        if (fk.columns.length !== 1 || column === undefined || targetColumn === undefined) continue
        relations.push({
          id: null,
          origin: 'constraint',
          name: fk.name,
          sourceObject: object.name,
          sourceColumn: column,
          targetObject: fk.targetObject,
          targetColumn,
          kind: 'many_to_one',
          sourceUnique: isUnique(object.name, column),
        })
      }
    }
    const virtual = await this.deps.db
      .selectFrom('virtual_relations')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .orderBy('source_object')
      .execute()
    for (const row of virtual) {
      relations.push({
        id: row.id,
        origin: 'virtual',
        name: `${row.source_object}.${row.source_column}`,
        sourceObject: row.source_object,
        sourceColumn: row.source_column,
        targetObject: row.target_object,
        targetColumn: row.target_column,
        kind: row.kind,
        sourceUnique: row.kind === 'one_to_one',
      })
    }
    return relations
  }

  async list(connectionId: string): Promise<TableAccess[]> {
    const target = await this.deps.connections.grantReports(connectionId)
    const snapshot = await this.deps.catalog.current(connectionId)
    const rows = await this.rows(connectionId)
    const exclusions = await this.exclusions(rows.map((row) => row.id))
    const templates = await this.templateScope(connectionId, snapshot, rows, exclusions)
    return rows.map((row) =>
      this.toApi(
        row,
        exclusions.filter((entry) => entry.table_access_id === row.id),
        snapshot,
        target.reports,
        target.hasWriter,
        templates,
      ),
    )
  }

  /**
   * What display templates of a connection are checked against: the catalog, relations and
   * the objects that are exposed with `read`, each with its columns excluded for everyone.
   */
  private async templateScope(
    connectionId: string,
    snapshot: CatalogSnapshot | undefined,
    rows: TableAccessTable[],
    exclusions: { table_access_id: string; column_name: string; scope: 'all' | 'mcp' }[],
  ): Promise<(object: CatalogObject, excluded: ReadonlySet<string>) => TemplateContext> {
    const objects = new Map((snapshot?.objects ?? []).map((object) => [object.name, object]))
    const relations =
      snapshot === undefined ? [] : await this.resolvedRelations(connectionId, snapshot)
    const readable = new Map(
      rows
        .filter((row) => (row.ops & opBits.read) !== 0 && row.state === 'active')
        .map((row) => [row.object_name, { excluded: excludedForAll(exclusions, row.id) }]),
    )
    return (object, excluded) => ({
      object,
      objects,
      relations: relations.filter((relation) => relation.sourceObject === object.name),
      excluded,
      target: (name) => readable.get(name),
    })
  }

  /** What the read or write user may do beyond the table access (§9.4). */
  async scope(connectionId: string, purpose: 'read' | 'write'): Promise<UserScope> {
    const connection = await this.deps.connections.get(connectionId)
    const { reports } = await this.deps.connections.grantReports(connectionId)
    const snapshot = await this.deps.catalog.current(connectionId)
    const rows = await this.rows(connectionId)
    const exclusions = await this.exclusions(rows.map((row) => row.id))
    return userScope({
      purpose,
      database: connection.databaseName,
      report: reports[purpose],
      catalog: snapshot?.objects ?? [],
      exposed: rows.map((row) => ({
        objectName: row.object_name,
        objectType: row.object_type,
        ops: maskToOps(row.ops),
        excluded: excludedForAll(exclusions, row.id),
      })),
    })
  }

  async get(id: string): Promise<TableAccess> {
    const row = await this.deps.db
      .selectFrom('table_access')
      .select('connection_id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    const access = (await this.list(row.connection_id)).find((entry) => entry.id === id)
    if (access === undefined) throw new AppError('not_found')
    return access
  }

  private toApi(
    row: TableAccessTable,
    exclusions: { column_name: string; scope: 'all' | 'mcp' }[],
    snapshot: CatalogSnapshot | undefined,
    reports: Partial<Record<'read' | 'write' | 'schema', GrantReport>>,
    hasWriter: boolean,
    templates: (object: CatalogObject, excluded: ReadonlySet<string>) => TemplateContext,
  ): TableAccess {
    const ops = maskToOps(row.ops)
    const object = snapshot?.objects.find((entry) => entry.name === row.object_name)
    const granted = new Set<TableOp>()
    if (
      reports.read !== undefined &&
      objectPrivileges(reports.read, row.object_name).has('SELECT')
    ) {
      granted.add('read')
    }
    if (row.object_type === 'table' && reports.write !== undefined) {
      const privileges = objectPrivileges(reports.write, row.object_name)
      // Every write needs SELECT as well: creates read their row back (base filter, answer,
      // dry run), updates and deletes find their row by key.
      const select = privileges.has('SELECT')
      if (privileges.has('INSERT') && select) granted.add('create')
      if (privileges.has('UPDATE') && select) granted.add('update')
      if (privileges.has('DELETE') && select) granted.add('delete')
    }
    const writeColumns = (privilege: 'INSERT' | 'UPDATE') =>
      row.object_type === 'table' && reports.write !== undefined
        ? privilegedColumns(reports.write, row.object_name, privilege)
        : null
    const warnings: AccessWarning[] = []
    if (object === undefined || row.state === 'pending_grants')
      warnings.push({ code: 'not_in_schema' })
    const writes = ops.filter((op) => op !== 'read')
    if (writes.length > 0 && !hasWriter) warnings.push({ code: 'no_write_user' })
    // Without a write user, `no_write_user` already covers the write operations.
    const ungranted = ops.filter((op) => !granted.has(op) && (op === 'read' || hasWriter))
    if (ungranted.length > 0) warnings.push({ code: 'ops_without_grant', ops: ungranted })
    // The database would let the write user write more than the ceiling allows; views never.
    if (reports.write !== undefined) {
      const privileges = objectPrivileges(reports.write, row.object_name)
      const beyond = (['create', 'update', 'delete'] as const).filter(
        (op) =>
          privileges.has({ create: 'INSERT', update: 'UPDATE', delete: 'DELETE' }[op]) &&
          !ops.includes(op),
      )
      if (beyond.length > 0) warnings.push({ code: 'write_beyond_ceiling', ops: [...beyond] })
    }
    if (row.object_type === 'view' && row.key_column === null) {
      warnings.push({ code: 'view_without_key' })
    }
    // Without SHOW VIEW the base tables of a view stay unknown, so caches cannot follow
    // writes to them (§12).
    if (object?.type === 'view' && object.dependenciesKnown === false) {
      warnings.push({ code: 'view_dependencies_unknown' })
    }
    // A key column with NULL values cannot identify rows or page through them.
    const key = object?.columns.find((column) => column.name === row.key_column)
    if (row.object_type === 'view' && key?.nullable === true) {
      warnings.push({ code: 'view_key_nullable' })
    }
    // A table's key must still be its single-column primary key.
    if (
      object?.type === 'table' &&
      (object.primaryKey.length !== 1 || object.primaryKey[0] !== row.key_column)
    ) {
      warnings.push({ code: 'key_mismatch' })
    }
    // A stored template that no longer passes (a column was excluded or removed, the target
    // lost `read` or its access) is not used; the default template is safe.
    const excluded = new Set(
      exclusions.filter((entry) => entry.scope === 'all').map((entry) => entry.column_name),
    )
    // The database would let the read user select these columns; only the SQL validation
    // keeps them out of queries until column grants leave them out (§9.4).
    const readableExcluded =
      reports.read === undefined
        ? []
        : [...excluded]
            .filter((column) =>
              columnReadable(reports.read as GrantReport, row.object_name, column),
            )
            .sort()
    if (readableExcluded.length > 0) {
      warnings.push({ code: 'excluded_column_readable', columns: readableExcluded })
    }
    // The same for writes: only Stashley's own write path keeps these columns unwritten until
    // column grants leave them out (E6).
    const writableExcluded =
      reports.write === undefined || row.object_type !== 'table'
        ? []
        : [...excluded]
            .filter((column) =>
              (['INSERT', 'UPDATE'] as const).some((privilege) =>
                columnPrivileged(reports.write as GrantReport, row.object_name, column, privilege),
              ),
            )
            .sort()
    if (writableExcluded.length > 0) {
      warnings.push({ code: 'excluded_column_writable', columns: writableExcluded })
    }
    // No insert can leave out a required column, so excluding one rules out `create`.
    const requiredExcluded = ops.includes('create')
      ? (object?.columns ?? [])
          .filter(
            (column) =>
              excluded.has(column.name) &&
              !column.nullable &&
              column.defaultValue === null &&
              !column.autoIncrement &&
              !column.generated,
          )
          .map((column) => column.name)
          .sort()
      : []
    if (requiredExcluded.length > 0) {
      warnings.push({ code: 'excluded_column_required', columns: requiredExcluded })
    }
    const lock = lockOf(row)
    const locking = lockStrategy(object, excluded, lock)
    if (locking.problem !== undefined) {
      warnings.push({ code: 'lock_column_invalid', problem: locking.problem })
    }
    let effectiveTemplate = defaultTemplate(object, row.key_column, excluded)
    if (row.display_template !== null) {
      const problem =
        object === undefined
          ? 'unknown_column'
          : checkTemplate(row.display_template, templates(object, excluded))
      if (problem === undefined) effectiveTemplate = row.display_template
      else warnings.push({ code: 'template_invalid' })
    }
    return {
      id: row.id,
      connectionId: row.connection_id,
      objectName: row.object_name,
      objectType: row.object_type,
      ops,
      keyColumn: row.key_column,
      displayTemplate: row.display_template,
      effectiveTemplate,
      apiResource: row.api_resource,
      mcpEnabled: row.mcp_enabled === 1,
      exclusions: exclusions.map((entry) => ({ column: entry.column_name, scope: entry.scope })),
      state: row.state,
      grantedOps: tableOps.filter((op) => granted.has(op)),
      writableColumns: {
        create: writeColumns('INSERT'),
        update: writeColumns('UPDATE'),
      },
      lock,
      lockStrategy: locking.strategy,
      warnings,
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  }

  /** Checks an access definition against the current catalog and returns the values to store. */
  private async validate(
    connectionId: string,
    objectName: string,
    input: UpdateInput,
    existingId: string | undefined,
  ) {
    const snapshot = await this.snapshot(connectionId)
    const object = snapshot.objects.find((entry) => entry.name === objectName)
    if (object === undefined) throw fieldError('objectName', 'not_in_schema')
    const columns = new Set(object.columns.map((column) => column.name))
    let keyColumn = input.keyColumn
    if (object.type === 'table') {
      const [pk] = object.primaryKey
      if (object.primaryKey.length !== 1 || pk === undefined) {
        throw fieldError('objectName', 'primary_key_required')
      }
      if (keyColumn !== null && keyColumn !== pk) throw fieldError('keyColumn', 'invalid')
      keyColumn = pk
    } else {
      if (input.ops.some((op) => op !== 'read')) throw fieldError('ops', 'view_read_only')
      if (keyColumn !== null && !columns.has(keyColumn))
        throw fieldError('keyColumn', 'unknown_column')
    }

    // A stored exclusion may name a column the read user no longer sees: column grants that
    // leave it out hide it from the catalog too (§9.4). New exclusions need a known column.
    const stored = new Set(
      existingId === undefined
        ? []
        : (await this.exclusions([existingId])).map((entry) => entry.column_name),
    )
    const exclusions = new Map<string, 'all' | 'mcp'>()
    input.exclusions.forEach((exclusion, index) => {
      if (!columns.has(exclusion.column) && !stored.has(exclusion.column)) {
        throw fieldError(`exclusions.${index}.column`, 'unknown_column')
      }
      if (exclusion.column === keyColumn && exclusion.scope === 'all') {
        throw fieldError(`exclusions.${index}.column`, 'key_column')
      }
      // `all` is the stronger exclusion and wins over `mcp`.
      if (exclusions.get(exclusion.column) !== 'all')
        exclusions.set(exclusion.column, exclusion.scope)
    })

    if (input.displayTemplate !== null && input.displayTemplate !== '') {
      const rows = await this.rows(connectionId)
      const stored = await this.exclusions(rows.map((row) => row.id))
      const templates = await this.templateScope(connectionId, snapshot, rows, stored)
      const own = new Set(
        [...exclusions].filter(([, scope]) => scope === 'all').map(([column]) => column),
      )
      const problem = checkTemplate(input.displayTemplate, templates(object, own))
      if (problem !== undefined) throw fieldError('displayTemplate', problem)
    }

    const apiResource = input.apiResource ?? defaultResource(objectName)
    let clash = this.deps.db
      .selectFrom('table_access')
      .select('id')
      .where('api_resource', '=', apiResource)
    if (existingId !== undefined) clash = clash.where('id', '!=', existingId)
    if ((await clash.executeTakeFirst()) !== undefined) throw fieldError('apiResource', 'taken')

    // A named lock column must exist; whether it suits shows as a warning (§9.3 may change it).
    const lock = input.lock
    if (lock?.mode === 'column' && !columns.has(lock.column)) {
      throw fieldError('lock.column', 'unknown_column')
    }
    if (lock !== undefined && lock.mode !== 'auto' && object.type === 'view') {
      throw fieldError('lock', 'view_read_only')
    }
    return {
      object,
      keyColumn,
      exclusions,
      lock,
      apiResource,
      displayTemplate:
        input.displayTemplate === null || input.displayTemplate === ''
          ? null
          : input.displayTemplate,
      ops: object.type === 'view' ? (['read'] as TableOp[]) : input.ops,
    }
  }

  private async saveExclusions(
    trx: Kysely<Database>,
    id: string,
    exclusions: Map<string, 'all' | 'mcp'>,
  ): Promise<void> {
    await trx.deleteFrom('column_exclusions').where('table_access_id', '=', id).execute()
    if (exclusions.size === 0) return
    await trx
      .insertInto('column_exclusions')
      .values(
        [...exclusions].map(([column, scope]) => ({
          table_access_id: id,
          column_name: column,
          scope,
        })),
      )
      .execute()
  }

  async create(actor: Actor, input: CreateInput): Promise<TableAccess> {
    const connection = await this.deps.connections.get(input.connectionId)
    const existing = await this.deps.db
      .selectFrom('table_access')
      .select('id')
      .where('connection_id', '=', input.connectionId)
      .where('object_name', '=', input.objectName)
      .executeTakeFirst()
    if (existing !== undefined) throw fieldError('objectName', 'taken')
    const values = await this.validate(input.connectionId, input.objectName, input, undefined)
    const id = uuidv7()
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .insertInto('table_access')
        .values({
          id,
          connection_id: input.connectionId,
          object_name: input.objectName,
          object_type: values.object.type,
          ops: opsToMask(values.ops),
          key_column: values.keyColumn,
          display_template: values.displayTemplate,
          api_resource: values.apiResource,
          mcp_enabled: input.mcpEnabled ? 1 : 0,
          state: 'active',
          ...lockColumns(values.lock ?? { mode: 'auto' }),
          created_at: now,
          updated_at: now,
        })
        .execute()
      await this.saveExclusions(trx, id, values.exclusions)
    })
    await this.deps.audit.record(actor, {
      action: 'table_access.created',
      subject: { kind: 'table_access', id, label: `${connection.name}.${input.objectName}` },
      connectionId: input.connectionId,
      objectName: input.objectName,
      details: {
        ops: values.ops,
        keyColumn: values.keyColumn,
        exclusions: Object.fromEntries(values.exclusions),
        displayTemplate: values.displayTemplate,
        apiResource: values.apiResource,
        mcpEnabled: input.mcpEnabled,
        lock: values.lock ?? { mode: 'auto' },
      },
    })
    this.changed(input.connectionId)
    return this.get(id)
  }

  /**
   * Table access for a table Stashley just created (§17 step 7): ceiling read only, and
   * `pending_grants` until the read user sees it (a catalog read then makes it active). The
   * catalog may not know the table yet, so this skips the checks of `create`. A second call
   * for the same table returns the first one.
   */
  async createForNewTable(
    actor: Actor,
    input: { connectionId: string; objectName: string; keyColumn: string; visible: boolean },
  ): Promise<string> {
    const existing = await this.deps.db
      .selectFrom('table_access')
      .select('id')
      .where('connection_id', '=', input.connectionId)
      .where('object_name', '=', input.objectName)
      .executeTakeFirst()
    if (existing !== undefined) return existing.id
    const taken = new Set(
      (await this.deps.db.selectFrom('table_access').select('api_resource').execute()).map(
        (row) => row.api_resource,
      ),
    )
    const base = defaultResource(input.objectName)
    let apiResource = base
    for (let index = 2; taken.has(apiResource); index++) {
      apiResource = `${base.slice(0, 60)}_${index}`
    }
    const id = uuidv7()
    const now = this.clock()
    const state = input.visible ? 'active' : 'pending_grants'
    await this.deps.db
      .insertInto('table_access')
      .values({
        id,
        connection_id: input.connectionId,
        object_name: input.objectName,
        object_type: 'table',
        ops: opsToMask(['read']),
        key_column: input.keyColumn,
        display_template: null,
        api_resource: apiResource,
        mcp_enabled: 0,
        state,
        ...lockColumns({ mode: 'auto' }),
        created_at: now,
        updated_at: now,
      })
      .execute()
    await this.deps.audit.record(actor, {
      action: 'table_access.created',
      subject: { kind: 'table_access', id, label: input.objectName },
      connectionId: input.connectionId,
      objectName: input.objectName,
      details: { ops: ['read'], keyColumn: input.keyColumn, apiResource, state, newTable: true },
    })
    this.changed(input.connectionId)
    return id
  }

  async update(actor: Actor, id: string, input: UpdateInput): Promise<TableAccess> {
    const before = await this.get(id)
    const values = await this.validate(before.connectionId, before.objectName, input, id)
    // A view's key column is what makes it a unique relation target; relations built on it
    // must go first.
    if (
      before.objectType === 'view' &&
      before.keyColumn !== null &&
      values.keyColumn !== before.keyColumn
    ) {
      const key = before.keyColumn
      const used = await this.deps.db
        .selectFrom('virtual_relations')
        .select('id')
        .where('connection_id', '=', before.connectionId)
        .where((eb) =>
          eb.or([
            eb.and([eb('target_object', '=', before.objectName), eb('target_column', '=', key)]),
            eb.and([
              eb('source_object', '=', before.objectName),
              eb('source_column', '=', key),
              eb('kind', '=', 'one_to_one'),
            ]),
          ]),
        )
        .executeTakeFirst()
      if (used !== undefined) throw fieldError('keyColumn', 'used_by_relation')
    }
    const change: AccessChange = {
      ops: values.ops,
      objectType: values.object.type,
      keyColumn: values.keyColumn,
      apiResource: values.apiResource,
      removed: false,
    }
    const consequences = await this.consequences(before, change, input.confirm)
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .updateTable('table_access')
        .set({
          ops: opsToMask(values.ops),
          key_column: values.keyColumn,
          display_template: values.displayTemplate,
          api_resource: values.apiResource,
          mcp_enabled: input.mcpEnabled ? 1 : 0,
          ...(values.lock !== undefined && lockColumns(values.lock)),
          updated_at: this.clock(),
        })
        .where('id', '=', id)
        .execute()
      await this.saveExclusions(trx, id, values.exclusions)
      for (const dependent of this.dependents) await dependent.apply(trx, before, change)
    })
    const after = await this.get(id)
    const changes: Record<string, [unknown, unknown]> = {}
    for (const field of [
      'ops',
      'keyColumn',
      'displayTemplate',
      'apiResource',
      'mcpEnabled',
      'exclusions',
      'lock',
    ] as const) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
        changes[field] = [before[field], after[field]]
      }
    }
    if (Object.keys(changes).length > 0) {
      await this.deps.audit.record(actor, {
        action: 'table_access.updated',
        subject: { kind: 'table_access', id, label: before.objectName },
        connectionId: before.connectionId,
        objectName: before.objectName,
        changes,
        ...(consequences.length > 0 && { details: { consequences } }),
      })
    }
    this.changed(before.connectionId)
    return after
  }

  async remove(actor: Actor, id: string, options: { confirm?: boolean } = {}): Promise<void> {
    const access = await this.get(id)
    const change: AccessChange = {
      ops: access.ops,
      objectType: access.objectType,
      keyColumn: access.keyColumn,
      apiResource: access.apiResource,
      removed: true,
    }
    const consequences = await this.consequences(access, change, options.confirm)
    await writeTransaction(this.deps.db, async (trx) => {
      for (const dependent of this.dependents) await dependent.apply(trx, access, change)
      await trx.deleteFrom('table_access').where('id', '=', id).execute()
    })
    await this.deps.audit.record(actor, {
      action: 'table_access.deleted',
      subject: { kind: 'table_access', id, label: access.objectName },
      connectionId: access.connectionId,
      objectName: access.objectName,
      ...(consequences.length > 0 && { details: { consequences } }),
    })
    this.changed(access.connectionId)
  }

  async createRelation(actor: Actor, input: z.infer<typeof relationInput>): Promise<Relation> {
    await this.deps.connections.get(input.connectionId)
    const snapshot = await this.snapshot(input.connectionId)
    const objects = new Map(snapshot.objects.map((object) => [object.name, object]))
    const source = objects.get(input.sourceObject)
    const target = objects.get(input.targetObject)
    if (source === undefined) throw fieldError('sourceObject', 'not_in_schema')
    if (target === undefined) throw fieldError('targetObject', 'not_in_schema')
    if (!source.columns.some((column) => column.name === input.sourceColumn)) {
      throw fieldError('sourceColumn', 'unknown_column')
    }
    if (!target.columns.some((column) => column.name === input.targetColumn)) {
      throw fieldError('targetColumn', 'unknown_column')
    }
    const kindOf = (object: CatalogObject, name: string) =>
      object.columns.find((column) => column.name === name)?.kind
    if (
      keyFamily(kindOf(source, input.sourceColumn)) !==
      keyFamily(kindOf(target, input.targetColumn))
    ) {
      throw fieldError('targetColumn', 'type_mismatch')
    }
    const accesses = await this.rows(input.connectionId)
    const viewKey = (name: string) =>
      accesses.find((access) => access.object_name === name)?.key_column ?? null
    if (!uniqueColumns(target, viewKey(target.name)).has(input.targetColumn)) {
      throw fieldError('targetColumn', 'not_unique')
    }
    if (
      input.kind === 'one_to_one' &&
      !uniqueColumns(source, viewKey(source.name)).has(input.sourceColumn)
    ) {
      throw fieldError('sourceColumn', 'not_unique')
    }
    const existing = await this.resolvedRelations(input.connectionId, snapshot)
    if (
      existing.some(
        (relation) =>
          relation.sourceObject === input.sourceObject &&
          relation.sourceColumn === input.sourceColumn &&
          relation.targetObject === input.targetObject,
      )
    ) {
      throw fieldError('sourceColumn', 'duplicate')
    }
    const id = uuidv7()
    await this.deps.db
      .insertInto('virtual_relations')
      .values({
        id,
        connection_id: input.connectionId,
        source_object: input.sourceObject,
        source_column: input.sourceColumn,
        target_object: input.targetObject,
        target_column: input.targetColumn,
        kind: input.kind,
        created_at: this.clock(),
      })
      .execute()
    const label = `${input.sourceObject}.${input.sourceColumn} → ${input.targetObject}.${input.targetColumn}`
    await this.deps.audit.record(actor, {
      action: 'relation.created',
      subject: { kind: 'relation', id, label },
      connectionId: input.connectionId,
      details: { kind: input.kind },
    })
    this.changed(input.connectionId)
    const created = (await this.relations(input.connectionId)).find(
      (relation) => relation.id === id,
    )
    if (created === undefined) throw new AppError('internal_error')
    return created
  }

  async removeRelation(actor: Actor, id: string): Promise<void> {
    const row = await this.deps.db
      .selectFrom('virtual_relations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    await this.deps.db.deleteFrom('virtual_relations').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'relation.deleted',
      subject: {
        kind: 'relation',
        id,
        label: `${row.source_object}.${row.source_column} → ${row.target_object}.${row.target_column}`,
      },
      connectionId: row.connection_id,
    })
    this.changed(row.connection_id)
  }

  private changed(connectionId: string): void {
    this.deps.events?.emit('table-access.changed', { connectionId })
  }
}
