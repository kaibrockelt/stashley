// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { cacheTtl } from '../model/page.ts'
import type { ValueKind } from '../values/column-kinds.ts'
import { paramNamePattern, paramTypes, type ParamType } from '../values/params.ts'

/**
 * Why the SQL validation rejected a query (§10.2). Every code names one rule; the web
 * client shows a localized message for it.
 */
export const sqlProblemCodes = [
  // Lexical checks
  'empty',
  'too_long',
  'executable_comment',
  'optimizer_hint',
  'ambiguous_comment',
  'unterminated',
  'positional_placeholder',
  'variable_not_allowed',
  'assignment_not_allowed',
  'invalid_parameter_name',
  'multiple_statements',
  'into_not_allowed',
  'locking_clause',
  'ambiguous_identifier',
  'unexpected_character',
  // Parsing
  'parse_error',
  'not_select',
  // Names and rules
  'system_schema',
  'other_schema',
  'object_not_exposed',
  'object_not_readable',
  'unknown_column',
  'ambiguous_column',
  'excluded_column',
  'star_on_excluded',
  'unknown_alias',
  'function_denied',
  'function_not_allowed',
  'unsupported_syntax',
] as const
export type SqlProblemCode = (typeof sqlProblemCodes)[number]

/** What a validated query references (§10.2); stored with each version. */
export interface QueryAnalysis {
  objects: string[]
  columns: { object: string; column: string }[]
  /** Objects covered by `*` or `t.*`. */
  stars: string[]
  functions: string[]
  /** Named parameters in order of first use. */
  parameters: string[]
  /** Parameters that are instance variables. */
  variables: string[]
  usesUserContext: boolean
  /** Referenced tables plus the base tables of views, followed through nested views. */
  dependencies: string[]
  /** A referenced view's base tables are unknown, so every table counts as a dependency. */
  unknownDependencies: boolean
}

export const queryParameter = z
  .object({
    name: z.string().regex(paramNamePattern),
    type: z.enum(paramTypes),
    list: z.boolean(),
    required: z.boolean(),
    defaultValue: z
      .union([z.string().max(1000), z.number(), z.boolean(), z.array(z.unknown()).max(1000)])
      .nullable(),
    label: z.string().max(200).optional(),
  })
  .strict()
export type QueryParameter = z.infer<typeof queryParameter>

const queryFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  sql: z.string().min(1).max(100_000),
  parameters: z.array(queryParameter).max(50),
  cacheTtlSeconds: cacheTtl,
}

export const queryCreate = z.object({ connectionId: z.uuid(), ...queryFields }).strict()
export const queryUpdate = z.object(queryFields).partial().strict()

/** A test run of unsaved SQL with test values (§ SQL-Editor: first 100 rows). */
export const queryTestRun = z
  .object({
    connectionId: z.uuid(),
    sql: queryFields.sql,
    parameters: queryFields.parameters,
    values: z.record(z.string(), z.unknown()),
  })
  .strict()

export const queryValidate = queryTestRun.omit({ values: true })

export interface ResultColumn {
  name: string
  /** SQL type name as the driver reports it, e.g. `DECIMAL`. */
  type: string
  kind: ValueKind
  nullable: boolean
  role: 'measure' | 'time' | 'category' | 'identifier'
}

export interface QueryVersion {
  version: number
  sql: string
  parameters: QueryParameter[]
  analysis: QueryAnalysis
  resultColumns: ResultColumn[] | null
  createdAt: string
  createdBy: string | null
}

export interface Query {
  id: string
  connectionId: string
  name: string
  description: string
  mode: 'builder' | 'sql'
  cacheTtlSeconds: number
  latestVersion: number
  current: QueryVersion
  /** Pages whose draft or published version use this query. */
  usedBy: { pageId: string; title: string; publishedVersion: number | null }[]
  createdAt: string
  updatedAt: string
}

/** The result of a component or a test run. */
export interface QueryResult {
  columns: ResultColumn[]
  rows: Record<string, unknown>[]
  truncated: boolean
  /** Indexes of rows with invalid legacy dates, returned as null. */
  invalidRows?: number[]
}

export interface ParameterDefinition {
  name: string
  type: ParamType
  list: boolean
  required: boolean
}
