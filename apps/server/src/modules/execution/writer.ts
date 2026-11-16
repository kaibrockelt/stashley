// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FieldError, FieldSpec, ValueKind } from '@stashley/shared'
import {
  checkField,
  checkFieldValue,
  checkParamValue,
  checkRow,
  evaluateDateExpression,
  hasOp,
  parseDateExpression,
} from '@stashley/shared'
import type { Clock } from '../../platform/clock.ts'
import { systemClock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { encodeValue } from '../../target/encoding.ts'
import type { TargetPools, TargetSession } from '../../target/pools.ts'
import type { CompiledTableSource } from '../access/compile.ts'
import type { AuthorizedComponent } from '../access/handles.ts'
import type { WriteField, WriteModel } from '../access/write-model.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { ConnectionsService } from '../connections/service.ts'
import type { VariablesService, VariableValue } from '../variables/service.ts'
import { resolveBaseValues } from './base-values.ts'
import { affectedObjects } from './cascades.ts'
import {
  rowStatement,
  simulatedRowStatement,
  type ResolvedValues,
  type ValueOptions,
} from './sql/table-sql.ts'
import type { TableModel } from './sql/table-model.ts'
import {
  bindWrite,
  deleteRow,
  exists,
  insertRow,
  lockRow,
  lockWhere,
  updateRow,
  type WriteValue,
} from './sql/write-sql.ts'
import { deadlockErrno, translateWriteError, writeErrno } from './write-errors.ts'

/**
 * The write path (§11): writes come only from configuration, run in one transaction on the
 * write pool, lock their row with the base filter, detect concurrent edits with a version
 * token and check afterwards that the row is still inside the base filter. In edit and
 * preview mode they are simulated with reads only (§11.2, D10).
 */

/** What the client sends with a write. */
export interface WriteRequest {
  /** Field values by column name, in the JSON forms of §9.5. */
  values: unknown
  /** The version token of the row as the client loaded it (updates and deletes). */
  version?: string | undefined
  /** Page filter and URL values, for option lists bound to them. */
  filters?: Readonly<Record<string, unknown>> | undefined
  params?: Readonly<Record<string, unknown>> | undefined
}

export interface WrittenRow {
  key: unknown
  /** The record by field ID, when the caller may read it. */
  values?: Record<string, unknown>
  version?: string
  /** An update whose values equal the current row changed nothing (§11.1). */
  unchanged?: true
  /** Edit and preview mode: nothing was written (§11.2). */
  simulated?: true
  /** Upserts: whether the row was created. */
  created?: boolean
}

/** Checks a foreign key value against its option list (§ Auswahllisten). */
export interface ReferenceCheck {
  allowed(
    handle: AuthorizedComponent,
    field: WriteField,
    value: unknown,
    input: {
      filters: Readonly<Record<string, unknown>>
      params: Readonly<Record<string, unknown>>
    },
  ): Promise<boolean>
}

interface Target {
  connectionId: string
  run: <T>(fn: (session: TargetSession) => Promise<T>) => Promise<T>
  timeZone: string
}

/** A column the writer reads from the locked row: the fields and the lock column. */
interface StateColumn {
  column: string
  kind: ValueKind
  spec: FieldSpec | undefined
}

interface RowState {
  key: unknown
  /** Canonical values by column name. */
  values: Record<string, unknown>
  lock: unknown
}

interface Context {
  handle: AuthorizedComponent
  source: CompiledTableSource
  write: WriteModel
  target: Target
  options: ValueOptions
  base: ResolvedValues
  variables: ReadonlyMap<string, VariableValue>
  simulate: boolean
}

const lower = (name: string) => name.toLowerCase()

/** Raised inside a transaction to roll it back and answer with this error. */
class Abort extends Error {
  readonly error: AppError
  constructor(error: AppError) {
    super(error.message)
    this.error = error
  }
}

export class RowWriter {
  private readonly deps: {
    connections: ConnectionsService
    pools: TargetPools
    audit: AuditLog
    variables: VariablesService
    events: EventBus
    references: ReferenceCheck
    versionKey: Buffer
    /** `APP_TIMEZONE`, for date expressions. */
    timeZone: string
    log: { error: (object: object, message: string) => void }
  }
  private readonly clock: Clock

  constructor(deps: RowWriter['deps'] & { clock?: Clock }) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  // Setup

  private async target(connectionId: string, simulate: boolean): Promise<Target> {
    const resolved = await this.deps.connections.resolve(connectionId)
    const writer = resolved.users.write
    if (writer === undefined) throw new AppError('target_unavailable')
    return {
      connectionId,
      timeZone: resolved.row.timezone,
      run: async (fn) => {
        // Deadlocks roll the whole transaction back; it is tried once more (§11).
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.deps.pools.run(
              connectionId,
              resolved.spec,
              writer,
              async (session) => {
                await session.query(simulate ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION')
                const result = await fn(session)
                await session.query(simulate ? 'ROLLBACK' : 'COMMIT')
                return result
              },
            )
          } catch (error) {
            if (error instanceof Abort) throw error.error
            if (attempt === 0 && writeErrno(error) === deadlockErrno) continue
            throw translateWriteError(error)
          }
        }
      },
    }
  }

  private async context(handle: AuthorizedComponent, needsWriteModel = true): Promise<Context> {
    const source = handle.component.source
    if (source?.kind !== 'table' || source.model === null) throw new AppError('not_found')
    const write = source.write
    if (write === null && needsWriteModel) throw new AppError('not_found')
    const simulate = handle.mode !== 'runtime'
    const target = await this.target(source.connection.connectionId, simulate)
    const options: ValueOptions = {
      connectionTimeZone: target.timeZone,
      displayTimeZone: this.deps.timeZone,
    }
    const variables = await this.deps.variables.current()
    const model = write?.row ?? source.model
    const base = resolveBaseValues(model, handle.user, variables, options)
    return {
      handle,
      source,
      write: write as WriteModel,
      target,
      options,
      base: { baseFilter: base.values, bindings: [] },
      variables,
      simulate,
    }
  }

  /** A key from the URL or a payload, typed like the key column. */
  private key(kind: ValueKind, raw: unknown): unknown {
    const integer = kind === 'integer' || kind === 'bigint'
    const parsed = integer ? checkParamValue('integer', raw) : checkParamValue('string', raw)
    if (!parsed.ok) throw new AppError('not_found')
    return parsed.value
  }

  /** Keys answer in their JSON form (§9.5): BIGINT as text, like reads. */
  private answerKey(kind: ValueKind, key: unknown): unknown {
    return kind === 'bigint' && (typeof key === 'number' || typeof key === 'bigint')
      ? String(key)
      : key
  }

  // Reading rows

  private stateColumns(context: Context): StateColumn[] {
    const write = context.write
    const columns: StateColumn[] = write.fields
      .filter((field) => field.spec.kind !== 'unsupported')
      .map((field) => ({ column: field.column, kind: field.spec.kind, spec: field.spec }))
    const lock = write.lock
    if (
      lock.kind !== 'values' &&
      !columns.some((entry) => lower(entry.column) === lower(lock.column))
    ) {
      const catalog = context.source.connection.catalog.get(write.object)
      const column = catalog?.columns.find((entry) => lower(entry.name) === lower(lock.column))
      if (column !== undefined)
        columns.push({ column: column.name, kind: column.kind, spec: undefined })
    }
    return columns
  }

  /** Values as the client sends them, so comparisons do not trip over `49.90` and `49.9`. */
  private canonical(column: StateColumn, raw: unknown, timeZone: string): unknown {
    const encoded = encodeValue(column.kind, raw as string | number | null, timeZone).value
    if (encoded === null || column.spec === undefined) return encoded
    const checked = checkFieldValue(column.spec, encoded)
    return checked.ok ? checked.value : encoded
  }

  private async readState(
    context: Context,
    session: TargetSession,
    where: { key: unknown } | { columns: [string, unknown][] },
    lock: boolean,
  ): Promise<RowState | undefined> {
    const write = context.write
    const columns = this.stateColumns(context)
    const names = columns.map((entry) => entry.column)
    const statement =
      'key' in where
        ? lockRow(write.object, write.keyColumn, names, where.key, lock)
        : lockWhere(write.object, write.keyColumn, names, where.columns, lock)
    const result = await session.execute(statement.sql, statement.values)
    const row = result.rows[0]
    if (row === undefined) return undefined
    const values: Record<string, unknown> = {}
    columns.forEach((entry, index) => {
      values[entry.column] = this.canonical(entry, row[index], context.target.timeZone)
    })
    const lockColumn = write.lock.kind === 'values' ? undefined : write.lock.column
    return {
      key: encodeValue(
        write.keyKind,
        row[columns.length] as string | number | null,
        context.target.timeZone,
      ).value,
      values,
      lock:
        lockColumn === undefined
          ? null
          : values[
              columns.find((entry) => lower(entry.column) === lower(lockColumn))?.column ?? ''
            ],
    }
  }

  /** The row through its model with the base filter, by field or column ID; undefined outside. */
  private async visible(
    context: Context,
    session: TargetSession,
    model: TableModel,
    key: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const statement = rowStatement(model, context.base, key)
    const result = await session.execute(statement.sql, statement.values)
    const row = result.rows[0]
    if (row === undefined) return undefined
    const values: Record<string, unknown> = {}
    model.columns.forEach((column, index) => {
      values[column.id] = encodeValue(
        column.kind,
        row[index] as string | number | null,
        context.target.timeZone,
      ).value
    })
    return values
  }

  /** Reads one row of a simulated write through the model; undefined outside the base filter. */
  private async simulatedVisible(
    context: Context,
    session: TargetSession,
    row: Parameters<typeof simulatedRowStatement>[2],
  ): Promise<Record<string, unknown> | undefined> {
    const model = context.write.row
    const statement = simulatedRowStatement(model, context.base, row)
    const result = await session.execute(statement.sql, statement.values)
    const found = result.rows[0]
    if (found === undefined) return undefined
    const values: Record<string, unknown> = {}
    model.columns.forEach((column, index) => {
      values[column.id] = encodeValue(
        column.kind,
        found[index] as string | number | null,
        context.target.timeZone,
      ).value
    })
    return values
  }

  /**
   * Columns of the row the base filter depends on: its own conditions and the columns its
   * conditions over linked tables join through. A new row can be checked only when it has
   * values for all of them; database defaults are unknown before the insert.
   */
  private baseFilterColumns(context: Context): string[] {
    const model = context.write.row
    const byAlias = new Map(model.joins.map((join) => [join.alias, join]))
    const columns = new Set<string>()
    for (const condition of model.baseFilter) {
      let alias = condition.expr.alias
      if (alias === 't0') columns.add(condition.expr.column)
      while (alias !== 't0') {
        const join = byAlias.get(alias)
        if (join === undefined) break
        if (join.parent === 't0') columns.add(join.parentColumn)
        alias = join.parent
      }
    }
    return [...columns]
  }

  /** The opaque version token: the lock column and the values of the writable fields (§11). */
  version(context: Pick<Context, 'write'>, state: RowState): string {
    const values = Object.keys(state.values)
      .sort()
      .map((column) => [column, state.values[column]])
    return createHmac('sha256', this.deps.versionKey)
      .update(JSON.stringify([context.write.object, String(state.key), state.lock, values]))
      .digest('base64url')
      .slice(0, 32)
  }

  private sameVersion(expected: string, actual: string): boolean {
    const a = Buffer.from(expected)
    const b = Buffer.from(actual)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private outcome(
    context: Context,
    key: unknown,
    values: Record<string, unknown> | undefined,
    state: RowState | undefined,
    extra: Partial<WrittenRow> = {},
  ): WrittenRow {
    const readable = hasOp(context.handle.ops, 'read')
    return {
      key,
      ...(readable && values !== undefined && { values }),
      ...(readable && state !== undefined && { version: this.version(context, state) }),
      ...(context.simulate && { simulated: true as const }),
      ...extra,
    }
  }

  // Values

  private specOf(write: WriteModel, column: string): FieldSpec | undefined {
    return write.fields.find((field) => field.column === column)?.spec
  }

  private invalid(errors: FieldError[]): AppError {
    return new AppError('validation_failed', { errors })
  }

  /** A default the server sets: a constant, an instance variable or the user (E10). */
  private defaultValue(context: Context, field: WriteField): unknown {
    const value = field.default
    if (value === undefined) return undefined
    let raw: unknown
    if (value.kind === 'constant') raw = value.value
    else if (value.kind === 'user')
      raw = value.field === 'id' ? context.handle.user.id : context.handle.user.email
    else if (value.kind === 'variable') {
      const variable = context.variables.get(value.name)
      if (variable === undefined)
        throw this.invalid([{ field: field.column, code: 'variable_missing' }])
      raw = variable.value
    } else return undefined
    const checked = checkField({ ...field.spec, required: false, nullable: true }, raw)
    if (!checked.ok) throw this.invalid([{ field: field.column, code: 'default_invalid' }])
    return checked.value
  }

  private generated(field: WriteField): unknown {
    const generator = field.generator
    if (generator?.kind !== 'date') return undefined
    const expression = parseDateExpression(generator.expression)
    const kind = field.spec.kind
    if (
      expression === undefined ||
      (kind !== 'date' && kind !== 'datetime' && kind !== 'timestamp')
    )
      return undefined
    return evaluateDateExpression(expression, this.clock(), this.deps.timeZone, kind)
  }

  /**
   * The values of a new row: the checked payload, then what the server sets — hidden and
   * missing defaults, generated dates, equality conditions of the base filter on own columns
   * (new rows must meet it), and the lock column where it has no default.
   */
  private createValues(context: Context, payload: unknown): Record<string, unknown> {
    const write = context.write
    const checked = checkRow(write.payload.create, 'create', payload)
    if (!checked.ok) throw this.invalid(checked.errors)
    const values = { ...checked.values }
    for (const field of write.fields) {
      if (Object.hasOwn(values, field.column)) continue
      if (field.kind === 'generated') {
        const value = this.generated(field)
        if (value !== undefined) values[field.column] = value
        continue
      }
      const value = this.defaultValue(context, field)
      if (value !== undefined) values[field.column] = value
    }
    for (const { column, index } of write.filled) {
      const condition = write.row.baseFilter[index]
      if (condition === undefined || Object.hasOwn(values, column)) continue
      const raw = context.base.baseFilter[index]
      values[column] = this.fromBound(condition.expr.kind, raw, context.options)
    }
    const lock = write.lock
    const catalog = context.source.connection.catalog.get(write.object)
    const lockColumn = catalog?.columns.find(
      (column) => lock.kind !== 'values' && lower(column.name) === lower(lock.column),
    )
    if (
      lockColumn !== undefined &&
      lockColumn.defaultValue === null &&
      !Object.hasOwn(values, lockColumn.name)
    ) {
      values[lockColumn.name] = lock.kind === 'version' ? 1 : this.now()
    }
    return values
  }

  /** A bound base filter value back in its JSON form (DATETIME wall times become instants). */
  private fromBound(kind: ValueKind, raw: unknown, options: ValueOptions): unknown {
    if (kind === 'datetime' || kind === 'timestamp') {
      const zone = kind === 'datetime' ? options.connectionTimeZone : 'UTC'
      return encodeValue(kind, raw as string, zone).value
    }
    if (kind === 'boolean') return raw === 1 || raw === true
    return raw
  }

  /** Now as a UTC instant in whole seconds; DATETIME(0) would round fractions. */
  private now(): string {
    return new Date(Math.floor(this.clock() / 1000) * 1000).toISOString().replace('.000Z', 'Z')
  }

  private kindOf(context: Context, column: string): ValueKind {
    const catalog = context.source.connection.catalog.get(context.write.object)
    return catalog?.columns.find((entry) => entry.name === column)?.kind ?? 'string'
  }

  private bound(context: Context, values: Record<string, unknown>): [string, unknown][] {
    return Object.entries(values).map(([column, value]) => [
      column,
      bindWrite(this.kindOf(context, column), value, context.target.timeZone),
    ])
  }

  /** Foreign key values must come from their option list (`value_not_allowed`). */
  private async checkReferences(
    context: Context,
    values: Record<string, unknown>,
    request: WriteRequest,
  ): Promise<void> {
    const input = { filters: request.filters ?? {}, params: request.params ?? {} }
    const errors: FieldError[] = []
    for (const field of context.write.fields) {
      if (field.reference === undefined) continue
      const value = values[field.column]
      if (value === undefined || value === null) continue
      if (!(await this.deps.references.allowed(context.handle, field, value, input))) {
        errors.push({ field: field.column, code: 'value_not_allowed' })
      }
    }
    if (errors.length > 0) throw new AppError('value_not_allowed', { errors })
  }

  // Finding the cause of a refused write

  private catalog(context: Context) {
    return context.source.connection.catalog.get(context.write.object)
  }

  /** Unique keys (and the primary key) whose values exist in another row. */
  private async duplicates(
    context: Context,
    session: TargetSession,
    values: Record<string, unknown>,
    except: unknown,
  ): Promise<FieldError[]> {
    const catalog = this.catalog(context)
    if (catalog === undefined) return []
    const keys = [catalog.primaryKey, ...catalog.uniqueKeys]
    const errors: FieldError[] = []
    for (const columns of keys) {
      if (
        columns.length === 0 ||
        !columns.every((column) => values[column] !== undefined && values[column] !== null)
      )
        continue
      const statement = exists(
        context.write.object,
        columns.map((column) => [
          column,
          bindWrite(this.kindOf(context, column), values[column], context.target.timeZone),
        ]),
        except === undefined ? undefined : { column: context.write.keyColumn, key: except },
      )
      const result = await session.execute(statement.sql, statement.values)
      if (result.rows.length > 0) {
        for (const column of columns) errors.push({ field: column, code: 'unique_violation' })
      }
    }
    return errors
  }

  /** Foreign keys of the catalog whose referenced row is missing. */
  private async missingReferences(
    context: Context,
    session: TargetSession,
    values: Record<string, unknown>,
  ): Promise<FieldError[]> {
    const catalog = this.catalog(context)
    if (catalog === undefined) return []
    const errors: FieldError[] = []
    for (const key of catalog.foreignKeys) {
      const pairs = key.columns.map((column, index) => [column, key.targetColumns[index]] as const)
      if (!pairs.every(([column]) => values[column] !== undefined && values[column] !== null))
        continue
      const statement = exists(
        key.targetObject,
        pairs.map(([column, target]) => [
          target as string,
          bindWrite(this.kindOf(context, column), values[column], context.target.timeZone),
        ]),
      )
      const result = await session.execute(statement.sql, statement.values)
      if (result.rows.length === 0) {
        for (const [column] of pairs) errors.push({ field: column, code: 'foreign_key_violation' })
      }
    }
    return errors
  }

  /** Runs DML; a refused one is explained by field where the writer can find out. */
  private async dml(
    context: Context,
    session: TargetSession,
    statement: { sql: string; values: unknown[] },
    values: Record<string, unknown>,
    except: unknown,
  ) {
    try {
      return await session.write(statement.sql, statement.values)
    } catch (error) {
      const errno = writeErrno(error)
      if (errno !== 1062 && errno !== 1586 && errno !== 1452 && errno !== 1216) throw error
      await session.query('ROLLBACK')
      await session.query('START TRANSACTION READ ONLY')
      const errors =
        errno === 1062 || errno === 1586
          ? await this.duplicates(context, session, values, except)
          : await this.missingReferences(context, session, values)
      throw new Abort(translateWriteError(error, errors))
    }
  }

  /**
   * Whether a delete would be refused (`still_referenced`), for simulated deletes: a foreign
   * key with `RESTRICT`/`NO ACTION` and a referring row. Keys the write user cannot read are
   * left to the real delete.
   */
  private async stillReferenced(
    context: Context,
    session: TargetSession,
    object: string,
    keyColumn: string,
    key: unknown,
  ): Promise<boolean> {
    for (const child of context.source.connection.catalog.values()) {
      for (const foreign of child.foreignKeys) {
        if (foreign.targetObject !== object) continue
        if (foreign.onDelete !== 'restrict' && foreign.onDelete !== 'no_action') continue
        try {
          const own = lockWhere(object, keyColumn, foreign.targetColumns, [[keyColumn, key]], false)
          const row = (await session.execute(own.sql, own.values)).rows[0]
          if (row === undefined) continue
          const values = foreign.targetColumns.map((_, index) => row[index])
          if (values.some((value) => value === null || value === undefined)) continue
          const statement = exists(
            child.name,
            foreign.columns.map((column, index) => [column, values[index]]),
          )
          if ((await session.execute(statement.sql, statement.values)).rows.length > 0) return true
        } catch (error) {
          const errno = writeErrno(error)
          if (errno === 1142 || errno === 1143) continue
          throw error
        }
      }
    }
    return false
  }

  // Operations

  private notifyAndAudit(
    context: Context,
    actor: Actor,
    action: 'row.created' | 'row.updated' | 'row.deleted',
    key: unknown,
    changes: Record<string, [unknown, unknown]>,
  ): Promise<void> {
    const object = context.source.object.objectName
    this.deps.events.emit('rows.written', {
      connectionId: context.target.connectionId,
      objects: affectedObjects(
        context.source.connection.catalog,
        object,
        action === 'row.deleted' ? 'delete' : action === 'row.updated' ? 'update' : null,
        Object.keys(changes),
      ),
    })
    const handle = context.handle
    return this.deps.audit
      .record(actor, {
        action,
        subject: { kind: 'row', id: String(key), label: `${object} ${String(key)}` },
        changes,
        pageId: handle.page.pageId,
        componentId: handle.component.id,
        connectionId: context.target.connectionId,
        objectName: object,
        rowKey: String(key),
      })
      .catch((error: unknown) => {
        // The write is committed; a failed audit entry is logged with IDs only (§11 step 6).
        this.deps.log.error(
          {
            err: error,
            pageId: handle.page.pageId,
            componentId: handle.component.id,
            object,
            key: String(key),
          },
          'audit of a committed write failed',
        )
      })
  }

  async create(
    handle: AuthorizedComponent,
    actor: Actor,
    request: WriteRequest,
  ): Promise<WrittenRow> {
    if (!hasOp(handle.ops, 'create')) throw new AppError('forbidden')
    const context = await this.context(handle)
    const values = this.createValues(context, request.values)
    await this.checkReferences(context, values, request)
    return this.insert(context, actor, values)
  }

  private async insert(
    context: Context,
    actor: Actor,
    values: Record<string, unknown>,
  ): Promise<WrittenRow> {
    const write = context.write
    if (context.simulate) {
      return context.target.run(async (session) => {
        const errors = [
          ...(await this.duplicates(context, session, values, undefined)),
          ...(await this.missingReferences(context, session, values)),
        ]
        if (errors.length > 0) {
          const code =
            errors[0]?.code === 'unique_violation' ? 'unique_violation' : 'foreign_key_violation'
          throw new Abort(new AppError(code, { errors }))
        }
        // New rows must meet the base filter (§11.2): checked where the values decide it.
        const given = new Set(Object.keys(values).map(lower))
        const decidable = this.baseFilterColumns(context).every((column) =>
          given.has(lower(column)),
        )
        let visible: Record<string, unknown> | undefined
        if (decidable && write.row.baseFilter.length > 0) {
          visible = await this.simulatedVisible(context, session, {
            values: this.bound(context, values),
          })
          if (visible === undefined) throw new Abort(new AppError('base_filter_violation'))
        }
        return this.outcome(context, values[write.keyColumn] ?? null, visible, undefined, {
          created: true,
        })
      })
    }
    const written = await context.target.run(async (session) => {
      const result = await this.dml(
        context,
        session,
        insertRow(write.object, this.bound(context, values)),
        values,
        undefined,
      )
      const bound =
        write.keyAutoIncrement && values[write.keyColumn] === undefined
          ? this.key(write.keyKind, result.insertId)
          : this.key(write.keyKind, values[write.keyColumn])
      const key = this.answerKey(write.keyKind, bound)
      // New rows must meet the base filter, also over linked tables (§ Basisfilter).
      const visible = await this.visible(context, session, write.row, key)
      if (visible === undefined) throw new Abort(new AppError('base_filter_violation'))
      const state = await this.readState(context, session, { key }, false)
      return { key, visible, state }
    })
    const changes = Object.fromEntries(
      Object.entries(values).map(([column, value]) => [
        column,
        [null, value] as [unknown, unknown],
      ]),
    )
    await this.notifyAndAudit(context, actor, 'row.created', written.key, changes)
    return this.outcome(context, written.key, written.visible, written.state, { created: true })
  }

  /**
   * Updates by key and the record behind them exist only where the component reads its rows:
   * forms in edit mode and tables. Create and upsert forms never read (§8.2), so they answer
   * 404 here instead of handing out records or version tokens.
   */
  private requireRecordAccess(handle: AuthorizedComponent): void {
    const block = handle.component.block
    const editable = block.type === 'table' || (block.type === 'form' && block.mode === 'edit')
    if (!editable) throw new AppError('not_found')
    if (!hasOp(handle.ops, 'read') || !hasOp(handle.ops, 'update')) {
      throw new AppError('forbidden')
    }
  }

  /** A version conflict; the current record only for callers that may read it. */
  private conflict(context: Context, current: Record<string, unknown>): AppError {
    return new AppError('version_conflict', hasOp(context.handle.ops, 'read') ? { current } : {})
  }

  /** The record of an editable component with its version token, for edit mode and inline. */
  async current(handle: AuthorizedComponent, rawKey: string): Promise<WrittenRow> {
    this.requireRecordAccess(handle)
    const context = await this.context(handle)
    const key = this.key(context.write.keyKind, rawKey)
    const found = await context.target.run(async (session) => {
      const visible = await this.visible(context, session, context.write.row, key)
      if (visible === undefined) return undefined
      const state = await this.readState(context, session, { key }, false)
      return state === undefined ? undefined : { visible, state }
    })
    if (found === undefined) throw new AppError('not_found')
    return {
      key: this.answerKey(context.write.keyKind, key),
      values: found.visible,
      version: this.version(context, found.state),
    }
  }

  async update(
    handle: AuthorizedComponent,
    actor: Actor,
    rawKey: string,
    request: WriteRequest,
  ): Promise<WrittenRow> {
    this.requireRecordAccess(handle)
    const context = await this.context(handle)
    const key = this.key(context.write.keyKind, rawKey)
    const checked = checkRow(context.write.payload.update, 'update', request.values)
    if (!checked.ok) throw this.invalid(checked.errors)
    await this.checkReferences(context, checked.values, request)
    return this.change(context, actor, { key }, checked.values, request.version)
  }

  /**
   * Updates the row found by key (or by an upsert key) inside its base filter. A version
   * token that differs answers 409 with the current row; unchanged values write nothing.
   */
  private async change(
    context: Context,
    actor: Actor,
    where: { key: unknown } | { columns: [string, unknown][] },
    values: Record<string, unknown>,
    version: string | undefined,
  ): Promise<WrittenRow> {
    const write = context.write
    const result = await context.target.run(async (session) => {
      const state = await this.readState(context, session, where, !context.simulate)
      if (state === undefined) {
        if ('columns' in where) return { missing: true as const }
        throw new Abort(new AppError('not_found'))
      }
      const key = state.key
      const before = await this.visible(context, session, write.row, key)
      if (before === undefined) {
        // An upsert key outside the base filter reads like a duplicate on create (N2): the
        // unique key reveals the value anyway, the base filter does not need to say more.
        throw new Abort(
          'columns' in where
            ? new AppError('unique_violation', {
                errors: (write.upsertKey ?? []).map((field) => ({
                  field,
                  code: 'unique_violation',
                })),
              })
            : new AppError('not_found'),
        )
      }
      if (version !== undefined && !this.sameVersion(version, this.version(context, state))) {
        throw new Abort(
          this.conflict(context, { key, values: before, version: this.version(context, state) }),
        )
      }
      const changes: Record<string, [unknown, unknown]> = {}
      for (const [column, value] of Object.entries(values)) {
        const current = state.values[column]
        if (JSON.stringify(current ?? null) !== JSON.stringify(value))
          changes[column] = [current ?? null, value]
      }
      if (Object.keys(changes).length === 0) {
        return { key, visible: before, state, changes, unchanged: true as const }
      }
      if (context.simulate) {
        const changed = Object.fromEntries(
          Object.entries(changes).map(([column, [, value]]) => [column, value]),
        )
        const errors = [
          ...(await this.duplicates(context, session, changed, key)),
          ...(await this.missingReferences(context, session, changed)),
        ]
        if (errors.length > 0) {
          const code =
            errors[0]?.code === 'unique_violation' ? 'unique_violation' : 'foreign_key_violation'
          throw new Abort(new AppError(code, { errors }))
        }
        // The row as the change would leave it, through the base filter (§11.2).
        const after = await this.simulatedVisible(context, session, {
          keyColumn: write.keyColumn,
          key,
          changes: this.bound(context, changed),
        })
        if (after === undefined) throw new Abort(new AppError('base_filter_violation'))
        return { key, visible: after, state, changes }
      }
      const sets: [string, WriteValue][] = Object.entries(changes).map(([column, [, value]]) => [
        column,
        { value: bindWrite(this.kindOf(context, column), value, context.target.timeZone) },
      ])
      const lock = write.lock
      if (lock.kind === 'version') sets.push([lock.column, { expression: 'increment' }])
      if (lock.kind === 'timestamp' && lock.setByServer) {
        sets.push([
          lock.column,
          {
            value: bindWrite(
              this.kindOf(context, lock.column),
              this.now(),
              context.target.timeZone,
            ),
          },
        ])
      }
      const changed = Object.fromEntries(
        Object.entries(changes).map(([column, [, value]]) => [column, value]),
      )
      await this.dml(
        context,
        session,
        updateRow(write.object, write.keyColumn, key, sets),
        changed,
        key,
      )
      // A change must not move the row out of the base filter, e.g. to another hotel.
      const after = await this.visible(context, session, write.row, key)
      if (after === undefined) throw new Abort(new AppError('base_filter_violation'))
      const next = await this.readState(context, session, { key }, false)
      return { key, visible: after, state: next, changes }
    })
    if ('missing' in result) return { key: undefined }
    if ('unchanged' in result) {
      return this.outcome(context, result.key, result.visible, result.state, { unchanged: true })
    }
    if (!context.simulate)
      await this.notifyAndAudit(context, actor, 'row.updated', result.key, result.changes)
    return this.outcome(context, result.key, result.visible, result.state)
  }

  /**
   * Upsert (D2): a locked lookup by the upsert key decides between update and insert. A
   * concurrent insert of the same key fails with a duplicate and is retried once as update.
   */
  async upsert(
    handle: AuthorizedComponent,
    actor: Actor,
    request: WriteRequest,
  ): Promise<WrittenRow> {
    const context = await this.context(handle)
    const write = context.write
    if (write.upsertKey === null) throw new AppError('not_found')
    const values = this.createValues(context, request.values)
    const missing = write.upsertKey.filter(
      (column) => values[column] === undefined || values[column] === null,
    )
    if (missing.length > 0)
      throw this.invalid(missing.map((field) => ({ field, code: 'required' })))
    await this.checkReferences(context, values, request)
    const where = write.upsertKey.map(
      (column) =>
        [
          column,
          bindWrite(this.kindOf(context, column), values[column], context.target.timeZone),
        ] as [string, unknown],
    )
    // Only what the user entered changes an existing row; defaults are for new rows.
    const updatable = new Set(write.payload.update.map((spec) => spec.column))
    const payload =
      typeof request.values === 'object' && request.values !== null ? request.values : {}
    const changes = Object.fromEntries(
      Object.entries(values).filter(
        ([column]) => updatable.has(column) && Object.hasOwn(payload, column),
      ),
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      const updated = hasOp(handle.ops, 'update')
        ? await this.change(context, actor, { columns: where }, changes, undefined)
        : await this.existing(context, where)
      if (updated.key !== undefined) {
        if (!hasOp(handle.ops, 'update')) throw new AppError('forbidden')
        return { ...updated, created: false }
      }
      if (!hasOp(handle.ops, 'create')) throw new AppError('forbidden')
      try {
        return await this.insert(context, actor, values)
      } catch (error) {
        if (attempt === 0 && error instanceof AppError && error.code === 'unique_violation')
          continue
        throw error
      }
    }
    throw new AppError('row_locked')
  }

  /** Whether a row with the upsert key exists, for callers without update. */
  private async existing(context: Context, where: [string, unknown][]): Promise<WrittenRow> {
    const state = await context.target.run((session) =>
      this.readState(context, session, { columns: where }, false),
    )
    return { key: state?.key }
  }

  async remove(
    handle: AuthorizedComponent,
    actor: Actor,
    rawKey: string,
    request: { version?: string | undefined },
  ): Promise<WrittenRow> {
    // Only tables delete (E13); forms have no delete capability.
    if (handle.component.block.type !== 'table') throw new AppError('not_found')
    if (!hasOp(handle.ops, 'delete')) throw new AppError('forbidden')
    const context = await this.context(handle, false)
    const source = context.source
    const model = source.model as TableModel
    const object = source.object.objectName
    const keyColumn = source.object.keyColumn
    if (keyColumn === null || source.object.objectType !== 'table') throw new AppError('not_found')
    const key = this.key(model.key.kind, rawKey)
    const result = await context.target.run(async (session) => {
      const locked = lockRow(object, keyColumn, [], key, !context.simulate)
      const found = await session.execute(locked.sql, locked.values)
      if (found.rows.length === 0) throw new Abort(new AppError('not_found'))
      const before = await this.visible(context, session, model, key)
      if (before === undefined) throw new Abort(new AppError('not_found'))
      if (request.version !== undefined && source.write !== null) {
        const state = await this.readState(context, session, { key }, false)
        if (
          state !== undefined &&
          !this.sameVersion(request.version, this.version(context, state))
        ) {
          throw new Abort(
            this.conflict(context, { key, values: before, version: this.version(context, state) }),
          )
        }
      }
      if (
        context.simulate &&
        (await this.stillReferenced(context, session, object, keyColumn, key))
      ) {
        throw new Abort(new AppError('still_referenced'))
      }
      if (!context.simulate) {
        const statement = deleteRow(object, keyColumn, key)
        try {
          await session.write(statement.sql, statement.values)
        } catch (error) {
          // Cascades follow the database's ON DELETE rules; a blocked delete is `still_referenced`.
          throw new Abort(translateWriteError(error))
        }
      }
      return before
    })
    if (!context.simulate) {
      // Old values by column, for the columns the table shows from the row itself.
      const changes: Record<string, [unknown, unknown]> = {}
      for (const column of model.columns) {
        if (column.expr.type === 'column' && column.expr.alias === 't0') {
          changes[column.expr.column] = [result[column.id] ?? null, null]
        }
      }
      await this.notifyAndAudit(context, actor, 'row.deleted', key, changes)
    }
    return {
      key: this.answerKey(model.key.kind, key),
      ...(context.simulate && { simulated: true as const }),
    }
  }
}
