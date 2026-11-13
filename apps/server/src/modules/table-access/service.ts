// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccessWarning,
  CatalogObject,
  CatalogSnapshot,
  GrantReport,
  Relation,
  TableAccess,
  TableOp,
  relationInput,
  tableAccessCreate,
  tableAccessUpdate,
} from '@stashley/shared'
import { tableOps } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, TableAccessTable } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { CatalogService } from '../catalog/service.ts'
import { objectPrivileges } from '../connections/grants.ts'
import type { ConnectionsService } from '../connections/service.ts'
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

function defaultResource(objectName: string): string {
  const base = objectName.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return /^[a-z]/.test(base) ? base.slice(0, 63) : `t_${base}`.slice(0, 63)
}

export class TableAccessService {
  private readonly deps: TableAccessDeps
  private readonly clock: Clock

  constructor(deps: TableAccessDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
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
      if (privileges.has('INSERT')) granted.add('create')
      // Updates and deletes find their row by key, which needs SELECT as well.
      const select = privileges.has('SELECT')
      if (privileges.has('UPDATE') && select) granted.add('update')
      if (privileges.has('DELETE') && select) granted.add('delete')
    }
    const warnings: AccessWarning[] = []
    if (object === undefined || row.state === 'pending_grants')
      warnings.push({ code: 'not_in_schema' })
    const writes = ops.filter((op) => op !== 'read')
    if (writes.length > 0 && !hasWriter) warnings.push({ code: 'no_write_user' })
    // Without a write user, `no_write_user` already covers the write operations.
    const ungranted = ops.filter((op) => !granted.has(op) && (op === 'read' || hasWriter))
    if (ungranted.length > 0) warnings.push({ code: 'ops_without_grant', ops: ungranted })
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

    const exclusions = new Map<string, 'all' | 'mcp'>()
    input.exclusions.forEach((exclusion, index) => {
      if (!columns.has(exclusion.column)) {
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

    return {
      object,
      keyColumn,
      exclusions,
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
      },
    })
    return this.get(id)
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
    await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .updateTable('table_access')
        .set({
          ops: opsToMask(values.ops),
          key_column: values.keyColumn,
          display_template: values.displayTemplate,
          api_resource: values.apiResource,
          mcp_enabled: input.mcpEnabled ? 1 : 0,
          updated_at: this.clock(),
        })
        .where('id', '=', id)
        .execute()
      await this.saveExclusions(trx, id, values.exclusions)
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
      })
    }
    return after
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const access = await this.get(id)
    await this.deps.db.deleteFrom('table_access').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'table_access.deleted',
      subject: { kind: 'table_access', id, label: access.objectName },
      connectionId: access.connectionId,
      objectName: access.objectName,
    })
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
  }
}
