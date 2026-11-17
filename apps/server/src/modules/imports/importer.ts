// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogColumn,
  CellFormat,
  FieldSpec,
  ImportCellError,
  ImportCounts,
  LockStrategy,
  ValueKind,
} from '@stashley/shared'
import { checkFieldValue, isEmptyCell, readCell } from '@stashley/shared'
import { encodeValue } from '../../target/encoding.ts'
import type { TargetSession } from '../../target/pools.ts'
import type { ResourceColumn } from '../access/service.ts'
import { keyIndexes, matchStatement } from '../execution/sql/table-sql.ts'
import type { TableModel } from '../execution/sql/table-model.ts'
import { bindWrite, updateRow, type WriteValue } from '../execution/sql/write-sql.ts'
import { translateWriteError, writeErrno } from '../execution/write-errors.ts'
import type { CsvRecord } from './files.ts'
import {
  insertRows,
  rowsByKeys,
  useDefault,
  weightStatement,
  type CellValue,
} from './import-sql.ts'

/**
 * The import engine (§17 steps 4–6): reads cells into the JSON forms of their columns,
 * resolves foreign keys in batches, finds duplicates in the file and in the table, and
 * writes batches with multi-row `INSERT` and `UPDATE` per changed row. The dry run runs the
 * same steps with reads only (E23).
 */

export interface PlannedReference {
  kind: 'unique' | 'display'
  /** Columns `value` (the referenced key) and `match` (unique column or display value). */
  model: TableModel
  matchKind: ValueKind
  matchSpec: FieldSpec | undefined
}

export interface PlannedColumn {
  source: number
  column: ResourceColumn
  catalog: CatalogColumn
  reference?: PlannedReference
}

/** The table an import writes: an exposed one, or one it created (no catalog entry yet). */
export interface ImportTable {
  objectName: string
  columns: readonly CatalogColumn[]
  keyColumn: string
  lock: LockStrategy
  /** False for a table created by this import: it is empty, nothing to look up (E28). */
  existing: boolean
}

export interface ImportPlan {
  table: ImportTable
  mode: 'insert' | 'upsert'
  /** Upsert key columns, all mapped. */
  key: string[] | null
  columns: PlannedColumn[]
  format: CellFormat
  skipFailed: boolean
  /** Unique keys (primary key included) whose columns are all mapped. */
  uniqueKeys: string[][]
  /** Foreign keys whose columns are mapped with raw values (no reference resolution). */
  foreignKeys: { columns: string[]; target: string; targetColumns: string[] }[]
  /** Only these many errors are kept in full; counts stay exact. */
  maxErrors: number
}

/** One row after reading and checks. */
interface Row {
  line: number
  values: Map<string, CellValue>
  failed: boolean
}

export interface BatchOutcome {
  counts: ImportCounts
  errors: ImportCellError[]
  /** Columns written, for the cache and cascades. */
  changedColumns: Set<string>
  wroteRows: boolean
}

/** Raised to stop an import without skipping: the whole transaction rolls back. */
export class ImportAbort extends Error {
  readonly line: number
  readonly code: string
  readonly column: string

  constructor(line: number, code: string, column = '_') {
    super(`Import stopped at line ${line}: ${code}`)
    this.name = 'ImportAbort'
    this.line = line
    this.code = code
    this.column = column
  }
}

const lower = (name: string) => name.toLowerCase()
const keyOf = (values: readonly unknown[]) => JSON.stringify(values)
function emptyCounts(): ImportCounts {
  return { rows: 0, created: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0 }
}

export class Importer {
  private readonly plan: ImportPlan
  private readonly timeZone: string
  /** Keys seen earlier in the file, per unique key. */
  private readonly seen = new Map<string, Set<string>>()
  private readonly lockColumn: CatalogColumn | undefined

  constructor(plan: ImportPlan, connectionTimeZone: string) {
    this.plan = plan
    this.timeZone = connectionTimeZone
    const lock = plan.table.lock
    this.lockColumn =
      lock.kind === 'values'
        ? undefined
        : plan.table.columns.find((column) => lower(column.name) === lower(lock.column))
  }

  private get lock(): LockStrategy {
    return this.plan.table.lock
  }

  private object(): string {
    return this.plan.table.objectName
  }

  private kindOf(column: string): ValueKind {
    return this.plan.table.columns.find((entry) => entry.name === column)?.kind ?? 'string'
  }

  private bind(column: string, value: CellValue): unknown {
    return value === useDefault ? value : bindWrite(this.kindOf(column), value, this.timeZone)
  }

  // Reading cells

  private read(record: CsvRecord, errors: ImportCellError[]): Row {
    const values = new Map<string, CellValue>()
    let failed = false
    const fail = (column: string, code: string, params?: Record<string, string | number>) => {
      failed = true
      errors.push({ line: record.line, column, code, ...(params !== undefined && { params }) })
    }
    for (const planned of this.plan.columns) {
      const name = planned.column.name
      const raw = record.cells[planned.source] ?? ''
      if (isEmptyCell(raw, this.plan.format)) {
        values.set(name, null)
        continue
      }
      if (planned.reference !== undefined) {
        values.set(name, raw.trim())
        continue
      }
      const cell = readCell(
        raw,
        planned.column.kind,
        this.plan.format,
        planned.column.spec.enumValues,
      )
      if (!cell.ok) {
        fail(name, cell.code)
        continue
      }
      const checked = checkFieldValue(planned.column.spec, cell.value)
      if (!checked.ok) {
        fail(name, checked.code, checked.params)
        continue
      }
      values.set(name, checked.value)
    }
    return { line: record.line, values, failed }
  }

  /** Looks up foreign key values by a unique column or the display value (E26). */
  private async resolve(
    session: TargetSession,
    rows: Row[],
    errors: ImportCellError[],
  ): Promise<void> {
    for (const planned of this.plan.columns) {
      const reference = planned.reference
      if (reference === undefined) continue
      const name = planned.column.name
      const texts = new Map<string, unknown>()
      for (const row of rows) {
        const text = row.values.get(name)
        if (typeof text !== 'string' || texts.has(text)) continue
        let match: unknown = text
        if (reference.kind === 'unique' && reference.matchSpec !== undefined) {
          const cell = readCell(text, reference.matchKind, this.plan.format)
          const checked = cell.ok ? checkFieldValue(reference.matchSpec, cell.value) : cell
          match = checked.ok
            ? bindWrite(reference.matchKind, checked.value, this.timeZone)
            : undefined
        }
        texts.set(text, match)
      }
      const wanted = [...new Set([...texts.values()].filter((value) => value !== undefined))]
      // The database says which wanted value each row matches, with its own collation, so
      // `ANNA@example.com` finds `anna@example.com` and equal display values are ambiguous.
      const found = new Map<unknown, unknown[]>()
      for (let start = 0; start < wanted.length; start += 500) {
        const chunk = wanted.slice(start, start + 500)
        const statement = matchStatement(reference.model, chunk)
        const result = await session.execute(statement.sql, statement.values)
        for (const [value, , matched] of result.rows) {
          for (const index of keyIndexes(matched)) {
            const probe = chunk[index]
            found.set(probe, [...(found.get(probe) ?? []), value])
          }
        }
      }
      for (const row of rows) {
        const text = row.values.get(name)
        if (typeof text !== 'string') continue
        const match = texts.get(text)
        const values = match === undefined ? [] : (found.get(match) ?? [])
        if (values.length === 1) {
          const encoded = encodeValue(
            planned.column.kind,
            values[0] as string | number,
            this.timeZone,
          )
          row.values.set(name, encoded.value)
        } else {
          row.failed = true
          errors.push({
            line: row.line,
            column: name,
            code: values.length === 0 ? 'foreign_key_violation' : 'ambiguous_reference',
          })
        }
      }
    }
  }

  /** NOT NULL columns: an empty cell takes the default on insert, or fails without one. */
  private required(row: Row, inserting: boolean, errors: ImportCellError[]): void {
    for (const planned of this.plan.columns) {
      const name = planned.column.name
      if (row.values.get(name) !== null || planned.catalog.nullable) continue
      if (planned.catalog.defaultValue !== null || planned.catalog.autoIncrement) {
        if (inserting) row.values.set(name, useDefault)
        else row.values.delete(name)
        continue
      }
      row.failed = true
      errors.push({ line: row.line, column: name, code: 'required' })
    }
  }

  /** Unique keys and the upsert key, each once. */
  private fileKeys(): string[][] {
    const all = [...this.plan.uniqueKeys, ...(this.plan.key === null ? [] : [this.plan.key])]
    return all.filter(
      (key, index) => all.findIndex((other) => other.join(',') === key.join(',')) === index,
    )
  }

  /**
   * Text key values as the database compares them (case, accents and trailing spaces as the
   * column's collation says): their weight strings, by column and text. Columns without a
   * known collation compare exactly.
   */
  private async weights(
    session: TargetSession | null,
    rows: Row[],
  ): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>()
    if (session === null) return out
    const columns = new Set(this.fileKeys().flat())
    for (const name of columns) {
      const column = this.plan.table.columns.find((entry) => entry.name === name)
      const collation = column?.collation
      if (column?.kind !== 'string' || collation === null || collation === undefined) continue
      const texts = [
        ...new Set(
          rows
            .filter((row) => !row.failed)
            .map((row) => row.values.get(name))
            .filter((value): value is string => typeof value === 'string'),
        ),
      ]
      const weights = new Map<string, string>()
      for (let start = 0; start < texts.length; start += 500) {
        const chunk = texts.slice(start, start + 500)
        const statement = weightStatement(collation, chunk)
        const [result] = (await session.execute(statement.sql, statement.values)).rows
        chunk.forEach((text, index) => weights.set(text, String(result?.[index] ?? text)))
      }
      out.set(name, weights)
    }
    return out
  }

  /** The same unique key twice in the file is an error on the later row. */
  private duplicates(
    row: Row,
    errors: ImportCellError[],
    weights: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ): void {
    for (const key of this.fileKeys()) {
      const values = key.map((column) => {
        const value = row.values.get(column)
        return typeof value === 'string' ? (weights.get(column)?.get(value) ?? value) : value
      })
      if (values.some((value) => value === null || value === undefined || value === useDefault))
        continue
      const name = key.join(',')
      const seen = this.seen.get(name) ?? new Set<string>()
      this.seen.set(name, seen)
      const text = keyOf(values)
      if (seen.has(text)) {
        row.failed = true
        errors.push({ line: row.line, column: key[0] as string, code: 'duplicate_in_file' })
      } else seen.add(text)
    }
  }

  // Classification

  /**
   * Existing rows by the upsert key, with their key and the mapped updatable columns. The
   * database matches the file's keys to rows with its own collation (`rowsByKeys`).
   */
  private async existing(
    session: TargetSession,
    rows: Row[],
    lock: boolean,
  ): Promise<Map<Row, { key: unknown; values: Map<string, unknown> }>> {
    const keyColumns = this.plan.key
    const found = new Map<Row, { key: unknown; values: Map<string, unknown> }>()
    if (keyColumns === null || rows.length === 0) return found
    const primary = this.plan.table.keyColumn
    const compared = this.updatable().map((planned) => planned.column.name)
    const tuples = rows.map((row) =>
      keyColumns.map((column) => this.bind(column, row.values.get(column))),
    )
    const statement = rowsByKeys(this.object(), keyColumns, [primary, ...compared], tuples, lock)
    const result = await session.execute(statement.sql, statement.values)
    const matched = keyColumns.length + 1 + compared.length
    for (const raw of result.rows) {
      const values = new Map<string, unknown>()
      compared.forEach((column, index) => {
        values.set(column, this.canonical(column, raw[keyColumns.length + 1 + index]))
      })
      const entry = { key: raw[keyColumns.length], values }
      for (const index of keyIndexes(raw[matched])) {
        const row = rows[index]
        if (row !== undefined) found.set(row, entry)
      }
    }
    return found
  }

  private canonical(column: string, raw: unknown): unknown {
    const planned = this.plan.columns.find((entry) => entry.column.name === column)
    const kind = this.kindOf(column)
    const encoded = encodeValue(kind, raw as string | number | null, this.timeZone).value
    if (encoded === null || planned === undefined) return encoded
    const checked = checkFieldValue(planned.column.spec, encoded)
    return checked.ok ? checked.value : encoded
  }

  private updatable(): PlannedColumn[] {
    const key = new Set((this.plan.key ?? []).map(lower))
    return this.plan.columns.filter(
      (planned) => planned.column.updatable && !key.has(lower(planned.column.name)),
    )
  }

  // Checks against the table (dry run)

  /** Unique keys of new or changed rows that exist in another row. */
  private async conflicts(
    session: TargetSession,
    rows: { row: Row; except: unknown }[],
    errors: ImportCellError[],
  ): Promise<void> {
    const primary = this.plan.table.keyColumn
    for (const key of this.plan.uniqueKeys) {
      const candidates = rows.filter(({ row }) =>
        key.every((column) => {
          const value = row.values.get(column)
          return value !== null && value !== undefined && value !== useDefault
        }),
      )
      for (let start = 0; start < candidates.length; start += 500) {
        const chunk = candidates.slice(start, start + 500)
        const statement = rowsByKeys(
          this.object(),
          key,
          [primary],
          chunk.map(({ row }) => key.map((column) => this.bind(column, row.values.get(column)))),
          false,
        )
        const result = await session.execute(statement.sql, statement.values)
        // By the database's comparison: the row a key would collide with in the index.
        const owners = new Map<number, string>()
        for (const raw of result.rows) {
          for (const index of keyIndexes(raw[key.length + 1])) {
            owners.set(index, String(raw[key.length]))
          }
        }
        for (const [index, { row, except }] of chunk.entries()) {
          const owner = owners.get(index)
          if (owner !== undefined && owner !== String(except)) {
            row.failed = true
            for (const column of key) {
              errors.push({ line: row.line, column, code: 'unique_violation' })
            }
          }
        }
      }
    }
  }

  /** Foreign keys given as raw values whose referenced row is missing. */
  private async missingReferences(
    session: TargetSession,
    rows: Row[],
    errors: ImportCellError[],
  ): Promise<void> {
    for (const foreign of this.plan.foreignKeys) {
      const candidates = rows.filter((row) =>
        foreign.columns.every((column) => {
          const value = row.values.get(column)
          return value !== null && value !== undefined && value !== useDefault
        }),
      )
      if (candidates.length === 0) continue
      const tuples = new Map<string, unknown[]>()
      for (const row of candidates) {
        const values = foreign.columns.map((column) => this.bind(column, row.values.get(column)))
        tuples.set(keyOf(values), values)
      }
      // The database matches the values with the target's collation, as the foreign key does.
      const present = new Set<string>()
      const all = [...tuples.entries()]
      try {
        for (let start = 0; start < all.length; start += 500) {
          const chunk = all.slice(start, start + 500)
          const statement = rowsByKeys(
            foreign.target,
            foreign.targetColumns,
            [],
            chunk.map(([, values]) => values),
            false,
          )
          const result = await session.execute(statement.sql, statement.values)
          for (const raw of result.rows) {
            for (const index of keyIndexes(raw[foreign.targetColumns.length])) {
              const entry = chunk[index]
              if (entry !== undefined) present.add(entry[0])
            }
          }
        }
      } catch (error) {
        // A target the write user cannot read is left to the database.
        const errno = writeErrno(error)
        if (errno === 1142 || errno === 1143) continue
        throw error
      }
      for (const row of candidates) {
        const values = foreign.columns.map((column) => this.bind(column, row.values.get(column)))
        if (!present.has(keyOf(values))) {
          row.failed = true
          for (const column of foreign.columns) {
            errors.push({ line: row.line, column, code: 'foreign_key_violation' })
          }
        }
      }
    }
  }

  /** The cell problems of one record, for the preview: no lookups, no duplicates. */
  check(record: CsvRecord): ImportCellError[] {
    const errors: ImportCellError[] = []
    const columns = this.plan.columns
    for (const planned of columns) {
      if (planned.reference !== undefined) continue
      const raw = record.cells[planned.source] ?? ''
      if (isEmptyCell(raw, this.plan.format)) {
        if (!planned.catalog.nullable && planned.catalog.defaultValue === null) {
          errors.push({ line: record.line, column: planned.column.name, code: 'required' })
        }
        continue
      }
      const cell = readCell(
        raw,
        planned.column.kind,
        this.plan.format,
        planned.column.spec.enumValues,
      )
      if (!cell.ok) {
        errors.push({ line: record.line, column: planned.column.name, code: cell.code })
        continue
      }
      const checked = checkFieldValue(planned.column.spec, cell.value)
      if (!checked.ok) {
        errors.push({
          line: record.line,
          column: planned.column.name,
          code: checked.code,
          ...(checked.params !== undefined && { params: checked.params }),
        })
      }
    }
    return errors
  }

  // Batches

  /**
   * Runs one batch. `write` false is the dry run: every check, no DML. With `write` true and
   * without `skipFailed`, the first failed row stops the import (`ImportAbort`).
   */
  async batch(
    session: TargetSession | null,
    records: CsvRecord[],
    write: boolean,
  ): Promise<BatchOutcome> {
    const counts = emptyCounts()
    const errors: ImportCellError[] = []
    const changedColumns = new Set<string>()
    const rows = records.map((record) => this.read(record, errors))
    counts.rows = rows.length
    // A table this import created is empty and has no foreign keys: nothing to look up, and
    // its dry run runs before the table exists, without a session.
    const lookups = this.plan.table.existing
    if (lookups && session === null) throw new Error('Existing tables need a session')
    if (lookups && session !== null) {
      await this.resolve(
        session,
        rows.filter((row) => !row.failed),
        errors,
      )
    }

    const upsert = this.plan.mode === 'upsert'
    const found =
      upsert && lookups && session !== null
        ? await this.existing(
            session,
            rows.filter((row) => !row.failed),
            write,
          )
        : new Map<Row, { key: unknown; values: Map<string, unknown> }>()
    const weights = await this.weights(session, rows)
    const inserts: Row[] = []
    const updates: { row: Row; key: unknown; changes: Map<string, unknown> }[] = []
    for (const row of rows) {
      if (row.failed) continue
      const existing = upsert ? found.get(row) : undefined
      this.required(row, existing === undefined, errors)
      if (row.failed) continue
      this.duplicates(row, errors, weights)
      if (row.failed) continue
      if (existing === undefined) {
        inserts.push(row)
        continue
      }
      const changes = new Map<string, unknown>()
      for (const planned of this.updatable()) {
        const name = planned.column.name
        if (!row.values.has(name)) continue
        const value = row.values.get(name)
        if (JSON.stringify(existing.values.get(name) ?? null) !== JSON.stringify(value ?? null)) {
          changes.set(name, value)
        }
      }
      if (changes.size === 0) counts.unchanged++
      else updates.push({ row, key: existing.key, changes })
    }

    if (!write) {
      if (!lookups || session === null) {
        counts.created = inserts.length
        counts.failed = rows.filter((row) => row.failed).length
        errors.sort((a, b) => a.line - b.line)
        return { counts, errors, changedColumns, wroteRows: false }
      }
      await this.conflicts(
        session,
        [
          ...inserts.map((row) => ({ row, except: undefined })),
          ...updates.map(({ row, key }) => ({ row, except: key })),
        ],
        errors,
      )
      await this.missingReferences(
        session,
        [...inserts, ...updates.map((update) => update.row)],
        errors,
      )
      counts.created = inserts.filter((row) => !row.failed).length
      counts.updated = updates.filter(({ row }) => !row.failed).length
      counts.failed = rows.filter((row) => row.failed).length
      errors.sort((a, b) => a.line - b.line)
      return { counts, errors, changedColumns, wroteRows: false }
    }

    if (session === null) throw new Error('Writing needs a session')
    const failed = rows.filter((row) => row.failed)
    if (failed.length > 0 && !this.plan.skipFailed) {
      const first = errors[0]
      throw new ImportAbort(failed[0]?.line ?? 0, first?.code ?? 'invalid', first?.column)
    }
    counts.skipped = failed.length
    const written = await this.writeRows(session, inserts, updates, errors, counts)
    for (const column of written) changedColumns.add(column)
    return { counts, errors, changedColumns, wroteRows: counts.created + counts.updated > 0 }
  }

  /** The columns a new row writes, and what the server adds (the lock column). */
  private insertColumns(): { columns: string[]; lockValue: unknown } {
    const columns = this.plan.columns
      .filter((planned) => planned.column.insertable)
      .map((planned) => planned.column.name)
    const lock = this.lock
    const column = this.lockColumn
    if (
      column !== undefined &&
      column.defaultValue === null &&
      !columns.some((name) => lower(name) === lower(column.name))
    ) {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
      return {
        columns: [...columns, column.name],
        lockValue: bindWrite(column.kind, lock.kind === 'version' ? 1 : now, this.timeZone),
      }
    }
    return { columns, lockValue: undefined }
  }

  private insertStatement(rows: Row[]) {
    const { columns, lockValue } = this.insertColumns()
    const values = rows.map((row) =>
      columns.map((column) =>
        lockValue !== undefined && column === this.lockColumn?.name
          ? lockValue
          : this.bind(column, row.values.has(column) ? row.values.get(column) : useDefault),
      ),
    )
    return insertRows(this.object(), columns, values)
  }

  private updateStatement(key: unknown, changes: Map<string, unknown>) {
    const sets: [string, WriteValue][] = [...changes].map(([column, value]) => [
      column,
      { value: this.bind(column, value) },
    ])
    const lock = this.lock
    if (lock.kind === 'version') sets.push([lock.column, { expression: 'increment' }])
    if (lock.kind === 'timestamp' && lock.setByServer && this.lockColumn !== undefined) {
      sets.push([
        lock.column,
        {
          value: bindWrite(
            this.lockColumn.kind,
            new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
            this.timeZone,
          ),
        },
      ])
    }
    return updateRow(this.object(), this.plan.table.keyColumn, key, sets)
  }

  /**
   * Writes a batch. Without `skipFailed` any database error stops the import. With it, a
   * refused batch is rolled back to its savepoint and written row by row, each row with its
   * own savepoint, so only the failed rows are left out.
   */
  private async writeRows(
    session: TargetSession,
    inserts: Row[],
    updates: { row: Row; key: unknown; changes: Map<string, unknown> }[],
    errors: ImportCellError[],
    counts: ImportCounts,
  ): Promise<string[]> {
    const changed = new Set<string>()
    const all = async () => {
      if (inserts.length > 0) {
        const statement = this.insertStatement(inserts)
        await session.write(statement.sql, statement.values)
      }
      for (const update of updates) {
        const statement = this.updateStatement(update.key, update.changes)
        await session.write(statement.sql, statement.values)
      }
    }
    const note = () => {
      for (const update of updates) for (const column of update.changes.keys()) changed.add(column)
    }
    if (!this.plan.skipFailed) {
      try {
        await all()
      } catch (error) {
        const code = translateWriteError(error).code
        throw new ImportAbort(inserts[0]?.line ?? updates[0]?.row.line ?? 0, code)
      }
      counts.created += inserts.length
      counts.updated += updates.length
      note()
      return [...changed]
    }
    await session.query('SAVEPOINT stashley_batch')
    try {
      await all()
      await session.query('RELEASE SAVEPOINT stashley_batch')
      counts.created += inserts.length
      counts.updated += updates.length
      note()
      return [...changed]
    } catch (error) {
      if (writeErrno(error) === undefined) throw error
      await session.query('ROLLBACK TO SAVEPOINT stashley_batch')
    }
    // Row by row, so a refused row only skips itself.
    const single = async (line: number, run: () => Promise<void>) => {
      await session.query('SAVEPOINT stashley_row')
      try {
        await run()
        await session.query('RELEASE SAVEPOINT stashley_row')
        return true
      } catch (error) {
        if (writeErrno(error) === undefined) throw error
        await session.query('ROLLBACK TO SAVEPOINT stashley_row')
        errors.push({ line, column: '_', code: translateWriteError(error).code })
        counts.skipped++
        return false
      }
    }
    for (const row of inserts) {
      const ok = await single(row.line, async () => {
        const statement = this.insertStatement([row])
        await session.write(statement.sql, statement.values)
      })
      if (ok) counts.created++
    }
    for (const update of updates) {
      const ok = await single(update.row.line, async () => {
        const statement = this.updateStatement(update.key, update.changes)
        await session.write(statement.sql, statement.values)
      })
      if (ok) {
        counts.updated++
        for (const column of update.changes.keys()) changed.add(column)
      }
    }
    await session.query('RELEASE SAVEPOINT stashley_batch').catch(() => undefined)
    return [...changed]
  }
}
