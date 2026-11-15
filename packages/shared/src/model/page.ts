// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { paramTypes } from '../values/params.ts'
import { afterSave, fieldList, tableEditing } from './form.ts'
import {
  baseFilterCondition,
  columnRef,
  componentId,
  componentRestriction,
  identifier,
  pageAccess,
  parameterBinding,
  paramName,
  queryRef,
  settings,
  tableColumn,
  tableRef,
} from './refs.ts'

export {
  baseFilterCondition,
  baseFilterOperators,
  cacheTtl,
  cacheTtlPresets,
  columnRef,
  componentId,
  componentRestriction,
  pageAccess,
  parameterBinding,
  queryRef,
  relationStep,
  sourceKey,
  tableColumn,
  tableRef,
  type BaseFilterCondition,
  type BaseFilterOperator,
  type ColumnRef,
  type ParameterBinding,
  type TableColumn,
} from './refs.ts'

/**
 * The page document (architecture §13.1), schema version 1. M4 defines what access control
 * and execution need; block display settings (charts, formats) live in `settings` and are
 * specified by the page editor (M5), form fields and table editing by M6.
 */

export const filterBindingOperators = ['eq', 'in', 'contains', 'range'] as const

/** A page filter or URL parameter applied to a column of a table source. */
export const columnBinding = z
  .object({
    from: parameterBinding.shape.from,
    column: columnRef,
    operator: z.enum(filterBindingOperators),
  })
  .strict()

export const tableConfig = z
  .object({
    columns: z.array(tableColumn).min(1).max(100),
    sort: z
      .object({ columnId: componentId, direction: z.enum(['asc', 'desc']) })
      .strict()
      .nullable(),
    searchColumns: z.array(componentId).max(20),
    baseFilter: z.array(baseFilterCondition).max(20),
    bindings: z.array(columnBinding).max(20),
    pageSize: z.number().int().min(1).max(500),
    /** Editing of table sources (M6); null: read-only. */
    editing: tableEditing.nullable().default(null),
    /** CSV export, while the user may read (§ Tabellenseiten); can be turned off. */
    csvExport: z.boolean().default(true),
  })
  .strict()
export type TableConfig = z.infer<typeof tableConfig>

/** The settings M6 added to table configurations, as a new one starts. */
export const tableConfigDefaults = {
  editing: null,
  csvExport: true,
} as const satisfies Partial<TableConfig>

const blockBase = {
  id: componentId,
  title: z.string().max(200),
  description: z.string().max(2000).optional(),
  restrictions: z.array(componentRestriction).max(200),
}

const queryBlock = (type: 'metric' | 'chart' | 'record') =>
  z
    .object({
      ...blockBase,
      type: z.literal(type),
      source: queryRef,
      bindings: z.array(parameterBinding).max(50),
      settings,
    })
    .strict()

const tableShape = {
  ...blockBase,
  type: z.literal('table'),
  source: z.discriminatedUnion('kind', [queryRef, tableRef]),
  bindings: z.array(parameterBinding).max(50),
  table: tableConfig.nullable(),
  settings,
}

const tableSourceCheck = (block: { source: { kind: string }; table: unknown }) =>
  (block.source.kind === 'table') === (block.table !== null)
const tableSourceMessage = () => ({
  message: 'table sources need a table configuration, queries none',
  path: ['table'],
})

/** A table shows a stored query, or a table or view with its own configuration. */
export const tableComponent = z
  .object(tableShape)
  .strict()
  .refine(tableSourceCheck, tableSourceMessage())

/**
 * A related table in the detail view of a table page: the records of another object that
 * refer to the shown record through `column`. It is a component with its own rights.
 */
export const detailTable = z
  .object({
    ...tableShape,
    source: tableRef,
    link: z.object({ column: z.string().min(1).max(64) }).strict(),
  })
  .strict()
  .refine(tableSourceCheck, tableSourceMessage())
export type DetailTable = z.infer<typeof detailTable>

export const formModes = ['create', 'edit', 'upsert'] as const
export type FormMode = (typeof formModes)[number]

/**
 * A form writes one exposed table (§ Formulare). In edit mode a page filter or URL parameter
 * names the record; upserts find it by `upsertKey` (E8). The base filter applies in every
 * mode (E9): rows outside it are never changed, new rows must meet it.
 */
export const formComponent = z
  .object({
    ...blockBase,
    type: z.literal('form'),
    source: tableRef,
    mode: z.enum(formModes),
    fields: fieldList.default([]),
    record: z.object({ from: parameterBinding.shape.from }).strict().nullable().default(null),
    upsertKey: z.array(z.string().min(1).max(64)).min(1).max(16).nullable().default(null),
    baseFilter: z.array(baseFilterCondition).max(20).default([]),
    afterSave: afterSave.default({ action: 'clear' }),
    submitLabel: z.string().max(80).optional(),
    settings,
  })
  .strict()
export type FormComponent = z.infer<typeof formComponent>

/** The settings of a new form besides its table and mode. */
export function formDefaults(): Pick<
  FormComponent,
  'fields' | 'record' | 'upsertKey' | 'baseFilter' | 'afterSave'
> {
  return {
    fields: [],
    record: null,
    upsertKey: null,
    baseFilter: [],
    afterSave: { action: 'clear' },
  }
}

export const block = z.union([
  queryBlock('metric'),
  queryBlock('chart'),
  queryBlock('record'),
  tableComponent,
  formComponent,
  z
    .object({
      ...blockBase,
      type: z.literal('text'),
      markdown: z.string().max(10_000),
    })
    .strict(),
])
export type Block = z.infer<typeof block>
export type TableComponent = z.infer<typeof tableComponent>

export const rowLayouts = ['12', '6-6', '8-4', '4-8', '4-4-4', '6-3-3', '3-3-3-3'] as const
export type RowLayout = (typeof rowLayouts)[number]

export const dashboardRow = z
  .object({
    id: componentId,
    layout: z.enum(rowLayouts),
    blocks: z.array(block).min(1).max(4),
  })
  .strict()
  .refine((row) => row.blocks.length === row.layout.split('-').length, {
    message: 'the layout decides the number of blocks',
    path: ['blocks'],
  })

export const pageFilter = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('date'),
      id: componentId,
      label: z.string().max(200),
      range: z.boolean(),
      required: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('select'),
      id: componentId,
      label: z.string().max(200),
      source: queryRef,
      valueColumn: identifier,
      labelColumn: identifier,
      multiple: z.boolean(),
      required: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      id: componentId,
      label: z.string().max(200),
      required: z.boolean(),
    })
    .strict(),
])
export type PageFilter = z.infer<typeof pageFilter>

/** A value the page takes from its URL, e.g. the record of a row link. */
export const urlParameter = z
  .object({ name: paramName, type: z.enum(paramTypes), list: z.boolean() })
  .strict()

export const pageKinds = ['dashboard', 'table'] as const

export const pageDocument = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(pageKinds),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    filters: z.array(pageFilter).max(20),
    parameters: z.array(urlParameter).max(20),
    rows: z.array(dashboardRow).max(100),
    table: tableComponent.nullable(),
    /** Table pages: the detail view of a record with the tables that refer to it (M6). */
    detail: z
      .object({ tables: z.array(detailTable).max(10) })
      .strict()
      .nullable()
      .default(null),
    access: pageAccess,
    mcp: z.object({ available: z.boolean() }).strict(),
  })
  .strict()
  .refine((page) => (page.kind === 'table' ? page.rows.length === 0 : page.table === null), {
    message: 'dashboards have rows, table pages one table',
    path: ['kind'],
  })
  .refine((page) => page.kind === 'table' || page.detail === null, {
    message: 'only table pages have a detail view',
    path: ['detail'],
  })
export type PageDocument = z.infer<typeof pageDocument>
/** A document as written, before defaults fill the fields M6 added. */
export type PageDocumentInput = z.input<typeof pageDocument>

/** Every component of a page with its position, in document order. */
export function componentsOf(page: PageDocument): { component: Block; path: string }[] {
  if (page.table !== null) {
    return [
      { component: page.table, path: 'table' },
      ...(page.detail?.tables ?? []).map((component, index) => ({
        component,
        path: `detail.tables.${index}`,
      })),
    ]
  }
  return page.rows.flatMap((row, rowIndex) =>
    row.blocks.map((component, blockIndex) => ({
      component,
      path: `rows.${rowIndex}.blocks.${blockIndex}`,
    })),
  )
}

export function emptyPage(kind: (typeof pageKinds)[number], title: string): PageDocument {
  return {
    schemaVersion: 1,
    kind,
    title,
    filters: [],
    parameters: [],
    rows: [],
    table: null,
    detail: null,
    access: { view: [], grants: [] },
    mcp: { available: false },
  }
}
