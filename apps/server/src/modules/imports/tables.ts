// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { NewTableDefinition, NewTableOutcome } from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'
import type { TargetSession, TargetUser } from '../../target/pools.ts'
import type { TargetPools } from '../../target/pools.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { CatalogService } from '../catalog/service.ts'
import { objectPrivileges } from '../connections/grants.ts'
import type { ConnectionsService, ResolvedTarget } from '../connections/service.ts'
import { translateWriteError, writeErrno } from '../execution/write-errors.ts'
import { quoteAccount } from '../table-access/user-scope.ts'
import type { TableAccessService } from '../table-access/service.ts'
import { createTableStatement } from './ddl.ts'

/**
 * Creating tables (§17 step 7, E28), for the CSV import and the table designer: `CREATE
 * TABLE` through the schema user, then a catalog read, table access with ceiling read in
 * `pending_grants` until the read user sees the table, and the `GRANT` statements Stashley's
 * users still need. The schema user has no `DROP`: a created table stays, also when a later
 * step fails.
 */
export class TableCreator {
  private readonly deps: {
    connections: ConnectionsService
    pools: TargetPools
    catalog: CatalogService
    tableAccess: TableAccessService
    audit: AuditLog
    log: { warn: (object: object, message: string) => void }
  }

  constructor(deps: TableCreator['deps']) {
    this.deps = deps
  }

  /** Object names the catalog knows; a name only the database knows still fails at 1050. */
  async taken(connectionId: string): Promise<string[]> {
    const snapshot = await this.deps.catalog.current(connectionId)
    return (snapshot?.objects ?? []).map((object) => object.name)
  }

  /** The connection's schema user; without one no table can be created. */
  async schemaUser(connectionId: string): Promise<{ target: ResolvedTarget; user: TargetUser }> {
    const target = await this.deps.connections.resolve(connectionId)
    const user = target.users.schema
    if (user === undefined) {
      throw new AppError('validation_failed', {
        errors: [{ field: 'connectionId', code: 'no_schema_user' }],
      })
    }
    return { target, user }
  }

  /** Runs work in one session of the schema user, with strict SQL modes for its writes. */
  async withSchemaUser<T>(
    connectionId: string,
    work: (session: TargetSession) => Promise<T>,
  ): Promise<T> {
    const { target, user } = await this.schemaUser(connectionId)
    return this.deps.pools.run(connectionId, target.spec, user, async (session) => {
      // Values that do not fit must fail, not be cut, as on the write pool (§9.2).
      await session.query(
        "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')",
      )
      return work(session)
    })
  }

  /**
   * `CREATE TABLE` through the schema user; audited with the statement as `table.created`.
   * DDL commits implicitly, so callers run it only after a passed dry run.
   */
  async create(
    actor: Actor,
    definition: NewTableDefinition,
    context: { sourceCount?: number | undefined; importId?: string },
  ): Promise<string> {
    const ddl = createTableStatement(definition, {
      taken: await this.taken(definition.connectionId),
      sourceCount: context.sourceCount,
    })
    try {
      await this.withSchemaUser(definition.connectionId, (session) => session.query(ddl))
    } catch (error) {
      if (writeErrno(error) === 1050) {
        throw new AppError('validation_failed', { errors: [{ field: 'name', code: 'taken' }] })
      }
      throw translateWriteError(error)
    }
    await this.deps.audit.record(actor, {
      action: 'table.created',
      subject: { kind: 'table', id: definition.name, label: definition.name },
      connectionId: definition.connectionId,
      objectName: definition.name,
      details: { ddl, ...(context.importId !== undefined && { importId: context.importId }) },
    })
    return ddl
  }

  /**
   * After the table exists: read the catalog and the grants again, create its table access
   * (ceiling read) and list the statements the read user still needs. Each step is best
   * effort; what fails shows as missing grants and can be checked again later.
   */
  async finish(
    actor: Actor,
    definition: NewTableDefinition,
    ddl: string,
  ): Promise<NewTableOutcome> {
    const connectionId = definition.connectionId
    try {
      await this.deps.connections.recheckGrants(actor, connectionId)
    } catch (error) {
      this.deps.log.warn({ err: error, connectionId }, 'grants not checked after creating a table')
    }
    try {
      await this.deps.catalog.refresh(actor, connectionId, 'import')
    } catch (error) {
      this.deps.log.warn({ err: error, connectionId }, 'schema not read after creating a table')
    }
    const visible = (await this.taken(connectionId)).includes(definition.name)
    const key = definition.primaryKey
    const tableAccessId = await this.deps.tableAccess.createForNewTable(actor, {
      connectionId,
      objectName: definition.name,
      keyColumn: key.kind === 'added' ? key.name : key.column,
      visible,
    })
    return { tableAccessId, ddl, ...(await this.grants(connectionId, definition.name, visible)) }
  }

  /** The table designer (E28): a table without data, from the same definition and DDL. */
  async design(actor: Actor, definition: NewTableDefinition): Promise<NewTableOutcome> {
    const ddl = await this.create(actor, definition, {})
    return this.finish(actor, definition, ddl)
  }

  /**
   * Checks a created table again after the database administrator ran the statements:
   * grants, catalog, and with them the state of its table access.
   */
  async check(
    actor: Actor,
    tableAccessId: string,
  ): Promise<Pick<NewTableOutcome, 'readable' | 'statements'>> {
    const access = await this.deps.tableAccess.get(tableAccessId)
    try {
      await this.deps.connections.recheckGrants(actor, access.connectionId)
      await this.deps.catalog.refresh(actor, access.connectionId, 'manual')
    } catch (error) {
      this.deps.log.warn({ err: error, tableAccessId }, 'table not checked again')
    }
    const visible = (await this.taken(access.connectionId)).includes(access.objectName)
    return this.grants(access.connectionId, access.objectName, visible)
  }

  /**
   * What the read user lacks on the table. Only `SELECT` for the read user: the ceiling is
   * read, and once an admin raises it, the write scope of the connection suggests the write
   * user's statements (§9.4). No schema-wide grants, which would reach beyond table access.
   */
  async grants(
    connectionId: string,
    objectName: string,
    visible: boolean,
  ): Promise<Pick<NewTableOutcome, 'readable' | 'statements'>> {
    const target = await this.deps.connections.resolve(connectionId)
    const report = target.reports.read
    const readable =
      visible && report !== undefined && objectPrivileges(report, objectName).has('SELECT')
    if (readable) return { readable, statements: [] }
    const username = target.users.read?.username ?? 'stashley_read'
    const account = quoteAccount(report?.account ?? `${username}@%`)
    const database = target.spec.database.replace(/`/g, '``')
    return {
      readable: false,
      statements: [
        {
          purpose: 'read',
          statement: `GRANT SELECT ON \`${database}\`.\`${objectName}\` TO ${account};`,
        },
      ],
    }
  }
}
