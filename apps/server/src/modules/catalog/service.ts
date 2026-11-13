// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import type {
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
import type { Database, SchemaSnapshotsTable } from '../../metastore/schema.ts'
import { isoOrNull, systemClock, type Clock } from '../../platform/clock.ts'
import { AppError } from '../../platform/http/problem.ts'
import { systemActor, type Actor, type AuditLog } from '../audit/audit-log.ts'
import type { ConnectionsService } from '../connections/service.ts'
import { diffSnapshots, isEmptyDiff } from './diff.ts'
import { impactOf } from './impact.ts'
import { introspect } from './introspect.ts'

/** Snapshots kept per connection; older ones are removed after a refresh. */
const keptSnapshots = 20

export interface CatalogDeps {
  db: Kysely<Database>
  connections: ConnectionsService
  audit: AuditLog
  log: FastifyBaseLogger
  clock?: Clock
}

/** Hash over the structure only; row estimates change all the time. */
function contentHash(objects: CatalogObject[]): string {
  const structure = objects.map(({ rowEstimate: _ignored, ...rest }) => rest)
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex')
}

export class CatalogService {
  private readonly deps: CatalogDeps
  private readonly clock: Clock

  constructor(deps: CatalogDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
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
    return impactOf(diff, {
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
  }

  /**
   * Reads the schema again and stores a new snapshot if it changed. A scheduled check that
   * finds changes records a drift for admins (§9.3).
   */
  async refresh(
    actor: Actor,
    connectionId: string,
    trigger: SchemaSnapshotsTable['trigger'],
  ): Promise<SchemaRefreshResult> {
    const target = await this.deps.connections.resolve(connectionId)
    const objects = (
      await this.deps.connections.withReader(connectionId, (session) =>
        introspect(session, target.spec.database),
      )
    ).sort((a, b) => a.name.localeCompare(b.name))
    const hash = contentHash(objects)
    const previous = await this.latest(connectionId)
    const empty: SchemaDiff = { addedObjects: [], removedObjects: [], changedObjects: [] }
    if (previous?.content_hash === hash) {
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
    const db = this.deps.db
    await db
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
      await db
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
    await this.prune(connectionId)
    await this.updateAccessStates(connectionId, objects)
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

  /** Objects that vanished from the read user's view wait for grants (or were dropped). */
  private async updateAccessStates(connectionId: string, objects: CatalogObject[]): Promise<void> {
    const names = objects.map((object) => object.name)
    const db = this.deps.db
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

  private async prune(connectionId: string): Promise<void> {
    const keep = await this.deps.db
      .selectFrom('schema_snapshots')
      .select('id')
      .where('connection_id', '=', connectionId)
      .orderBy('captured_at', 'desc')
      .orderBy('id', 'desc')
      .limit(keptSnapshots)
      .execute()
    await this.deps.db
      .deleteFrom('schema_snapshots')
      .where('connection_id', '=', connectionId)
      .where(
        'id',
        'not in',
        keep.map((row) => row.id),
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
