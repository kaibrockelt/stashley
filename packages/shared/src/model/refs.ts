// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { authenticatedPrincipal, type SourceKey } from '../access/algebra.ts'
import { tableOps } from '../api/connections.ts'
import { paramNamePattern } from '../values/params.ts'

/**
 * Building blocks of the page document (§13.1) shared by pages, table sources and forms.
 * `page.ts` re-exports the public ones; the package index does not export this file.
 */

/** Stable IDs of components and filters within a page. */
export const componentId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
export const identifier = z.string().min(1).max(64)
export const paramName = z.string().regex(paramNamePattern)
export const principal = z.union([z.literal(authenticatedPrincipal), z.uuid()])
export const op = z.enum(tableOps)
export const opList = z.array(op).max(4)
export const settings = z.record(z.string(), z.unknown()).optional()

export const cacheTtlPresets = [0, 30, 60, 300, 900, 3600, 21600, 86400] as const
/** 0 is live; any other number of seconds up to 30 days. */
export const cacheTtl = z
  .number()
  .int()
  .min(0)
  .max(30 * 86400)

export const sourceKey = z
  .string()
  .regex(/^(query|table):[0-9a-f-]{36}$/)
  .transform((value) => value as SourceKey)

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
export const path = z.array(relationStep).max(3)

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

export const scalar = z.union([z.string().max(1000), z.number(), z.boolean()])

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
