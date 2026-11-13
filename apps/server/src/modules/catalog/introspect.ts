// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogColumn, CatalogObject } from '@stashley/shared'
import { enumValues, valueKind } from '@stashley/shared'
import type { TargetSession } from '../../target/pools.ts'
import { viewTables } from './view-deps.ts'

interface TableRow {
  name: string
  type: string
  rowEstimate: number | string | null
}
interface ColumnRow {
  object: string
  name: string
  position: number | string
  dataType: string
  columnType: string
  nullable: string
  defaultValue: string | null
  extra: string | null
  maxLength: number | string | null
  numericPrecision: number | string | null
  numericScale: number | string | null
  datetimePrecision: number | string | null
}
interface IndexRow {
  object: string
  indexName: string
  nonUnique: number | string
  sequence: number | string
  column: string
}
interface ForeignKeyRow {
  object: string
  constraintName: string
  column: string
  position: number | string
  targetSchema: string | null
  targetObject: string
  targetColumn: string
}
interface ViewRow {
  name: string
  definition: string | null
}
interface ViewUsageRow {
  viewName: string
  tableName: string
}

const num = (value: number | string | null): number | null =>
  value === null || value === '' ? null : Number(value)

/** Normalizes column defaults; MariaDB quotes string defaults and reports `NULL` as text. */
function normalizeDefault(value: string | null, nullable: boolean): string | null {
  if (value === null) return null
  if (value === 'NULL' && nullable) return null
  const quoted = /^'(.*)'$/s.exec(value)
  return quoted === null ? value : (quoted[1] ?? '').replace(/''/g, "'")
}

function column(row: ColumnRow): CatalogColumn {
  const extra = (row.extra ?? '').toLowerCase()
  const nullable = row.nullable === 'YES'
  const kind = valueKind(row.dataType, row.columnType)
  return {
    name: row.name,
    position: Number(row.position),
    dataType: row.dataType.toLowerCase(),
    columnType: row.columnType,
    kind,
    nullable,
    defaultValue: normalizeDefault(row.defaultValue, nullable),
    autoIncrement: extra.includes('auto_increment'),
    generated: /generated|virtual|persistent|stored/.test(extra),
    maxLength: num(row.maxLength),
    precision: num(row.numericPrecision) ?? num(row.datetimePrecision),
    scale: num(row.numericScale),
    ...((kind === 'enum' || kind === 'set') && { enumValues: enumValues(row.columnType) }),
  }
}

/**
 * Reads the schema as the read user sees it (§9.3), so the catalog holds exactly the
 * objects that user can query.
 */
export async function introspect(
  session: TargetSession,
  database: string,
): Promise<CatalogObject[]> {
  const tables = await session.query<TableRow>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS rowEstimate
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [database],
  )
  const columns = await session.query<ColumnRow>(
    `SELECT TABLE_NAME AS object, COLUMN_NAME AS name, ORDINAL_POSITION AS position,
            DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
            CHARACTER_MAXIMUM_LENGTH AS maxLength, NUMERIC_PRECISION AS numericPrecision,
            NUMERIC_SCALE AS numericScale, DATETIME_PRECISION AS datetimePrecision
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  )
  const indexes = await session.query<IndexRow>(
    `SELECT TABLE_NAME AS object, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence, COLUMN_NAME AS \`column\`
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [database],
  )
  const foreignKeys = await session.query<ForeignKeyRow>(
    `SELECT TABLE_NAME AS object, CONSTRAINT_NAME AS constraintName, COLUMN_NAME AS \`column\`,
            ORDINAL_POSITION AS position, REFERENCED_TABLE_SCHEMA AS targetSchema,
            REFERENCED_TABLE_NAME AS targetObject, REFERENCED_COLUMN_NAME AS targetColumn
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [database],
  )
  const views = await session.query<ViewRow>(
    `SELECT TABLE_NAME AS name, VIEW_DEFINITION AS definition
       FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
    [database],
  )
  let viewUsage: ViewUsageRow[] | undefined
  if (session.engine === 'mysql') {
    viewUsage = await session.query<ViewUsageRow>(
      `SELECT VIEW_NAME AS viewName, TABLE_NAME AS tableName
         FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA = ? AND TABLE_SCHEMA = ?`,
      [database, database],
    )
  }

  const objects = new Map<string, CatalogObject>()
  for (const table of tables) {
    const isView = table.type.toUpperCase() === 'VIEW'
    objects.set(table.name, {
      name: table.name,
      type: isView ? 'view' : 'table',
      rowEstimate: isView ? null : num(table.rowEstimate),
      columns: [],
      primaryKey: [],
      uniqueKeys: [],
      foreignKeys: [],
    })
  }
  for (const row of columns) objects.get(row.object)?.columns.push(column(row))

  const keys = new Map<string, { object: string; unique: boolean; columns: string[] }>()
  for (const row of indexes) {
    const key = `${row.object}\u0000${row.indexName}`
    const entry = keys.get(key) ?? {
      object: row.object,
      unique: Number(row.nonUnique) === 0,
      columns: [],
    }
    entry.columns.push(row.column)
    keys.set(key, entry)
  }
  for (const [key, entry] of keys) {
    const object = objects.get(entry.object)
    if (object === undefined || !entry.unique) continue
    if (key.endsWith('\u0000PRIMARY')) object.primaryKey = entry.columns
    else object.uniqueKeys.push(entry.columns)
  }

  const constraints = new Map<
    string,
    { object: string; fk: CatalogObject['foreignKeys'][number] }
  >()
  for (const row of foreignKeys) {
    // References into other schemas cannot be followed in Stashley.
    if (row.targetSchema !== null && row.targetSchema !== database) continue
    const key = `${row.object}\u0000${row.constraintName}`
    const entry = constraints.get(key) ?? {
      object: row.object,
      fk: {
        name: row.constraintName,
        columns: [],
        targetObject: row.targetObject,
        targetColumns: [],
      },
    }
    entry.fk.columns.push(row.column)
    entry.fk.targetColumns.push(row.targetColumn)
    constraints.set(key, entry)
  }
  for (const { object, fk } of constraints.values()) objects.get(object)?.foreignKeys.push(fk)

  const direct = new Map<string, string[]>()
  for (const view of views) {
    if (viewUsage !== undefined) {
      direct.set(
        view.name,
        viewUsage.filter((usage) => usage.viewName === view.name).map((usage) => usage.tableName),
      )
    } else {
      direct.set(view.name, viewTables(view.definition ?? '', database))
    }
  }
  for (const view of views) {
    const object = objects.get(view.name)
    if (object === undefined) continue
    object.baseTables = resolveBaseTables(view.name, direct, objects)
    object.keyCandidates = keyCandidates(object, objects)
  }
  return [...objects.values()]
}

/** Follows nested views down to base tables. */
function resolveBaseTables(
  view: string,
  direct: Map<string, string[]>,
  objects: Map<string, CatalogObject>,
): string[] {
  const result = new Set<string>()
  const seen = new Set<string>([view])
  const queue = [...(direct.get(view) ?? [])]
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    if (direct.has(name)) queue.push(...(direct.get(name) ?? []))
    else if (objects.get(name)?.type !== 'view') result.add(name)
  }
  return [...result].sort()
}

/** Columns named like the key of a base table, e.g. `id` or `anmeldung_id`. */
function keyCandidates(view: CatalogObject, objects: Map<string, CatalogObject>): string[] {
  const names = new Set<string>()
  for (const base of view.baseTables ?? []) {
    const table = objects.get(base)
    const pk = table?.primaryKey.length === 1 ? table.primaryKey[0] : undefined
    if (pk !== undefined) {
      names.add(pk)
      names.add(`${base}_${pk}`)
    }
  }
  return view.columns.filter((column) => names.has(column.name)).map((column) => column.name)
}
