// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogColumn,
  CellFormat,
  FieldError,
  ImportColumnMapping,
  ImportMapping,
  ImportParseOptions,
  ImportTarget,
} from '@stashley/shared'
import { columnRequired, fieldSpec, hasOp, matchKey } from '@stashley/shared'
import { AppError } from '../../platform/http/problem.ts'
import type { ResourceModel } from '../access/service.ts'
import { buildTableModel, ModelError } from '../execution/sql/table-model.ts'
import type { ImportPlan, PlannedColumn, PlannedReference } from './importer.ts'

/**
 * The plan of an import into an existing table (§17 step 3, E22): which CSV column fills
 * which writable column, how foreign keys resolve, which key an upsert uses, and the
 * required columns a new row needs. Everything is checked against the resource model:
 * exclusions, column grants, ceiling and database grants.
 */

const lower = (name: string) => name.toLowerCase()

export const maxStoredErrors = 10_000

function invalid(errors: FieldError[]): AppError {
  return new AppError('validation_failed', { errors })
}

/**
 * The modes a table allows: insert needs create; upsert create, update and read (E22). An
 * upsert compares stored values and counts unchanged rows, which would let anyone guess the
 * values of a table they may not read, so without read only insert is left.
 */
export function importModes(resource: ResourceModel): ImportTarget['modes'] {
  const create = resource.available.includes('create')
  const update = resource.available.includes('update')
  const read = hasOp(resource.object.ceiling & resource.object.dbGrants, 'read')
  return create ? (update && read ? ['insert', 'upsert'] : ['insert']) : []
}

function required(resource: ResourceModel, column: CatalogColumn): boolean {
  const lock = resource.write?.lock
  const lockColumn = lock === undefined || lock.kind === 'values' ? undefined : lock.column
  return columnRequired(column) && lower(column.name) !== lower(lockColumn ?? '')
}

/** Keys an upsert can use: the primary key unless auto-increment, unique keys without NULL. */
export function upsertKeys(resource: ResourceModel): string[][] {
  const catalog = resource.catalog
  const insertable = new Set(
    resource.columns.filter((column) => column.insertable).map((column) => lower(column.name)),
  )
  return [catalog.primaryKey, ...catalog.uniqueKeys].filter(
    (key) =>
      key.length > 0 &&
      key.every((name) => {
        const column = catalog.columns.find((entry) => entry.name === name)
        return (
          column !== undefined &&
          !column.nullable &&
          !column.autoIncrement &&
          !column.generated &&
          insertable.has(lower(name))
        )
      }),
  )
}

/** The foreign key target of a column: catalog keys and virtual relations, single column. */
function referenceOf(
  resource: ResourceModel,
  column: string,
): { object: string; column: string } | undefined {
  for (const foreign of resource.catalog.foreignKeys) {
    if (foreign.columns.length === 1 && foreign.columns[0] === column) {
      return { object: foreign.targetObject, column: foreign.targetColumns[0] as string }
    }
  }
  const relation = resource.connection.relations.find(
    (entry) => entry.sourceObject === resource.object.objectName && entry.sourceColumn === column,
  )
  return relation === undefined
    ? undefined
    : { object: relation.targetObject, column: relation.targetColumn }
}

/** Single-column unique keys of an exposed, readable target, without excluded columns. */
function uniqueColumnsOf(resource: ResourceModel, object: string): string[] {
  const access = resource.connection.access(object)
  const catalog = resource.connection.catalog.get(object)
  if (access === undefined || catalog === undefined || !access.active) return []
  if (!hasOp(access.ceiling, 'read')) return []
  const excluded = new Set([...access.excluded].map(lower))
  return [catalog.primaryKey, ...catalog.uniqueKeys]
    .filter((key) => key.length === 1)
    .map((key) => key[0] as string)
    .filter((name, index, all) => all.indexOf(name) === index && !excluded.has(lower(name)))
}

export function importTarget(resource: ResourceModel): ImportTarget {
  const catalog = resource.catalog
  return {
    tableAccessId: resource.tableAccessId,
    connectionId: resource.connection.connectionId,
    objectName: resource.object.objectName,
    columns: resource.columns
      .filter((column) => column.insertable || column.updatable)
      .map((column) => {
        const entry = catalog.columns.find((item) => item.name === column.name) as CatalogColumn
        const reference = referenceOf(resource, column.name)
        return {
          name: column.name,
          kind: column.kind,
          required: required(resource, entry),
          insertable: column.insertable,
          updatable: column.updatable,
          ...(reference !== undefined && {
            reference: {
              object: reference.object,
              uniqueColumns: uniqueColumnsOf(resource, reference.object),
            },
          }),
        }
      }),
    modes: importModes(resource),
    upsertKeys: upsertKeys(resource),
  }
}

/** Mapping suggested by normalized names (§17 step 3). */
export function suggestMapping(
  resource: ResourceModel,
  headers: readonly string[],
): ImportColumnMapping[] {
  const target = importTarget(resource)
  const used = new Set<string>()
  const out: ImportColumnMapping[] = []
  headers.forEach((header, source) => {
    const key = matchKey(header)
    if (key === '') return
    const column = target.columns.find(
      (entry) => entry.insertable && !used.has(entry.name) && matchKey(entry.name) === key,
    )
    if (column === undefined) return
    used.add(column.name)
    out.push({ source, target: column.name })
  })
  return out
}

function referenceModel(
  resource: ResourceModel,
  column: string,
  mapping: NonNullable<ImportColumnMapping['reference']>,
  field: string,
): PlannedReference {
  const reference = referenceOf(resource, column)
  if (reference === undefined) throw invalid([{ field, code: 'not_a_reference' }])
  const connection = resource.connection
  const access = connection.access(reference.object)
  const catalog = connection.catalog.get(reference.object)
  if (
    access === undefined ||
    catalog === undefined ||
    !access.active ||
    !hasOp(access.ceiling, 'read') ||
    access.keyColumn === null
  ) {
    throw invalid([{ field, code: 'object_not_readable' }])
  }
  let matchColumn: CatalogColumn | undefined
  if (mapping.via === 'unique') {
    if (!uniqueColumnsOf(resource, reference.object).includes(mapping.column)) {
      throw invalid([{ field: `${field}.column`, code: 'not_unique' }])
    }
    matchColumn = catalog.columns.find((entry) => entry.name === mapping.column)
  }
  try {
    const model = buildTableModel(
      reference.object,
      {
        columns: [
          { kind: 'column', id: 'value', column: { path: [], column: reference.column } },
          mapping.via === 'unique'
            ? { kind: 'column', id: 'match', column: { path: [], column: mapping.column } }
            : { kind: 'display', id: 'match', path: [] },
        ],
        sort: null,
        searchColumns: [],
        baseFilter: [],
        bindings: [],
        pageSize: 1,
        editing: null,
        csvExport: false,
      },
      connection,
      field,
    )
    return {
      kind: mapping.via,
      model,
      matchKind: matchColumn?.kind ?? 'string',
      matchSpec: matchColumn === undefined ? undefined : fieldSpec(matchColumn),
    }
  } catch (error) {
    if (error instanceof ModelError) throw invalid([{ field, code: 'object_not_readable' }])
    throw error
  }
}

export function cellFormat(options: ImportParseOptions, timeZone: string): CellFormat {
  return { ...options, timeZone }
}

/** Checks a mapping against the resource and builds the plan; field errors otherwise. */
export function buildPlan(
  resource: ResourceModel,
  mapping: ImportMapping,
  options: ImportParseOptions,
  columnCount: number,
  timeZone: string,
): ImportPlan {
  const errors: FieldError[] = []
  if (!importModes(resource).includes(mapping.mode)) {
    throw new AppError('forbidden', { errors: [{ field: 'mode', code: 'not_allowed' }] })
  }
  const catalog = resource.catalog
  const columns: PlannedColumn[] = []
  const targets = new Set<string>()
  mapping.columns.forEach((entry, index) => {
    const field = `mapping.columns.${index}`
    if (entry.source >= columnCount)
      return void errors.push({ field: `${field}.source`, code: 'invalid' })
    const column = resource.columns.find((item) => item.name === entry.target)
    // Excluded columns are unknown, like on the API (E16).
    if (column === undefined)
      return void errors.push({ field: `${field}.target`, code: 'unknown_field' })
    // Auto-increment, generated and lock columns are never written (E8, E22).
    if (!column.insertable) {
      return void errors.push({ field: `${field}.target`, code: 'field_not_writable' })
    }
    if (targets.has(lower(column.name))) {
      return void errors.push({ field: `${field}.target`, code: 'duplicate' })
    }
    targets.add(lower(column.name))
    const entryCatalog = catalog.columns.find((item) => item.name === column.name) as CatalogColumn
    try {
      columns.push({
        source: entry.source,
        column,
        catalog: entryCatalog,
        ...(entry.reference !== undefined && {
          reference: referenceModel(resource, column.name, entry.reference, `${field}.reference`),
        }),
      })
    } catch (error) {
      if (error instanceof AppError && error.errors !== undefined) errors.push(...error.errors)
      else throw error
    }
  })
  // New rows need every required column (§ Pflichtfelder).
  for (const column of catalog.columns) {
    if (required(resource, column) && !targets.has(lower(column.name))) {
      errors.push({
        field: 'mapping.columns',
        code: 'required_column_missing',
        params: { column: column.name },
      })
    }
  }
  let key: string[] | null = null
  if (mapping.mode === 'upsert') {
    const wanted = (mapping.upsertKey ?? []).map(lower)
    key =
      upsertKeys(resource).find(
        (candidate) =>
          candidate.length === wanted.length &&
          candidate.every((name) => wanted.includes(lower(name))),
      ) ?? null
    if (key === null) errors.push({ field: 'mapping.upsertKey', code: 'upsert_key_invalid' })
    else if (!key.every((name) => targets.has(lower(name)))) {
      errors.push({ field: 'mapping.upsertKey', code: 'upsert_key_not_mapped' })
    }
  } else if (mapping.upsertKey !== null) {
    errors.push({ field: 'mapping.upsertKey', code: 'not_allowed' })
  }
  if (errors.length > 0) throw invalid(errors)

  const mapped = (names: readonly string[]) => names.every((name) => targets.has(lower(name)))
  const referenced = new Set(
    columns
      .filter((planned) => planned.reference !== undefined)
      .map((planned) => planned.column.name),
  )
  return {
    table: {
      objectName: resource.object.objectName,
      columns: catalog.columns,
      keyColumn: resource.keyColumn,
      lock: resource.write?.lock ?? { kind: 'values' },
      existing: true,
    },
    mode: mapping.mode,
    key,
    columns,
    format: cellFormat(options, timeZone),
    skipFailed: mapping.skipFailed,
    uniqueKeys: [catalog.primaryKey, ...catalog.uniqueKeys].filter(
      (unique) => unique.length > 0 && mapped(unique),
    ),
    foreignKeys: catalog.foreignKeys
      .filter(
        (foreign) =>
          mapped(foreign.columns) && !foreign.columns.some((name) => referenced.has(name)),
      )
      .map((foreign) => ({
        columns: foreign.columns,
        target: foreign.targetObject,
        targetColumns: foreign.targetColumns,
      })),
    maxErrors: maxStoredErrors,
  }
}
