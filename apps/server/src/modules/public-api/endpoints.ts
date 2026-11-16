// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiEndpointBlocker,
  ApiEndpointState,
  ApiOperation,
  ChangeConsequence,
  ImpactItem,
  SchemaDiff,
  TableAccess,
  apiEndpointsUpdate,
} from '@stashley/shared'
import {
  aliasExposesName,
  apiOperationNeeds,
  apiOperations,
  apiOperationsFor,
} from '@stashley/shared'
import type { Kysely } from 'kysely'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { ConnectionsService } from '../connections/service.ts'
import type {
  AccessChange,
  TableAccessDependent,
  TableAccessService,
} from '../table-access/service.ts'

type EndpointsInput = z.infer<typeof apiEndpointsUpdate>

const order = (operations: Iterable<ApiOperation>) => {
  const set = new Set(operations)
  return apiOperations.filter((operation) => set.has(operation))
}

export function isApiOperation(value: string): value is ApiOperation {
  return (apiOperations as readonly string[]).includes(value)
}

/** Why a table access cannot serve endpoints, from its state, key and alias (E14). */
export function endpointBlockers(access: TableAccess): ApiEndpointBlocker[] {
  const blockers: ApiEndpointBlocker[] = []
  if (aliasExposesName(access.apiResource, access.objectName)) blockers.push('alias_is_object_name')
  if (access.objectType === 'table' && access.keyColumn === null) blockers.push('no_single_key')
  if (
    access.state !== 'active' ||
    access.warnings.some((warning) => warning.code === 'not_in_schema')
  ) {
    blockers.push('not_active')
  }
  return blockers
}

/**
 * Endpoints of the public API (§16): admins enable single operations per table access, only
 * within its ceiling. Disabling an endpoint or lowering a ceiling deletes the endpoints and
 * token grants it takes away, after the admin confirmed the list (E15).
 */
export class ApiEndpoints implements TableAccessDependent {
  private readonly deps: {
    db: Kysely<Database>
    tableAccess: TableAccessService
    connections: ConnectionsService
    audit: AuditLog
    events: EventBus
  }
  private readonly clock: Clock

  constructor(deps: ApiEndpoints['deps'] & { clock?: Clock }) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  private async enabledOf(
    tableAccessId: string,
    db: Kysely<Database> = this.deps.db,
  ): Promise<ApiOperation[]> {
    const rows = await db
      .selectFrom('api_endpoints')
      .select('operation')
      .where('table_access_id', '=', tableAccessId)
      .execute()
    return order(rows.map((row) => row.operation).filter(isApiOperation))
  }

  private async grantsOf(
    tableAccessId: string,
    operations: readonly ApiOperation[],
  ): Promise<ChangeConsequence[]> {
    if (operations.length === 0) return []
    const rows = await this.deps.db
      .selectFrom('api_token_grants')
      .innerJoin('api_tokens', 'api_tokens.id', 'api_token_grants.token_id')
      .select(['api_tokens.id', 'api_tokens.name', 'api_token_grants.operation'])
      .where('api_token_grants.table_access_id', '=', tableAccessId)
      .where('api_token_grants.operation', 'in', [...operations])
      .where('api_tokens.revoked_at', 'is', null)
      .orderBy('api_tokens.name')
      .execute()
    return rows
      .filter((row) => isApiOperation(row.operation))
      .map((row) => ({
        kind: 'api_grant_removed' as const,
        tokenId: row.id,
        tokenName: row.name,
        operation: row.operation as ApiOperation,
      }))
  }

  private state(
    access: TableAccess,
    connectionName: string,
    enabled: ApiOperation[],
  ): ApiEndpointState {
    const available = apiOperationsFor({
      objectType: access.objectType,
      keyColumn: access.keyColumn,
      ceiling: access.ops,
    })
    return {
      tableAccessId: access.id,
      connectionId: access.connectionId,
      connectionName,
      objectName: access.objectName,
      objectType: access.objectType,
      apiResource: access.apiResource,
      ceiling: access.ops,
      available,
      enabled,
      withheld: enabled.filter(
        (operation) =>
          !available.includes(operation) ||
          !apiOperationNeeds[operation].every((op) => access.grantedOps.includes(op)),
      ),
      blockers: endpointBlockers(access),
    }
  }

  /** Every table access with its endpoints, by connection and object name. */
  async list(): Promise<ApiEndpointState[]> {
    const rows = await this.deps.db
      .selectFrom('api_endpoints')
      .select(['table_access_id', 'operation'])
      .execute()
    const enabled = new Map<string, ApiOperation[]>()
    for (const row of rows) {
      if (!isApiOperation(row.operation)) continue
      enabled.set(row.table_access_id, [...(enabled.get(row.table_access_id) ?? []), row.operation])
    }
    const states: ApiEndpointState[] = []
    for (const connection of await this.deps.connections.list()) {
      for (const access of await this.deps.tableAccess.list(connection.id)) {
        states.push(this.state(access, connection.name, order(enabled.get(access.id) ?? [])))
      }
    }
    return states
  }

  async get(tableAccessId: string): Promise<ApiEndpointState> {
    const access = await this.deps.tableAccess.get(tableAccessId)
    const connection = await this.deps.connections.get(access.connectionId)
    return this.state(access, connection.name, await this.enabledOf(tableAccessId))
  }

  async update(
    actor: Actor,
    tableAccessId: string,
    input: EndpointsInput,
  ): Promise<ApiEndpointState> {
    const access = await this.deps.tableAccess.get(tableAccessId)
    const before = await this.enabledOf(tableAccessId)
    const wanted = order(input.operations)
    const current = this.state(access, '', before)
    // Operations beyond the ceiling cannot be enabled in the first place (§16).
    wanted.forEach((operation) => {
      if (!before.includes(operation) && !current.available.includes(operation)) {
        throw new AppError('validation_failed', {
          errors: [{ field: 'operations', code: 'not_available', params: { operation } }],
        })
      }
    })
    const added = wanted.filter((operation) => !before.includes(operation))
    if (added.length > 0 && current.blockers.length > 0) {
      throw fieldError('operations', current.blockers[0] as string)
    }
    const removed = before.filter((operation) => !wanted.includes(operation))
    const consequences = await this.grantsOf(tableAccessId, removed)
    if (consequences.length > 0 && input.confirm !== true) {
      throw new AppError('confirmation_required', { consequences })
    }
    if (added.length === 0 && removed.length === 0) return this.get(tableAccessId)
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      await this.remove(trx, tableAccessId, removed)
      if (added.length > 0) {
        await trx
          .insertInto('api_endpoints')
          .values(
            added.map((operation) => ({
              table_access_id: tableAccessId,
              operation,
              enabled_by: actor.id,
              enabled_at: now,
            })),
          )
          .execute()
      }
    })
    await this.deps.audit.record(actor, {
      action: 'api_endpoint.updated',
      subject: { kind: 'api_endpoint', id: tableAccessId, label: access.apiResource },
      connectionId: access.connectionId,
      objectName: access.objectName,
      changes: { operations: [before, wanted] },
      ...(consequences.length > 0 && { details: { consequences } }),
    })
    this.deps.events.emit('api.changed', {})
    return this.get(tableAccessId)
  }

  /** Deletes endpoints and the token grants on them. */
  private async remove(
    trx: Kysely<Database>,
    tableAccessId: string,
    operations: readonly ApiOperation[],
  ): Promise<void> {
    if (operations.length === 0) return
    await trx
      .deleteFrom('api_token_grants')
      .where('table_access_id', '=', tableAccessId)
      .where('operation', 'in', [...operations])
      .execute()
    await trx
      .deleteFrom('api_endpoints')
      .where('table_access_id', '=', tableAccessId)
      .where('operation', 'in', [...operations])
      .execute()
  }

  /** Enabled endpoints a change of the table access takes away. */
  private async lost(
    before: TableAccess,
    change: AccessChange,
    db: Kysely<Database> = this.deps.db,
  ): Promise<ApiOperation[]> {
    const enabled = await this.enabledOf(before.id, db)
    if (change.removed) return enabled
    const available = apiOperationsFor({
      objectType: change.objectType,
      keyColumn: change.keyColumn,
      ceiling: change.ops,
    })
    return enabled.filter((operation) => !available.includes(operation))
  }

  // Table access dependent (E15)

  async consequences(before: TableAccess, change: AccessChange): Promise<ChangeConsequence[]> {
    const enabled = await this.enabledOf(before.id)
    const lost = await this.lost(before, change)
    const kept = enabled.filter((operation) => !lost.includes(operation))
    const consequences: ChangeConsequence[] = [
      ...lost.map((operation) => ({ kind: 'api_endpoint_removed' as const, operation })),
      ...(await this.grantsOf(before.id, lost)),
    ]
    if (!change.removed && kept.length > 0 && change.apiResource !== before.apiResource) {
      // Enabled endpoints never expose the table name (E14).
      if (aliasExposesName(change.apiResource, before.objectName)) {
        throw fieldError('apiResource', 'alias_is_object_name')
      }
      consequences.push({
        kind: 'api_alias_changed',
        from: before.apiResource,
        to: change.apiResource,
      })
    }
    return consequences
  }

  async apply(trx: Kysely<Database>, before: TableAccess, change: AccessChange): Promise<void> {
    // Inside the transaction every read goes through it; the store has one connection.
    const lost = await this.lost(before, change, trx)
    await this.remove(trx, before.id, lost)
    if (lost.length > 0 || change.apiResource !== before.apiResource) {
      this.deps.events.emit('api.changed', {})
    }
  }

  /**
   * Enabled endpoints a schema change affects (§ Schema-Änderungen): every column change
   * changes the public contract of the resource, new columns included.
   */
  async impact(connectionId: string, diff: SchemaDiff): Promise<ImpactItem[]> {
    const rows = await this.deps.db
      .selectFrom('api_endpoints')
      .innerJoin('table_access', 'table_access.id', 'api_endpoints.table_access_id')
      .select(['table_access.id', 'table_access.object_name', 'table_access.api_resource'])
      .where('table_access.connection_id', '=', connectionId)
      .distinct()
      .execute()
    const removed = new Set(diff.removedObjects)
    const changes = new Map(diff.changedObjects.map((change) => [change.object, change]))
    const items: ImpactItem[] = []
    for (const row of rows) {
      const label = `${row.api_resource} (${row.object_name})`
      const item = (reason: ImpactItem['reason']) =>
        items.push({ kind: 'api_endpoint', id: row.id, label, reason })
      if (removed.has(row.object_name)) {
        item('object_removed')
        continue
      }
      const change = changes.get(row.object_name)
      if (change === undefined) continue
      if (change.typeChanged !== undefined) item('type_changed')
      else if (change.keysChanged) item('key_changed')
      else if (change.removedColumns.length > 0) item('column_removed')
      else if (change.changedColumns.length > 0) item('column_changed')
      else if (change.addedColumns.length > 0) item('column_added')
    }
    return items
  }
}
