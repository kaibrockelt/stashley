// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import type {
  ChangeConsequence,
  TableOp,
  CatalogObject,
  CatalogSnapshot,
  ImpactItem,
  SchemaDiff,
  SchemaDrift,
  SchemaRefreshResult,
} from '@stashley/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, SchemaSnapshotsTable } from '../../metastore/schema.ts'
import { isoOrNull, systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { systemActor, type Actor, type AuditInput, type AuditLog } from '../audit/audit-log.ts'
import type { ConnectionsService } from '../connections/service.ts'
import { maskToOps, opsToMask } from '../table-access/service.ts'
import { diffSnapshots, isEmptyDiff } from './diff.ts'
import { impactOf } from './impact.ts'
import { introspect } from './introspect.ts'

/** Snapshots kept per connection; older ones are removed after a refresh. */
const keptSnapshots = 20
const readOp = opsToMask(['read'])

export interface CatalogDeps {
  db: Kysely<Database>
  connections: ConnectionsService
  audit: AuditLog
  log: FastifyBaseLogger
  clock?: Clock
  events?: EventBus
}

/** Adds affected items of other modules (queries, components) to a schema impact report. */
export type ImpactProvider = (connectionId: string, diff: SchemaDiff) => Promise<ImpactItem[]>

/**
 * Follows a table access whose object changed type (table ↔ view) in the catalog's own
 * transaction: modules built on table access drop what the new form cannot serve, so raising
 * the ceiling later reopens nothing (E15). Returns what it took away, for the audit entry.
 */
export type TypeChangeHook = (
  trx: Kysely<Database>,
  change: {
    tableAccessId: string
    ops: TableOp[]
    objectType: 'table' | 'view'
    keyColumn: string | null
  },
) => Promise<ChangeConsequence[]>

/** The failure code of a schema read: the read user's connection failure, or `failed`. */
function failureOf(error: unknown): string {
  if (error instanceof AppError && error.code === 'connection_failed') {
    return error.errors?.[0]?.code ?? 'failed'
  }
  return 'failed'
}

/** Hash over the structure only; row estimates change all the time. */
function contentHash(objects: CatalogObject[]): string {
  const structure = objects.map(({ rowEstimate: _ignored, ...rest }) => rest)
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex')
}

export class CatalogService {
  private readonly deps: CatalogDeps
  private readonly clock: Clock
  private readonly impactProviders: ImpactProvider[] = []
  private readonly typeChangeHooks: TypeChangeHook[] = []

  constructor(deps: CatalogDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  addImpactProvider(provider: ImpactProvider): void {
    this.impactProviders.push(provider)
  }

  addTypeChangeHook(hook: TypeChangeHook): void {
    this.typeChangeHooks.push(hook)
  }

  private async latest(connectionId: string): Promise<SchemaSnapshotsTable | undefined> {
    return this.deps.db
      .selectFrom('schema_snapshots')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .orderBy('captured_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
  }

  /** The current catalog of a connection: its latest snapshot. */
  async current(connectionId: string): Promise<CatalogSnapshot | undefined> {
    const row = await this.latest(connectionId)
    if (row === undefined) return undefined
    return {
      connectionId,
      capturedAt: new Date(row.captured_at).toISOString(),
      objects: JSON.parse(row.content) as CatalogObject[],
    }
  }

  private async impact(connectionId: string, diff: SchemaDiff): Promise<ImpactItem[]> {
    const db = this.deps.db
    const accesses = await db
      .selectFrom('table_access')
      .select(['id', 'object_name', 'key_column', 'display_template'])
      .where('connection_id', '=', connectionId)
      .execute()
    const exclusions = await db
      .selectFrom('column_exclusions')
      .innerJoin('table_access', 'table_access.id', 'column_exclusions.table_access_id')
      .select([
        'column_exclusions.table_access_id as id',
        'column_exclusions.column_name as column',
      ])
      .where('table_access.connection_id', '=', connectionId)
      .execute()
    const relations = await db
      .selectFrom('virtual_relations')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .execute()
    const own = impactOf(diff, {
      accesses: accesses.map((access) => ({
        id: access.id,
        objectName: access.object_name,
        keyColumn: access.key_column,
        displayTemplate: access.display_template,
        exclusions: exclusions
          .filter((entry) => entry.id === access.id)
          .map((entry) => entry.column),
      })),
      relations: relations.map((relation) => ({
        id: relation.id,
        sourceObject: relation.source_object,
        sourceColumn: relation.source_column,
        targetObject: relation.target_object,
        targetColumn: relation.target_column,
      })),
    })
    const others = await Promise.all(
      this.impactProviders.map((provider) => provider(connectionId, diff)),
    )
    return [...own, ...others.flat()]
  }

  /**
   * Reads the schema again and stores a new snapshot if it changed. A scheduled check that
   * finds changes records a drift for admins (§9.3). The outcome is kept on the connection,
   * so a daily check that cannot reach the database shows up there.
   */
  async refresh(
    actor: Actor,
    connectionId: string,
    trigger: SchemaSnapshotsTable['trigger'],
  ): Promise<SchemaRefreshResult> {
    const target = await this.deps.connections.resolve(connectionId)
    let objects: CatalogObject[]
    try {
      objects = (
        await this.deps.connections.withReader(connectionId, (session) =>
          introspect(session, target.spec.database),
        )
      ).sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      await this.markChecked(this.deps.db, connectionId, failureOf(error))
      throw error
    }
    const hash = contentHash(objects)
    const previous = await this.latest(connectionId)
    const empty: SchemaDiff = { addedObjects: [], removedObjects: [], changedObjects: [] }
    if (previous?.content_hash === hash) {
      await this.markChecked(this.deps.db, connectionId, null)
      return {
        changed: false,
        capturedAt: new Date(previous.captured_at).toISOString(),
        diff: empty,
        impact: [],
      }
    }
    const diff = diffSnapshots(
      previous === undefined ? [] : (JSON.parse(previous.content) as CatalogObject[]),
      objects,
    )
    const impact = await this.impact(connectionId, diff)
    const now = this.clock()
    const snapshotId = uuidv7()
    // One transaction, so a snapshot never exists without its drift and access states.
    const typeChanges = await writeTransaction(this.deps.db, async (trx) => {
      await trx
        .insertInto('schema_snapshots')
        .values({
          id: snapshotId,
          connection_id: connectionId,
          captured_at: now,
          content_hash: hash,
          content: JSON.stringify(objects),
          trigger,
        })
        .execute()
      if (trigger === 'scheduled' && previous !== undefined && !isEmptyDiff(diff)) {
        await trx
          .insertInto('schema_drifts')
          .values({
            id: uuidv7(),
            connection_id: connectionId,
            snapshot_id: snapshotId,
            detected_at: now,
            diff: JSON.stringify({ diff, impact }),
            acknowledged_at: null,
            acknowledged_by: null,
          })
          .execute()
      }
      await this.prune(trx, connectionId)
      await this.updateAccessStates(trx, connectionId, objects)
      await this.markChecked(trx, connectionId, null)
      return this.followTypeChanges(trx, connectionId, objects)
    })
    for (const change of typeChanges) await this.deps.audit.record(actor, change)
    this.deps.events?.emit('catalog.refreshed', { connectionId })
    if (typeChanges.length > 0) this.deps.events?.emit('table-access.changed', { connectionId })
    await this.deps.audit.record(actor, {
      action: 'connection.schema_refreshed',
      subject: { kind: 'connection', id: connectionId, label: target.row.name },
      connectionId,
      details: {
        trigger,
        added: diff.addedObjects.length,
        removed: diff.removedObjects,
        changed: diff.changedObjects.map((change) => change.object),
        impact: impact.length,
      },
    })
    return { changed: true, capturedAt: new Date(now).toISOString(), diff, impact }
  }

  private async markChecked(
    db: Kysely<Database>,
    connectionId: string,
    failure: string | null,
  ): Promise<void> {
    await db
      .updateTable('connections')
      .set({ schema_checked_at: this.clock(), schema_check_failure: failure })
      .where('id', '=', connectionId)
      .execute()
  }

  /**
   * An exposed table replaced by a view of the same name (or the reverse) takes the new type.
   * A view is always read-only, so its ceiling drops to `read`; a former view gets the
   * table's single-column primary key as key column, if it has one (§ Obergrenzen).
   */
  private async followTypeChanges(
    db: Kysely<Database>,
    connectionId: string,
    objects: CatalogObject[],
  ): Promise<AuditInput[]> {
    const byName = new Map(objects.map((object) => [object.name, object]))
    const audit: AuditInput[] = []
    const accesses = await db
      .selectFrom('table_access')
      .select(['id', 'object_name', 'object_type', 'ops', 'key_column'])
      .where('connection_id', '=', connectionId)
      .execute()
    for (const access of accesses) {
      const object = byName.get(access.object_name)
      if (object === undefined || object.type === access.object_type) continue
      const [pk] = object.primaryKey
      const next = {
        object_type: object.type,
        ops: object.type === 'view' ? access.ops & readOp : access.ops,
        key_column:
          object.type === 'view'
            ? access.key_column
            : object.primaryKey.length === 1 && pk !== undefined
              ? pk
              : null,
        updated_at: this.clock(),
      }
      await db.updateTable('table_access').set(next).where('id', '=', access.id).execute()
      const consequences: ChangeConsequence[] = []
      for (const hook of this.typeChangeHooks) {
        consequences.push(
          ...(await hook(db, {
            tableAccessId: access.id,
            ops: maskToOps(next.ops),
            objectType: next.object_type,
            keyColumn: next.key_column,
          })),
        )
      }
      audit.push({
        action: 'table_access.type_changed',
        subject: { kind: 'table_access', id: access.id, label: access.object_name },
        connectionId,
        objectName: access.object_name,
        changes: {
          objectType: [access.object_type, next.object_type],
          ...(next.ops !== access.ops && { ops: [maskToOps(access.ops), maskToOps(next.ops)] }),
          ...(next.key_column !== access.key_column && {
            keyColumn: [access.key_column, next.key_column],
          }),
        },
        ...(consequences.length > 0 && { details: { consequences } }),
      })
    }
    return audit
  }

  /** Objects that vanished from the read user's view wait for grants (or were dropped). */
  private async updateAccessStates(
    db: Kysely<Database>,
    connectionId: string,
    objects: CatalogObject[],
  ): Promise<void> {
    const names = objects.map((object) => object.name)
    if (names.length === 0) {
      await db
        .updateTable('table_access')
        .set({ state: 'pending_grants' })
        .where('connection_id', '=', connectionId)
        .execute()
      return
    }
    await db
      .updateTable('table_access')
      .set({ state: 'pending_grants' })
      .where('connection_id', '=', connectionId)
      .where('object_name', 'not in', names)
      .execute()
    await db
      .updateTable('table_access')
      .set({ state: 'active' })
      .where('connection_id', '=', connectionId)
      .where('object_name', 'in', names)
      .execute()
  }

  /**
   * Keeps the latest snapshots and every snapshot an unacknowledged drift points to; deleting
   * a snapshot deletes its drifts, and those must stay until an admin has seen them.
   */
  private async prune(db: Kysely<Database>, connectionId: string): Promise<void> {
    const latest = await db
      .selectFrom('schema_snapshots')
      .select('id')
      .where('connection_id', '=', connectionId)
      .orderBy('captured_at', 'desc')
      .orderBy('id', 'desc')
      .limit(keptSnapshots)
      .execute()
    const open = await db
      .selectFrom('schema_drifts')
      .select('snapshot_id as id')
      .where('connection_id', '=', connectionId)
      .where('acknowledged_at', 'is', null)
      .execute()
    await db
      .deleteFrom('schema_snapshots')
      .where('connection_id', '=', connectionId)
      .where(
        'id',
        'not in',
        [...latest, ...open].map((row) => row.id),
      )
      .execute()
  }

  async drifts(connectionId: string): Promise<SchemaDrift[]> {
    const rows = await this.deps.db
      .selectFrom('schema_drifts')
      .leftJoin('users', 'users.id', 'schema_drifts.acknowledged_by')
      .select([
        'schema_drifts.id',
        'schema_drifts.detected_at',
        'schema_drifts.diff',
        'schema_drifts.acknowledged_at',
        'users.email as acknowledged_by',
      ])
      .where('schema_drifts.connection_id', '=', connectionId)
      .orderBy('schema_drifts.detected_at', 'desc')
      .limit(50)
      .execute()
    return rows.map((row) => {
      const content = JSON.parse(row.diff) as { diff: SchemaDiff; impact: ImpactItem[] }
      return {
        id: row.id,
        detectedAt: new Date(row.detected_at).toISOString(),
        diff: content.diff,
        impact: content.impact,
        acknowledgedAt: isoOrNull(row.acknowledged_at),
        acknowledgedBy: row.acknowledged_by ?? null,
      }
    })
  }

  async acknowledge(actor: Actor, connectionId: string, driftId: string): Promise<void> {
    const result = await this.deps.db
      .updateTable('schema_drifts')
      .set({ acknowledged_at: this.clock(), acknowledged_by: actor.id })
      .where('id', '=', driftId)
      .where('connection_id', '=', connectionId)
      .where('acknowledged_at', 'is', null)
      .executeTakeFirst()
    if (Number(result.numUpdatedRows) === 0) throw new AppError('not_found')
    await this.deps.audit.record(actor, {
      action: 'connection.drift_acknowledged',
      subject: { kind: 'connection', id: connectionId, label: null },
      connectionId,
      details: { driftId },
    })
  }

  /** Daily job: compares every connection's schema with its stored snapshot. */
  async checkAll(): Promise<void> {
    const connections = await this.deps.db.selectFrom('connections').select('id').execute()
    for (const { id } of connections) {
      try {
        await this.refresh(systemActor, id, 'scheduled')
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'internal_error'
        this.deps.log.warn({ connectionId: id, code }, 'scheduled schema check failed')
      }
    }
  }
}
