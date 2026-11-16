// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type {
  ImportCellError,
  ImportColumnMapping,
  ImportCounts,
  ImportDryRun,
  ImportJob,
  ImportMapping,
  ImportParseOptions,
  ImportPreview,
  ImportStatus,
  ImportTarget,
} from '@stashley/shared'
import {
  addValue,
  checkNewTable,
  emptyStats,
  fieldSpec,
  importMapping,
  importParseOptions,
  newTableCatalog,
  normalizeName,
  suggestFormats,
  suggestType,
  uniqueNames,
} from '@stashley/shared'
import type {
  FieldError,
  NewTableDefinition,
  NewTableImport,
  NewTableOutcome,
} from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { Database, ImportJobsTable, SystemRole } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import { csvRow } from '../../platform/csv.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import type { TargetPools, TargetSession } from '../../target/pools.ts'
import type { AccessService, ResourceModel } from '../access/service.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { ConnectionsService } from '../connections/service.ts'
import { affectedObjects } from '../execution/cascades.ts'
import {
  detectDelimiter,
  detectEncoding,
  detectHeader,
  firstRecords,
  readStart,
  records,
  removeUpload,
  saveUpload,
  uploadPath,
  type CsvRecord,
} from './files.ts'
import { ImportAbort, Importer, type ImportPlan, type PlannedColumn } from './importer.ts'
import { buildPlan, cellFormat, importTarget, maxStoredErrors, suggestMapping } from './plan.ts'
import type { TableCreator } from './tables.ts'

/**
 * CSV imports into existing tables (§17, E22–E27): upload, detected and adjustable options,
 * preview, a dry run over every row that only reads, and the import in one transaction on
 * the write pool. Jobs belong to the user who uploaded them; admins see every job.
 */

export interface ImportUser {
  id: string
  email: string
  systemRole: SystemRole
  formatLocale: string
}

export interface ImportLimits {
  concurrency: number
  perUser: number
  maxBytes: number
  batchSize: number
}

const day = 24 * 60 * 60 * 1000
const previewRows = 100
const shownErrors = 100

interface Running {
  userId: string
  cancel: boolean
  phase: 'checking' | 'importing'
  rows: number
  done: Promise<void>
}

class Cancelled extends Error {}

/** What a dry run checked: the file, the options and the mapping or the new table (E23). */
function fingerprintOf(row: ImportJobsTable): string {
  const state = row.new_table === null ? null : (JSON.parse(row.new_table) as NewTableState)
  const newTable =
    state === null ? null : { definition: state.definition, skipFailed: state.skipFailed }
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.file_sha256,
        JSON.parse(row.parse_options),
        JSON.parse(row.mapping ?? 'null'),
        newTable,
      ]),
    )
    .digest('hex')
}

/** A table the import creates, and how far its creation got (E28). */
type NewTableState = NewTableImport & {
  createdAt: number | null
  dataDoneAt: number | null
  dataCounts?: ImportCounts
  outcome: NewTableOutcome | null
}

export class ImportService {
  private readonly deps: {
    db: Kysely<Database>
    access: AccessService
    tables: TableCreator
    connections: ConnectionsService
    pools: TargetPools
    audit: AuditLog
    events: EventBus
    dataDir: string
    limits: ImportLimits
    /** `APP_TIMEZONE`: CSV wall times are read in it (E25). */
    timeZone: string
    log: { error: (object: object, message: string) => void }
  }
  private readonly clock: Clock
  private readonly running = new Map<string, Running>()

  constructor(deps: ImportService['deps'] & { clock?: Clock }) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  // Access

  private requireImporter(user: ImportUser): void {
    if (user.systemRole !== 'admin' && user.systemRole !== 'manager') {
      throw new AppError('forbidden')
    }
  }

  /** A job of this user (admins: any); others are not found. */
  private async row(user: ImportUser, id: string): Promise<ImportJobsTable> {
    this.requireImporter(user)
    const row = await this.deps.db
      .selectFrom('import_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined || (row.created_by !== user.id && user.systemRole !== 'admin')) {
      throw new AppError('not_found')
    }
    return row
  }

  private file(id: string): string {
    return uploadPath(this.deps.dataDir, id)
  }

  private toJob(row: ImportJobsTable): ImportJob {
    const mapping = row.mapping === null ? null : importMapping.parse(JSON.parse(row.mapping))
    const dryRun =
      row.dry_run === null
        ? null
        : (JSON.parse(row.dry_run) as ImportDryRun & { errors: ImportCellError[] })
    const result =
      row.result === null
        ? null
        : (JSON.parse(row.result) as {
            counts?: ImportCounts
            finishedAt?: number
            failure?: ImportJob['failure']
          })
    const running = this.running.get(row.id)
    return {
      id: row.id,
      fileName: row.file_name,
      fileSize: row.file_size,
      sha256: row.file_sha256,
      status: row.status as ImportStatus,
      options: importParseOptions.parse(JSON.parse(row.parse_options)),
      mapping,
      newTable:
        row.new_table === null ? null : (JSON.parse(row.new_table) as ImportJob['newTable']),
      suggestedMapping: null,
      dryRun: dryRun === null ? null : { ...dryRun, errors: dryRun.errors.slice(0, shownErrors) },
      result:
        result?.counts === undefined
          ? null
          : { ...result.counts, finishedAt: result.finishedAt ?? row.updated_at },
      progress: running === undefined ? null : { phase: running.phase, rows: running.rows },
      failure: result?.failure ?? null,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  // Upload

  async upload(user: ImportUser, body: Readable, fileName: string): Promise<ImportJob> {
    this.requireImporter(user)
    const id = uuidv7()
    const file = this.file(id)
    const stored = await saveUpload(body, file, this.deps.limits.maxBytes)
    try {
      const encoding = await detectEncoding(file)
      const start = await readStart(file, encoding)
      const delimiter = detectDelimiter(start)
      const sample = await firstRecords(file, { encoding, delimiter }, previewRows + 1)
      const header = detectHeader(sample.map((record) => record.cells))
      const data = (header ? sample.slice(1) : sample).map((record) => record.cells)
      const width = Math.max(0, ...data.map((cells) => cells.length))
      const columns = Array.from({ length: width }, (_, index) =>
        data.map((cells) => cells[index] ?? ''),
      )
      const formats = suggestFormats(columns, user.formatLocale)
      const options: ImportParseOptions = {
        encoding,
        delimiter,
        header,
        ...formats,
        emptyValues: [''],
      }
      const now = this.clock()
      await this.deps.db
        .insertInto('import_jobs')
        .values({
          id,
          connection_id: null,
          table_access_id: null,
          new_table: null,
          mode: 'insert',
          upsert_key: null,
          file_name: fileName,
          file_sha256: stored.sha256,
          file_size: stored.size,
          encoding_detected: encoding,
          parse_options: JSON.stringify(options),
          mapping: null,
          status: 'uploaded',
          dry_run: null,
          result: null,
          created_by: user.id,
          created_at: now,
          updated_at: now,
          finished_at: null,
          expires_at: now + day,
        })
        .execute()
    } catch (error) {
      await removeUpload(file)
      throw error
    }
    return this.get(user, id)
  }

  async list(user: ImportUser): Promise<ImportJob[]> {
    this.requireImporter(user)
    let query = this.deps.db.selectFrom('import_jobs').selectAll().orderBy('created_at', 'desc')
    if (user.systemRole !== 'admin') query = query.where('created_by', '=', user.id)
    return (await query.limit(50).execute()).map((row) => this.toJob(row))
  }

  async get(user: ImportUser, id: string): Promise<ImportJob> {
    return this.toJob(await this.row(user, id))
  }

  // Reading

  private headersOf(sample: CsvRecord[], options: ImportParseOptions): string[] {
    const width = Math.max(0, ...sample.map((record) => record.cells.length))
    const first = options.header ? (sample[0]?.cells ?? []) : []
    return Array.from({ length: width }, (_, index) => {
      const name = first[index]?.trim() ?? ''
      return name === '' ? `Column ${index + 1}` : name
    })
  }

  private async sample(id: string, options: ImportParseOptions, count = previewRows) {
    const sample = await firstRecords(this.file(id), options, count + (options.header ? 1 : 0))
    const headers = this.headersOf(sample, options)
    return { headers, data: options.header ? sample.slice(1) : sample }
  }

  /** Tables the user may import into: within the ceiling and the database grants (E22). */
  async targets(user: ImportUser): Promise<ImportTarget[]> {
    this.requireImporter(user)
    const out: ImportTarget[] = []
    for (const connection of await this.deps.connections.list()) {
      const accesses = await this.deps.db
        .selectFrom('table_access')
        .select('id')
        .where('connection_id', '=', connection.id)
        .where('object_type', '=', 'table')
        .orderBy('object_name')
        .execute()
      for (const { id } of accesses) {
        const resource = await this.deps.access.resourceModel(id)
        if (resource === undefined) continue
        const target = importTarget(resource)
        if (target.modes.length > 0) out.push(target)
      }
    }
    return out
  }

  private async resource(tableAccessId: string): Promise<ResourceModel> {
    const resource = await this.deps.access.resourceModel(tableAccessId)
    if (resource === undefined || resource.object.objectType !== 'table') {
      throw new AppError('not_found')
    }
    return resource
  }

  /** A target with the mapping suggested from the file's headers. */
  async target(
    user: ImportUser,
    id: string,
    tableAccessId: string,
  ): Promise<ImportTarget & { suggestedMapping: ImportColumnMapping[] }> {
    const row = await this.row(user, id)
    const resource = await this.resource(tableAccessId)
    const target = importTarget(resource)
    if (target.modes.length === 0) throw new AppError('forbidden')
    const options = importParseOptions.parse(JSON.parse(row.parse_options))
    const { headers } = await this.sample(id, options, 1)
    return { ...target, suggestedMapping: suggestMapping(resource, headers) }
  }

  /** The first rows with the current options; mapped cells are checked (§17 step 4). */
  async preview(user: ImportUser, id: string): Promise<ImportPreview> {
    const row = await this.row(user, id)
    if (row.status === 'completed') throw new AppError('conflict')
    const options = importParseOptions.parse(JSON.parse(row.parse_options))
    const { headers, data } = await this.sample(id, options)
    const errors: ImportCellError[] = []
    const mapping = row.mapping === null ? null : importMapping.parse(JSON.parse(row.mapping))
    if (mapping !== null) {
      const plan = buildPlan(
        await this.resource(mapping.tableAccessId),
        mapping,
        options,
        headers.length,
        this.deps.timeZone,
      )
      // Cell checks only; lookups and duplicates belong to the dry run.
      const importer = new Importer(plan, 'UTC')
      for (const record of data) errors.push(...importer.check(record))
    }
    return { columns: headers, rows: data.map((record) => record.cells), errors }
  }

  // Settings

  async configure(
    user: ImportUser,
    id: string,
    settings: {
      options: ImportParseOptions
      mapping: ImportMapping | null
      newTable?: NewTableImport | null | undefined
    },
  ): Promise<ImportJob> {
    const row = await this.row(user, id)
    if (this.running.has(id) || row.status === 'completed' || row.status === 'importing') {
      throw new AppError('conflict')
    }
    const newTable = settings.newTable ?? null
    const state = row.new_table === null ? null : (JSON.parse(row.new_table) as NewTableState)
    const created = state !== null && state.createdAt !== null
    let connectionId: string | null = null
    let storedTable: NewTableState | null = null
    if (newTable !== null) {
      if (settings.mapping !== null) {
        throw new AppError('validation_failed', {
          errors: [{ field: 'newTable', code: 'not_allowed' }],
        })
      }
      await this.checkNewTable(user, id, settings.options, newTable, state)
      connectionId = newTable.definition.connectionId
      storedTable = {
        ...newTable,
        createdAt: state?.createdAt ?? null,
        dataDoneAt: state?.dataDoneAt ?? null,
        ...(state?.dataCounts !== undefined && { dataCounts: state.dataCounts }),
        outcome: state?.outcome ?? null,
      }
    } else {
      // A created table stays with its job; only its data step can be repeated (E28).
      if (created) {
        throw new AppError('conflict', { errors: [{ field: 'newTable', code: 'table_created' }] })
      }
      if (settings.mapping !== null) {
        const resource = await this.resource(settings.mapping.tableAccessId)
        const { headers } = await this.sample(id, settings.options, 1)
        buildPlan(resource, settings.mapping, settings.options, headers.length, this.deps.timeZone)
        connectionId = resource.connection.connectionId
      }
    }
    const sameTable =
      JSON.stringify(
        state === null ? null : { definition: state.definition, skipFailed: state.skipFailed },
      ) === JSON.stringify(newTable)
    const changed =
      row.parse_options !== JSON.stringify(settings.options) ||
      row.mapping !== (settings.mapping === null ? null : JSON.stringify(settings.mapping)) ||
      !sameTable
    await this.deps.db
      .updateTable('import_jobs')
      .set({
        parse_options: JSON.stringify(settings.options),
        mapping: settings.mapping === null ? null : JSON.stringify(settings.mapping),
        new_table: storedTable === null ? null : JSON.stringify(storedTable),
        connection_id: connectionId,
        table_access_id: settings.mapping?.tableAccessId ?? state?.outcome?.tableAccessId ?? null,
        mode: newTable !== null ? 'create_table' : (settings.mapping?.mode ?? 'insert'),
        upsert_key:
          settings.mapping?.upsertKey === undefined || settings.mapping.upsertKey === null
            ? null
            : JSON.stringify(settings.mapping.upsertKey),
        // A changed setting needs a new dry run (E23).
        ...(changed && { dry_run: null, status: 'uploaded', result: null }),
        updated_at: this.clock(),
      })
      .where('id', '=', id)
      .execute()
    return this.get(user, id)
  }

  // New tables (E28)

  private requireAdmin(user: ImportUser): void {
    if (user.systemRole !== 'admin') throw new AppError('forbidden')
  }

  /**
   * Checks a table to create from the file: the definition itself, a schema user on the
   * connection, a free name (until the table exists), and a CSV column for every column a
   * row cannot do without.
   */
  private async checkNewTable(
    user: ImportUser,
    id: string,
    options: ImportParseOptions,
    newTable: NewTableImport,
    state: NewTableState | null,
  ): Promise<void> {
    this.requireAdmin(user)
    const definition = newTable.definition
    const created = state !== null && state.createdAt !== null
    if (created && JSON.stringify(state.definition) !== JSON.stringify(definition)) {
      throw new AppError('conflict', {
        errors: [{ field: 'newTable.definition', code: 'table_created' }],
      })
    }
    await this.deps.tables.schemaUser(definition.connectionId)
    const { headers } = await this.sample(id, options, 1)
    const errors: FieldError[] = checkNewTable(definition, {
      taken: created ? [] : await this.deps.tables.taken(definition.connectionId),
      sourceCount: headers.length,
    })
    const key = definition.primaryKey
    definition.columns.forEach((column, index) => {
      if (column.source !== null) return
      const isKey = key.kind === 'column' && key.column === column.name
      if (isKey || (column.required && column.default === null)) {
        errors.push({ field: `columns.${index}.source`, code: 'required' })
      }
    })
    if (errors.length > 0) {
      throw new AppError('validation_failed', {
        errors: errors.map((error) => ({ ...error, field: `newTable.definition.${error.field}` })),
      })
    }
  }

  /** A definition suggested from every value of the file (E28); all of it can be changed. */
  async suggestNewTable(
    user: ImportUser,
    id: string,
    connectionId: string,
  ): Promise<NewTableDefinition> {
    this.requireAdmin(user)
    const row = await this.row(user, id)
    await this.deps.tables.schemaUser(connectionId)
    const options = importParseOptions.parse(JSON.parse(row.parse_options))
    const { headers } = await this.sample(id, options, 1)
    const format = cellFormat(options, this.deps.timeZone)
    const stats = headers.map(() => emptyStats())
    let header = options.header
    for await (const record of records(this.file(id), options)) {
      if (header) {
        header = false
        continue
      }
      stats.forEach((entry, index) => addValue(entry, record.cells[index] ?? '', format))
    }
    const taken = await this.deps.tables.taken(connectionId)
    const base = row.file_name.replace(/\.[^.]*$/, '')
    const [name = 'imported'] = uniqueNames([normalizeName(base, 'imported')], taken)
    const keyName = 'id'
    const names = uniqueNames(
      headers.map((entry) => normalizeName(entry)),
      [keyName],
    )
    return {
      connectionId,
      name,
      primaryKey: { kind: 'added', name: keyName },
      columns: headers.map((_, index) => ({
        name: names[index] ?? `column_${index + 1}`,
        source: index,
        ...suggestType(stats[index] ?? emptyStats()),
        required: false,
        unique: false,
        default: null,
      })),
    }
  }

  /** The plan of the data step into a table this import creates. */
  private newTablePlan(state: NewTableState, options: ImportParseOptions): ImportPlan {
    const definition = state.definition
    const catalog = newTableCatalog(definition)
    const byName = new Map(catalog.map((column) => [column.name, column]))
    const key = definition.primaryKey
    const keyColumn = key.kind === 'added' ? key.name : key.column
    const columns: PlannedColumn[] = definition.columns.flatMap((column) => {
      const entry = byName.get(column.name)
      if (column.source === null || entry === undefined) return []
      return [
        {
          source: column.source,
          catalog: entry,
          column: {
            name: entry.name,
            kind: entry.kind,
            columnType: entry.columnType,
            nullable: entry.nullable,
            spec: fieldSpec(entry),
            defaultValue: entry.defaultValue,
            autoIncrement: false,
            generated: false,
            lock: false,
            insertable: true,
            updatable: false,
          },
        },
      ]
    })
    const mapped = new Set(columns.map((planned) => planned.column.name))
    return {
      table: {
        objectName: definition.name,
        columns: catalog,
        keyColumn,
        lock: { kind: 'values' },
        existing: false,
      },
      mode: 'insert',
      key: null,
      columns,
      format: cellFormat(options, this.deps.timeZone),
      skipFailed: state.skipFailed,
      // Unique columns and a primary key column are checked for duplicates in the file.
      uniqueKeys: [
        ...(key.kind === 'column' ? [[key.column]] : []),
        ...definition.columns
          .filter(
            (column) => column.unique && !(key.kind === 'column' && key.column === column.name),
          )
          .map((column) => [column.name]),
      ].filter((unique) => unique.every((name) => mapped.has(name))),
      foreignKeys: [],
      maxErrors: maxStoredErrors,
    }
  }

  // Dry run and import

  private startable(user: ImportUser): void {
    const mine = [...this.running.values()].filter((entry) => entry.userId === user.id).length
    if (this.running.size >= this.deps.limits.concurrency || mine >= this.deps.limits.perUser) {
      throw new AppError('rate_limited', {
        errors: [{ field: '_', code: 'import_running' }],
      })
    }
  }

  /** Checks the job's settings before a dry run or an import. */
  private async validate(user: ImportUser, row: ImportJobsTable): Promise<void> {
    if (row.new_table !== null) {
      const state = JSON.parse(row.new_table) as NewTableState
      const options = importParseOptions.parse(JSON.parse(row.parse_options))
      await this.checkNewTable(user, row.id, options, state, state)
      return
    }
    await this.prepared(row)
  }

  private async prepared(row: ImportJobsTable) {
    if (row.mapping === null) {
      throw new AppError('validation_failed', { errors: [{ field: 'mapping', code: 'required' }] })
    }
    const options = importParseOptions.parse(JSON.parse(row.parse_options))
    const mapping = importMapping.parse(JSON.parse(row.mapping))
    const resource = await this.resource(mapping.tableAccessId)
    const { headers } = await this.sample(row.id, options, 1)
    const plan = buildPlan(resource, mapping, options, headers.length, this.deps.timeZone)
    return { options, mapping, resource, plan }
  }

  /**
   * Streams the data rows in batches: through one write session for existing tables, the
   * schema user's session for a table this import created, and without any session for the
   * dry run of a table that does not exist yet.
   */
  private async process(
    row: ImportJobsTable,
    write: boolean,
    running: Running,
  ): Promise<{
    counts: ImportCounts
    errors: ImportCellError[]
    changed: Set<string>
    wrote: boolean
  }> {
    const counts: ImportCounts = {
      rows: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      skipped: 0,
    }
    const errors: ImportCellError[] = []
    const changed = new Set<string>()
    let wrote = false
    const options = importParseOptions.parse(JSON.parse(row.parse_options))
    const consume = async (importer: Importer, session: TargetSession | null) => {
      let batch: CsvRecord[] = []
      let header = options.header
      const flush = async () => {
        if (running.cancel) throw new Cancelled()
        const outcome = await importer.batch(session, batch, write)
        for (const key of Object.keys(counts) as (keyof ImportCounts)[])
          counts[key] += outcome.counts[key]
        for (const error of outcome.errors) if (errors.length < maxStoredErrors) errors.push(error)
        for (const column of outcome.changedColumns) changed.add(column)
        wrote ||= outcome.wroteRows
        running.rows = counts.rows
        batch = []
      }
      for await (const record of records(this.file(row.id), options)) {
        if (header) {
          header = false
          continue
        }
        batch.push(record)
        if (batch.length >= this.deps.limits.batchSize) await flush()
      }
      if (batch.length > 0) await flush()
      if (running.cancel) throw new Cancelled()
    }
    const transaction = async (session: TargetSession, work: () => Promise<void>) => {
      await session.query(write ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY')
      try {
        await work()
        await session.query(write ? 'COMMIT' : 'ROLLBACK')
      } catch (error) {
        await session.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }

    if (row.new_table !== null) {
      const state = JSON.parse(row.new_table) as NewTableState
      const connectionId = state.definition.connectionId
      const resolved = await this.deps.connections.resolve(connectionId)
      const importer = new Importer(this.newTablePlan(state, options), resolved.row.timezone)
      if (!write) await consume(importer, null)
      else {
        await this.deps.tables.withSchemaUser(connectionId, (session) =>
          transaction(session, () => consume(importer, session)),
        )
      }
      return { counts, errors, changed, wrote }
    }

    const { resource, plan } = await this.prepared(row)
    const resolved = await this.deps.connections.resolve(resource.connection.connectionId)
    const writer = resolved.users.write
    if (writer === undefined) throw new AppError('target_unavailable')
    const importer = new Importer(plan, resolved.row.timezone)
    await this.deps.pools.run(resource.connection.connectionId, resolved.spec, writer, (session) =>
      transaction(session, () => consume(importer, session)),
    )
    return { counts, errors, changed, wrote }
  }

  private async update(id: string, values: Partial<ImportJobsTable>): Promise<void> {
    await this.deps.db
      .updateTable('import_jobs')
      .set({ ...values, updated_at: this.clock() })
      .where('id', '=', id)
      .execute()
  }

  private start(
    user: ImportUser,
    row: ImportJobsTable,
    phase: Running['phase'],
    work: (running: Running) => Promise<void>,
  ): void {
    const running: Running = {
      userId: user.id,
      cancel: false,
      phase,
      rows: 0,
      done: Promise.resolve(),
    }
    this.running.set(row.id, running)
    running.done = work(running)
      .catch((error: unknown) => {
        this.deps.log.error({ err: error, importId: row.id }, 'import job failed')
      })
      .finally(() => this.running.delete(row.id))
  }

  private failure(error: unknown): ImportJob['failure'] {
    if (error instanceof ImportAbort) {
      return {
        code: 'import_stopped',
        errors: [{ field: error.column, code: error.code, params: { line: error.line } }],
      }
    }
    if (error instanceof AppError) {
      return { code: error.code, ...(error.errors !== undefined && { errors: error.errors }) }
    }
    return { code: 'internal_error' }
  }

  /** The dry run over every row (E23): reads only, counts new, updated and failed rows. */
  async dryRun(user: ImportUser, id: string): Promise<ImportJob> {
    const row = await this.row(user, id)
    if (this.running.has(id) || row.status === 'completed') throw new AppError('conflict')
    await this.validate(user, row)
    this.startable(user)
    await this.update(id, { status: 'checking', dry_run: null, result: null })
    this.start(user, row, 'checking', async (running) => {
      try {
        const result = await this.process(row, false, running)
        const dryRun: ImportDryRun = {
          fingerprint: fingerprintOf(row),
          counts: result.counts,
          errors: result.errors,
          checkedAt: this.clock(),
        }
        await this.update(id, { status: 'checked', dry_run: JSON.stringify(dryRun) })
      } catch (error) {
        const cancelled = error instanceof Cancelled
        await this.update(id, {
          status: cancelled ? 'uploaded' : 'failed',
          result: cancelled ? null : JSON.stringify({ failure: this.failure(error) }),
        })
        if (!cancelled && !(error instanceof AppError)) throw error
      }
    })
    return this.get(user, id)
  }

  /**
   * The import (§17 step 6): only with the settings of a passed dry run; failed rows in it
   * need `skipFailed`. One transaction, batches, one audit event (E24).
   */
  async run(user: ImportUser, actor: Actor, id: string): Promise<ImportJob> {
    const row = await this.row(user, id)
    if (this.running.has(id) || row.status !== 'checked' || row.dry_run === null) {
      throw new AppError('conflict', { errors: [{ field: '_', code: 'dry_run_required' }] })
    }
    const dryRun = JSON.parse(row.dry_run) as ImportDryRun
    if (dryRun.fingerprint !== fingerprintOf(row)) {
      throw new AppError('conflict', { errors: [{ field: '_', code: 'dry_run_required' }] })
    }
    if (row.new_table !== null) return this.runNewTable(user, actor, row, dryRun)
    const { mapping, resource } = await this.prepared(row)
    if (dryRun.counts.failed > 0 && !mapping.skipFailed) {
      throw new AppError('validation_failed', { errors: [{ field: '_', code: 'dry_run_failed' }] })
    }
    this.startable(user)
    await this.update(id, { status: 'importing' })
    const object = resource.object.objectName
    const connectionId = resource.connection.connectionId
    this.start(user, row, 'importing', async (running) => {
      const details = {
        fileName: row.file_name,
        fileSha256: row.file_sha256,
        fileSize: row.file_size,
        mode: mapping.mode,
        upsertKey: mapping.upsertKey,
        skipFailed: mapping.skipFailed,
        options: JSON.parse(row.parse_options) as unknown,
      }
      try {
        const result = await this.process(row, true, running)
        const finishedAt = this.clock()
        await this.update(id, {
          status: 'completed',
          result: JSON.stringify({ counts: result.counts, finishedAt }),
          finished_at: finishedAt,
        })
        await removeUpload(this.file(id))
        if (result.wrote) {
          this.deps.events.emit('rows.written', {
            connectionId,
            objects: affectedObjects(
              resource.connection.catalog,
              object,
              result.changed.size > 0 ? 'update' : null,
              [...result.changed],
            ),
          })
        }
        await this.deps.audit.record(actor, {
          action: 'import.completed',
          subject: { kind: 'import', id, label: row.file_name },
          connectionId,
          objectName: object,
          details: { ...details, counts: result.counts },
        })
      } catch (error) {
        const cancelled = error instanceof Cancelled
        await this.update(id, {
          status: cancelled ? 'cancelled' : 'failed',
          result: JSON.stringify({
            failure: cancelled ? { code: 'cancelled' } : this.failure(error),
          }),
        })
        // Nothing was written: the transaction rolled back. The attempt is audited anyway.
        await this.deps.audit.record(actor, {
          action: 'import.failed',
          subject: { kind: 'import', id, label: row.file_name },
          connectionId,
          objectName: object,
          details: { ...details, failure: cancelled ? { code: 'cancelled' } : this.failure(error) },
        })
        if (!cancelled && !(error instanceof AppError) && !(error instanceof ImportAbort))
          throw error
      }
    })
    return this.get(user, id)
  }

  /**
   * A new table (E28): `CREATE TABLE` through the schema user, then the data through the
   * schema user in one transaction, then catalog, table access and grants. Each finished step
   * is kept, so after a failure the next run picks up after the last one; the table itself
   * stays, since the schema user cannot drop it.
   */
  private async runNewTable(
    user: ImportUser,
    actor: Actor,
    row: ImportJobsTable,
    dryRun: ImportDryRun,
  ): Promise<ImportJob> {
    this.requireAdmin(user)
    let state = JSON.parse(row.new_table as string) as NewTableState
    const options = importParseOptions.parse(JSON.parse(row.parse_options))
    await this.checkNewTable(user, row.id, options, state, state)
    if (dryRun.counts.failed > 0 && !state.skipFailed) {
      throw new AppError('validation_failed', { errors: [{ field: '_', code: 'dry_run_failed' }] })
    }
    this.startable(user)
    const id = row.id
    await this.update(id, { status: 'importing' })
    const definition = state.definition
    const connectionId = definition.connectionId
    const save = async (patch: Partial<NewTableState>) => {
      state = { ...state, ...patch }
      await this.update(id, { new_table: JSON.stringify(state) })
    }
    this.start(user, row, 'importing', async (running) => {
      const details = {
        fileName: row.file_name,
        fileSha256: row.file_sha256,
        fileSize: row.file_size,
        mode: 'create_table',
        skipFailed: state.skipFailed,
        options: JSON.parse(row.parse_options) as unknown,
      }
      try {
        let ddl = state.outcome?.ddl
        if (state.createdAt === null || ddl === undefined) {
          const { headers } = await this.sample(id, options, 1)
          ddl = await this.deps.tables.create(actor, definition, {
            sourceCount: headers.length,
            importId: id,
          })
          await save({
            createdAt: this.clock(),
            outcome: { tableAccessId: null, ddl, readable: false, statements: [] },
          })
        }
        let counts = state.dataCounts
        if (state.dataDoneAt === null || counts === undefined) {
          counts = (await this.process(row, true, running)).counts
          await save({ dataDoneAt: this.clock(), dataCounts: counts })
        }
        const outcome = await this.deps.tables.finish(actor, definition, ddl)
        await save({ outcome })
        const finishedAt = this.clock()
        await this.update(id, {
          status: 'completed',
          table_access_id: outcome.tableAccessId,
          result: JSON.stringify({ counts, finishedAt }),
          finished_at: finishedAt,
        })
        await removeUpload(this.file(id))
        await this.deps.audit.record(actor, {
          action: 'import.completed',
          subject: { kind: 'import', id, label: row.file_name },
          connectionId,
          objectName: definition.name,
          details: { ...details, counts, tableAccessId: outcome.tableAccessId },
        })
      } catch (error) {
        const cancelled = error instanceof Cancelled
        const failure = cancelled ? { code: 'cancelled' } : this.failure(error)
        await this.update(id, {
          status: cancelled ? 'cancelled' : 'failed',
          result: JSON.stringify({ failure }),
        })
        await this.deps.audit.record(actor, {
          action: 'import.failed',
          subject: { kind: 'import', id, label: row.file_name },
          connectionId,
          objectName: definition.name,
          details: { ...details, failure, tableCreated: state.createdAt !== null },
        })
        if (!cancelled && !(error instanceof AppError) && !(error instanceof ImportAbort))
          throw error
      }
    })
    return this.get(user, id)
  }

  async cancel(user: ImportUser, id: string): Promise<ImportJob> {
    await this.row(user, id)
    const running = this.running.get(id)
    if (running !== undefined) running.cancel = true
    return this.get(user, id)
  }

  /** Waits for a running job (tests and shutdown). */
  async settled(id?: string): Promise<void> {
    const entries = id === undefined ? [...this.running.values()] : [this.running.get(id)]
    await Promise.all(entries.map((entry) => entry?.done ?? Promise.resolve()))
  }

  /** The dry run's problems as CSV (D1), at most 10,000. */
  async errorList(user: ImportUser, id: string): Promise<string> {
    const row = await this.row(user, id)
    if (row.dry_run === null) throw new AppError('not_found')
    const dryRun = JSON.parse(row.dry_run) as ImportDryRun
    return [
      '\uFEFF',
      csvRow(['line', 'column', 'code', 'details']),
      ...dryRun.errors.map((error) =>
        csvRow([
          error.line,
          error.column,
          error.code,
          error.params === undefined ? '' : JSON.stringify(error.params),
        ]),
      ),
    ].join('')
  }

  async remove(user: ImportUser, id: string): Promise<void> {
    await this.row(user, id)
    const running = this.running.get(id)
    if (running !== undefined) {
      running.cancel = true
      await running.done
    }
    await this.deps.db.deleteFrom('import_jobs').where('id', '=', id).execute()
    await removeUpload(this.file(id))
  }

  // Housekeeping

  /** Jobs that ran when the server stopped failed; their transaction rolled back (E27). */
  async recover(): Promise<void> {
    await this.deps.db
      .updateTable('import_jobs')
      .set({
        status: 'failed',
        result: JSON.stringify({ failure: { code: 'interrupted' } }),
        updated_at: this.clock(),
      })
      .where('status', 'in', ['checking', 'importing'])
      .execute()
  }

  /** Hourly: uploads and jobs older than 24 h go, and files without a job (§17 step 8). */
  async cleanup(): Promise<number> {
    const now = this.clock()
    const expired = await this.deps.db
      .selectFrom('import_jobs')
      .select('id')
      .where('expires_at', '<=', now)
      .execute()
    let removed = 0
    for (const { id } of expired) {
      if (this.running.has(id)) continue
      await this.deps.db.deleteFrom('import_jobs').where('id', '=', id).execute()
      await removeUpload(this.file(id))
      removed++
    }
    const dir = path.join(this.deps.dataDir, 'uploads')
    const known = new Set(
      (await this.deps.db.selectFrom('import_jobs').select('id').execute()).map(
        (row) => `${row.id}.csv`,
      ),
    )
    const files = await readdir(dir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.csv') || known.has(file)) continue
      // A file without a job may still be uploading; only old ones are left over.
      const modified = await stat(path.join(dir, file)).then(
        (info) => info.mtimeMs,
        () => now,
      )
      if (now - modified < 60 * 60 * 1000) continue
      await removeUpload(path.join(dir, file))
      removed++
    }
    return removed
  }
}
