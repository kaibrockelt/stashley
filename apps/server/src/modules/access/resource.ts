// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiOperation,
  CatalogColumn,
  CatalogObject,
  FieldSpec,
  FormField,
  OpMask,
  TableOp,
  ValueKind,
} from '@stashley/shared'
import {
  apiOperationNeeds,
  apiOperationsFor,
  columnRequired,
  editableKind,
  emptyPage,
  fieldSpec,
  hasOp,
  opBits,
  toOps,
  widgetsFor,
} from '@stashley/shared'
import { buildTableModel, ModelError, type TableModel } from '../execution/sql/table-model.ts'
import type { CompiledTableSource } from './compile.ts'
import { AccessFacts, type ConnectionFacts, type ObjectFacts } from './facts.ts'
import { buildWriteModel, type WriteModel } from './write-model.ts'

/**
 * The model of a public API resource (§16): one exposed object with every column not
 * excluded for everyone, raw values without display values or linked columns (E16), and no
 * base filter. Built from table access, catalog and grant reports, like a compiled page.
 */

export interface ResourceColumn {
  name: string
  kind: ValueKind
  columnType: string
  nullable: boolean
  /** The row schema of the column; `required` on create. */
  spec: FieldSpec
  defaultValue: string | null
  autoIncrement: boolean
  generated: boolean
  /** The column the server uses to detect concurrent edits (E7); never written by clients. */
  lock: boolean
  /** Writable on create and on update (E16); within the write user's column grants. */
  insertable: boolean
  updatable: boolean
}

export interface ResourceModel {
  tableAccessId: string
  alias: string
  connection: ConnectionFacts
  object: ObjectFacts
  catalog: CatalogObject
  /** Readable columns in catalog order. */
  columns: ResourceColumn[]
  /** The key column; for views without one, reads page by position (`keyless`). */
  keyColumn: string
  keyless: boolean
  /** Reads every readable column, by column name. */
  read: TableModel
  /** Tables only; the record it reads back is `read`. */
  write: WriteModel | null
  /** Columns `PUT /?on=` may name (E18). */
  upsertColumns: string[]
  /** Operations the object, the ceiling and the database grants allow. */
  available: ApiOperation[]
  /** The source the write path works on. */
  source: CompiledTableSource
}

const lower = (name: string) => name.toLowerCase()
const apiDocument = emptyPage('dashboard', 'API')

function readableColumns(catalog: CatalogObject, object: ObjectFacts): CatalogColumn[] {
  const excluded = new Set([...object.excluded].map(lower))
  return catalog.columns.filter(
    (column) => !excluded.has(lower(column.name)) && column.kind !== 'unsupported',
  )
}

/**
 * Builds the resource model of an exposed object, or undefined when it cannot serve
 * (inactive, gone from the catalog, a table without a single-column key).
 */
export function buildResourceModel(
  connection: ConnectionFacts,
  object: ObjectFacts,
  alias: string,
): ResourceModel | undefined {
  const catalog = connection.catalog.get(object.objectName)
  if (catalog === undefined || !object.active) return undefined
  if (object.objectType === 'table' && object.keyColumn === null) return undefined
  const columns = readableColumns(catalog, object)
  if (columns.length === 0) return undefined
  const keyless = object.keyColumn === null
  // A view without a key column pages by position; its first column stands in for the key.
  const keyColumn = object.keyColumn ?? (columns[0] as CatalogColumn).name
  // The write path reads its rows back even where the ceiling has no read (create-only
  // tables); `available` below still leaves out every read operation then.
  const readable: ConnectionFacts = {
    ...connection,
    access: (name) => {
      const found = connection.access(name)
      return found === undefined || name !== object.objectName
        ? found
        : { ...found, keyColumn, ceiling: found.ceiling | opBits.read }
    },
  }
  let read: TableModel
  try {
    read = buildTableModel(
      object.objectName,
      {
        columns: columns.map((column) => ({
          kind: 'column' as const,
          id: column.name,
          column: { path: [], column: column.name },
        })),
        sort: null,
        searchColumns: [],
        baseFilter: [],
        bindings: [],
        pageSize: 100,
        editing: null,
        csvExport: false,
      },
      readable,
      'resource',
    )
  } catch (error) {
    if (error instanceof ModelError) return undefined
    throw error
  }

  const lock = object.lock
  const lockColumn = lock.kind === 'values' ? undefined : lower(lock.column)
  const grantedFor = (op: 'create' | 'update', column: string) => {
    const allowed = object.writable[op]
    return allowed === null || allowed.has(lower(column))
  }
  const isTable = object.objectType === 'table'
  const key = lower(keyColumn)
  const resourceColumns: ResourceColumn[] = columns.map((column) => {
    const writable =
      isTable &&
      !column.generated &&
      !column.autoIncrement &&
      editableKind(column.kind) &&
      lower(column.name) !== lockColumn
    return {
      name: column.name,
      kind: column.kind,
      columnType: column.columnType,
      nullable: column.nullable,
      spec: fieldSpec(column),
      defaultValue: column.defaultValue,
      autoIncrement: column.autoIncrement,
      generated: column.generated,
      lock: lower(column.name) === lockColumn,
      insertable: writable && grantedFor('create', column.name),
      updatable: writable && lower(column.name) !== key && grantedFor('update', column.name),
    }
  })

  let write: WriteModel | null = null
  // Deletes need no write model, only the key.
  let writeOps: OpMask = isTable && hasOp(object.ceiling, 'delete') ? opBits.delete : 0
  if (isTable) {
    const fields: FormField[] = resourceColumns
      .filter((column) => column.insertable || column.updatable)
      .map((column) => {
        const widget = widgetsFor(column.kind, column.columnType, false)[0]
        return {
          id: column.name,
          column: column.name,
          kind: 'input' as const,
          required: false,
          hidden: false,
          ...(widget !== undefined && { widget }),
        }
      })
    // A table whose required columns cannot all be written still updates (E16).
    for (const ops of [
      { create: true, update: true },
      { create: false, update: true },
    ]) {
      let failed = false
      const built = buildWriteModel(
        readable,
        { ...object, ceiling: object.ceiling | opBits.read },
        {
          path: 'resource',
          fieldsPath: 'resource.fields',
          fields,
          mode: 'api',
          ops,
          upsertKey: null,
          baseFilter: [],
          // Only defaults read the document; API fields have none.
          document: apiDocument,
        },
        (_path, _code, _params, warning) => {
          if (warning !== true) failed = true
        },
      )
      if (failed || built.model === undefined) continue
      write = { ...built.model, row: read }
      writeOps |= ((ops.create ? opBits.create : 0) | opBits.update) & ~built.withheld
      break
    }
    // A required column the client cannot write, excluded ones included, rules out create;
    // the server fills only the lock column.
    const insertable = new Set(
      resourceColumns.filter((column) => column.insertable).map((column) => lower(column.name)),
    )
    if (
      catalog.columns.some(
        (column) =>
          columnRequired(column) &&
          lower(column.name) !== lockColumn &&
          !insertable.has(lower(column.name)),
      )
    ) {
      writeOps &= ~opBits.create
    }
  }

  // Database grants and the write model decide what is left of the ceiling.
  const allowed: TableOp[] = toOps(object.ceiling & object.dbGrants).filter(
    (op) => op === 'read' || (writeOps & opBits[op]) !== 0,
  )
  const available = apiOperationsFor({
    objectType: object.objectType,
    keyColumn: object.keyColumn,
    ceiling: allowed,
  }).filter((operation) => apiOperationNeeds[operation].every((op) => allowed.includes(op)))

  // Upserts find their row by the primary key unless it is auto-increment, or by a
  // single-column unique key (E18); the column must be writable on create.
  const insertable = new Set(
    resourceColumns.filter((column) => column.insertable).map((column) => lower(column.name)),
  )
  const upsertColumns = [catalog.primaryKey, ...catalog.uniqueKeys]
    .filter((columns) => columns.length === 1)
    .map((columns) => columns[0] as string)
    .filter((column, index, all) => all.indexOf(column) === index && insertable.has(lower(column)))

  const dependencies = AccessFacts.dependencies(connection, [object.objectName])
  return {
    tableAccessId: object.tableAccessId,
    alias,
    connection,
    object,
    catalog,
    columns: resourceColumns,
    keyColumn,
    keyless,
    read,
    write,
    upsertColumns,
    available,
    source: {
      kind: 'table',
      connection,
      object,
      model: read,
      write,
      dependencies: { connectionId: connection.connectionId, ...dependencies, variables: [] },
      cacheTtlSeconds: 0,
    },
  }
}
