// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { authenticatedPrincipal } from '../access/algebra.ts'
import { tableOps } from '../api/connections.ts'
import { paramNamePattern, paramTypes } from '../values/params.ts'

/**
 * The page document (architecture §13.1), schema version 1. M4 defines what access control
 * and execution need; block display settings (charts, formats) live in `settings` and are
 * specified by the page editor (M5), form fields by M6.
 */

/** Stable IDs of components and filters within a page. */
export const componentId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
const identifier = z.string().min(1).max(64)
const paramName = z.string().regex(paramNamePattern)
const principal = z.union([z.literal(authenticatedPrincipal), z.uuid()])
const op = z.enum(tableOps)
const opList = z.array(op).max(4)
const settings = z.record(z.string(), z.unknown()).optional()

export const cacheTtlPresets = [0, 30, 60, 300, 900, 3600, 21600, 86400] as const
/** 0 is live; any other number of seconds up to 30 days. */
export const cacheTtl = z
  .number()
  .int()
  .min(0)
  .max(30 * 86400)

export const sourceKey = z.string().regex(/^(query|table):[0-9a-f-]{36}$/)

export const pageAccess = z.object({
  view: z.array(principal).max(200),
  grants: z.array(z.object({ principal, source: sourceKey, ops: opList }).strict()).max(2000),
})

export const componentRestriction = z.object({ principal, ops: opList }).strict()

export const queryRef = z
  .object({
    kind: z.literal('query'),
    queryId: z.uuid(),
    /** Pinned when the page is published; drafts use the latest version. */
    version: z.number().int().positive().optional(),
  })
  .strict()

export const tableRef = z
  .object({
    kind: z.literal('table'),
    tableAccessId: z.uuid(),
    cacheTtlSeconds: cacheTtl,
  })
  .strict()

/** One step along a relation: from the current object over `column` into `target`. */
export const relationStep = z.object({ column: identifier, target: identifier }).strict()
const path = z.array(relationStep).max(3)

/** A column of the source object, or of an object reached over up to three relations. */
export const columnRef = z.object({ path, column: identifier }).strict()
export type ColumnRef = z.infer<typeof columnRef>

/** A query parameter set from a page filter or a URL parameter of the page. */
export const parameterBinding = z
  .object({
    parameter: paramName,
    from: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('filter'), filterId: componentId }).strict(),
      z.object({ kind: z.literal('url'), name: paramName }).strict(),
    ]),
  })
  .strict()
export type ParameterBinding = z.infer<typeof parameterBinding>

export const tableColumn = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('column'),
      id: componentId,
      column: columnRef,
      label: z.string().max(200).optional(),
    })
    .strict(),
  /** The display value of the record at the end of `path`, e.g. the person of a registration. */
  z
    .object({
      kind: z.literal('display'),
      id: componentId,
      path: z.array(relationStep).min(1).max(3),
      /** Overrides the target's display template. */
      template: z.string().min(1).max(500).optional(),
      label: z.string().max(200).optional(),
    })
    .strict(),
])
export type TableColumn = z.infer<typeof tableColumn>

export const baseFilterOperators = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'null',
  'not_null',
] as const
export type BaseFilterOperator = (typeof baseFilterOperators)[number]

const scalar = z.union([z.string().max(1000), z.number(), z.boolean()])

/**
 * A fixed filter users cannot remove (§ Basisfilter). It takes only constants, instance
 * variables and the user context, never page filters or URL parameters.
 */
export const baseFilterCondition = z
  .object({
    column: columnRef,
    operator: z.enum(baseFilterOperators),
    value: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('constant'),
            value: z.union([scalar, z.array(scalar).max(100)]),
          })
          .strict(),
        z.object({ kind: z.literal('variable'), name: paramName }).strict(),
        z.object({ kind: z.literal('user'), field: z.enum(['id', 'email']) }).strict(),
      ])
      .optional(),
  })
  .strict()
export type BaseFilterCondition = z.infer<typeof baseFilterCondition>

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
  })
  .strict()
export type TableConfig = z.infer<typeof tableConfig>

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

/** A table shows a stored query, or a table or view with its own configuration. */
export const tableComponent = z
  .object({
    ...blockBase,
    type: z.literal('table'),
    source: z.discriminatedUnion('kind', [queryRef, tableRef]),
    bindings: z.array(parameterBinding).max(50),
    table: tableConfig.nullable(),
    settings,
  })
  .strict()
  .refine((block) => (block.source.kind === 'table') === (block.table !== null), {
    message: 'table sources need a table configuration, queries none',
    path: ['table'],
  })

export const formModes = ['create', 'edit', 'upsert'] as const

export const block = z.union([
  queryBlock('metric'),
  queryBlock('chart'),
  queryBlock('record'),
  tableComponent,
  z
    .object({
      ...blockBase,
      type: z.literal('form'),
      source: tableRef,
      mode: z.enum(formModes),
      settings,
    })
    .strict(),
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
    access: pageAccess,
    mcp: z.object({ available: z.boolean() }).strict(),
  })
  .strict()
  .refine((page) => (page.kind === 'table' ? page.rows.length === 0 : page.table === null), {
    message: 'dashboards have rows, table pages one table',
    path: ['kind'],
  })
export type PageDocument = z.infer<typeof pageDocument>

/** Every component of a page with its position, in document order. */
export function componentsOf(page: PageDocument): { component: Block; path: string }[] {
  if (page.table !== null) return [{ component: page.table, path: 'table' }]
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
    access: { view: [], grants: [] },
    mcp: { available: false },
  }
}
