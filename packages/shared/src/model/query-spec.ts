// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { paramNamePattern } from '../values/params.ts'

/**
 * A query built with the query builder (§10.3): a base object, joins along known relations,
 * columns with aggregates or time buckets, filters, sort order and a limit. The server
 * compiles it to SQL, which then passes the same validation as handwritten SQL.
 */

const identifier = z.string().min(1).max(64)
/** Source aliases; `base` names the base object. */
export const builderAlias = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/)
const outputName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
const scalar = z.union([z.string().max(1000), z.number(), z.boolean()])

export const builderAggregates = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const
export type BuilderAggregate = (typeof builderAggregates)[number]
export const timeBuckets = ['quarter_hour', 'hour', 'day', 'week', 'month', 'year'] as const
export type TimeBucket = (typeof timeBuckets)[number]
export const builderOperators = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'not_in',
  'like',
  'between',
  'null',
  'not_null',
] as const
export type BuilderOperator = (typeof builderOperators)[number]

export const builderJoin = z
  .object({
    alias: builderAlias,
    /** `base` or the alias of an earlier join. */
    from: builderAlias,
    column: identifier,
    target: identifier,
    targetColumn: identifier,
    kind: z.enum(['inner', 'left']),
  })
  .strict()

export const builderColumn = z
  .object({
    name: outputName,
    source: builderAlias,
    /** Null only for `count`, which then counts rows. */
    column: identifier.nullable(),
    aggregate: z.enum(builderAggregates).optional(),
    bucket: z.enum(timeBuckets).optional(),
  })
  .strict()

export const builderFilter = z
  .object({
    source: builderAlias,
    column: identifier,
    operator: z.enum(builderOperators),
    value: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('constant'),
            value: z.union([scalar, z.array(scalar).max(100)]),
          })
          .strict(),
        z
          .object({ kind: z.literal('parameter'), name: z.string().regex(paramNamePattern) })
          .strict(),
      ])
      .optional(),
  })
  .strict()

export const querySpec = z
  .object({
    schemaVersion: z.literal(1),
    base: identifier,
    joins: z.array(builderJoin).max(10),
    columns: z.array(builderColumn).min(1).max(50),
    filters: z.array(builderFilter).max(30),
    sort: z
      .array(z.object({ column: outputName, direction: z.enum(['asc', 'desc']) }).strict())
      .max(5),
    limit: z.number().int().min(1).max(10_000).nullable(),
  })
  .strict()
export type QuerySpec = z.infer<typeof querySpec>
