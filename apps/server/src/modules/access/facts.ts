// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, Engine, OpMask } from '@stashley/shared'
import { toMask } from '@stashley/shared'
import type { Kysely } from 'kysely'
import type { Database } from '../../metastore/schema.ts'
import type { EventBus } from '../../platform/events.ts'
import type { CatalogService } from '../catalog/service.ts'
import type { ConnectionsService } from '../connections/service.ts'
import type { ModelAccess, ModelRelation } from '../execution/sql/table-model.ts'
import type { TableAccessService } from '../table-access/service.ts'

/** Access facts of one exposed object (§8.1): ceiling, exclusions, grants, templates. */
export interface ObjectFacts extends ModelAccess {
  tableAccessId: string
  objectName: string
  objectType: 'table' | 'view'
  /** Operations the database grants allow (`dbGrants` in §8.3). */
  dbGrants: OpMask
  /** Columns excluded for MCP only, on top of `excluded`. */
  mcpExcluded: ReadonlySet<string>
  mcpEnabled: boolean
}

export interface ConnectionFacts {
  connectionId: string
  engine: Engine
  database: string
  timeZone: string
  catalog: ReadonlyMap<string, CatalogObject>
  relations: readonly ModelRelation[]
  objects: ReadonlyMap<string, ObjectFacts>
  access: (object: string) => ObjectFacts | undefined
}

/**
 * Access facts held in memory and dropped through events (§8.4): table access, grant
 * reports and the catalog of each connection. A change takes effect on the next request.
 */
export class AccessFacts {
  private readonly deps: {
    db: Kysely<Database>
    connections: ConnectionsService
    catalog: CatalogService
    tableAccess: TableAccessService
  }
  private readonly byConnection = new Map<string, Promise<ConnectionFacts>>()
  private tableIndex: Promise<Map<string, { connectionId: string; objectName: string }>> | undefined
  /** Increases with every change; compiled pages of an older generation are rebuilt. */
  generation = 0

  constructor(deps: AccessFacts['deps'] & { events: EventBus }) {
    this.deps = deps
    const drop = ({ connectionId }: { connectionId: string }) => {
      this.byConnection.delete(connectionId)
      this.tableIndex = undefined
      this.generation++
    }
    deps.events.on('table-access.changed', drop)
    deps.events.on('catalog.refreshed', drop)
    deps.events.on('connection.changed', drop)
  }

  connection(connectionId: string): Promise<ConnectionFacts> {
    let facts = this.byConnection.get(connectionId)
    if (facts === undefined) {
      facts = this.load(connectionId)
      facts.catch(() => this.byConnection.delete(connectionId))
      this.byConnection.set(connectionId, facts)
    }
    return facts
  }

  private async load(connectionId: string): Promise<ConnectionFacts> {
    const connection = await this.deps.connections.get(connectionId)
    const snapshot = await this.deps.catalog.current(connectionId)
    const accesses = await this.deps.tableAccess.list(connectionId)
    const relations = await this.deps.tableAccess.relations(connectionId)
    const objects = new Map<string, ObjectFacts>()
    for (const access of accesses) {
      objects.set(access.objectName, {
        tableAccessId: access.id,
        objectName: access.objectName,
        objectType: access.objectType,
        ceiling: toMask(access.ops),
        dbGrants: toMask(access.grantedOps),
        excluded: new Set(
          access.exclusions.filter((entry) => entry.scope === 'all').map((entry) => entry.column),
        ),
        mcpExcluded: new Set(access.exclusions.map((entry) => entry.column)),
        mcpEnabled: access.mcpEnabled,
        active: access.state === 'active',
        keyColumn: access.keyColumn,
        effectiveTemplate: access.effectiveTemplate,
      })
    }
    return {
      connectionId,
      engine: connection.engine ?? 'mysql',
      database: connection.databaseName,
      timeZone: connection.timezone,
      catalog: new Map((snapshot?.objects ?? []).map((object) => [object.name, object])),
      relations: relations.map((relation) => ({
        sourceObject: relation.sourceObject,
        sourceColumn: relation.sourceColumn,
        targetObject: relation.targetObject,
        targetColumn: relation.targetColumn,
      })),
      objects,
      access: (name) => objects.get(name),
    }
  }

  /** The connection and object of a table access ID. */
  async table(
    tableAccessId: string,
  ): Promise<{ connection: ConnectionFacts; object: ObjectFacts } | undefined> {
    this.tableIndex ??= this.deps.db
      .selectFrom('table_access')
      .select(['id', 'connection_id', 'object_name'])
      .execute()
      .then(
        (rows) =>
          new Map(
            rows.map((row) => [
              row.id,
              { connectionId: row.connection_id, objectName: row.object_name },
            ]),
          ),
      )
    const entry = (await this.tableIndex).get(tableAccessId)
    if (entry === undefined) return undefined
    const connection = await this.connection(entry.connectionId)
    const object = connection.objects.get(entry.objectName)
    return object === undefined ? undefined : { connection, object }
  }

  /** Tables behind objects: views expand to their base tables (§12). */
  static dependencies(
    connection: ConnectionFacts,
    objects: readonly string[],
  ): { tables: string[]; allTables: boolean } {
    const tables = new Set<string>()
    let allTables = false
    for (const name of objects) {
      tables.add(name)
      const object = connection.catalog.get(name)
      if (object?.type !== 'view') continue
      if (object.dependenciesKnown === false) allTables = true
      for (const table of object.baseTables ?? []) tables.add(table)
    }
    return { tables: [...tables].sort(), allTables }
  }
}
