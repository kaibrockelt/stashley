// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import {
  decimalSeparators,
  isDateFormat,
  isDateTimeFormat,
  thousandsSeparators,
} from '../values/csv-values.ts'
import { newColumnTypes } from '../values/type-inference.ts'
import type { FieldError } from './errors.ts'

/**
 * CSV import (§17): a file is uploaded, read with detected and adjustable options, mapped
 * to the columns of an exposed table, checked by a dry run over every row and imported in
 * one transaction.
 */

export const importEncodings = ['utf-8', 'windows-1252'] as const
export const importDelimiters = [',', ';', '\t'] as const

const word = z.string().max(40)

export const importParseOptions = z.object({
  encoding: z.enum(importEncodings),
  delimiter: z.enum(importDelimiters),
  /** The first row names the columns. */
  header: z.boolean(),
  decimalSeparator: z.enum(decimalSeparators),
  thousandsSeparator: z.enum(thousandsSeparators),
  dateFormat: z.string().max(40).refine(isDateFormat, 'invalid'),
  dateTimeFormat: z.string().max(60).refine(isDateTimeFormat, 'invalid'),
  trueValues: z.array(word).max(20),
  falseValues: z.array(word).max(20),
  emptyValues: z.array(word).min(1).max(20),
})
export type ImportParseOptions = z.infer<typeof importParseOptions>

export const importModes = ['insert', 'upsert'] as const
export type ImportMode = (typeof importModes)[number]

/** How a CSV column fills a foreign key (E26): a unique column of the target or its display value. */
export const importReference = z.discriminatedUnion('via', [
  z.object({ via: z.literal('unique'), column: z.string().min(1).max(64) }).strict(),
  z.object({ via: z.literal('display') }).strict(),
])
export type ImportReference = z.infer<typeof importReference>

export const importColumnMapping = z
  .object({
    /** Position of the CSV column, from 0. */
    source: z.number().int().min(0).max(999),
    /** Column of the target table. */
    target: z.string().min(1).max(64),
    reference: importReference.optional(),
  })
  .strict()
export type ImportColumnMapping = z.infer<typeof importColumnMapping>

export const importMapping = z
  .object({
    tableAccessId: z.uuid(),
    mode: z.enum(importModes),
    /** Upsert: the primary key or a unique key without nullable columns (E22). */
    upsertKey: z.array(z.string().min(1).max(64)).min(1).max(16).nullable(),
    columns: z.array(importColumnMapping).max(1000),
    /** Skip failed rows instead of importing nothing (§17 step 6). */
    skipFailed: z.boolean(),
  })
  .strict()
export type ImportMapping = z.infer<typeof importMapping>

export const importSettings = z
  .object({
    options: importParseOptions,
    mapping: importMapping.nullable(),
    /** Instead of a mapping: a table to create from the file (admins). */
    newTable: z
      .lazy(() => newTableImport)
      .nullable()
      .default(null),
  })
  .strict()

export const importStatuses = [
  'uploaded',
  'checking',
  'checked',
  'importing',
  'completed',
  'failed',
  'cancelled',
] as const
export type ImportStatus = (typeof importStatuses)[number]

/** One cell problem of the preview or the dry run. */
export interface ImportCellError {
  /** Row number in the file, from 1 (the header row counts). */
  line: number
  /** Target column, or `_` for the whole row. */
  column: string
  code: string
  params?: Record<string, string | number>
}

export interface ImportCounts {
  rows: number
  created: number
  updated: number
  unchanged: number
  failed: number
  skipped: number
}

export interface ImportDryRun {
  fingerprint: string
  counts: ImportCounts
  /** The first problems; the full list downloads as CSV. */
  errors: ImportCellError[]
  checkedAt: number
}

export interface ImportProgress {
  phase: 'checking' | 'importing'
  rows: number
}

export interface ImportPreview {
  /** CSV header names, or `Column 1`, … without a header row. */
  columns: string[]
  /** The first 100 data rows as text. */
  rows: string[][]
  /** Per preview row and mapped target column, the problems found. */
  errors: ImportCellError[]
}

export interface ImportTarget {
  tableAccessId: string
  connectionId: string
  objectName: string
  /** Columns a mapping may fill, with what they need. */
  columns: {
    name: string
    kind: string
    required: boolean
    insertable: boolean
    updatable: boolean
    /** A foreign key: the target object and its unique columns for resolving values. */
    reference?: { object: string; uniqueColumns: string[] }
  }[]
  modes: ImportMode[]
  /** Keys an upsert can use. */
  upsertKeys: string[][]
}

export interface ImportJob {
  id: string
  fileName: string
  fileSize: number
  sha256: string
  status: ImportStatus
  options: ImportParseOptions
  mapping: ImportMapping | null
  /** A table to create, with how far its creation got. */
  newTable:
    | (NewTableImport & {
        createdAt: number | null
        dataDoneAt: number | null
        outcome: NewTableOutcome | null
      })
    | null
  /** Suggested by name (§17 step 3) once a table is chosen. */
  suggestedMapping: ImportColumnMapping[] | null
  dryRun: ImportDryRun | null
  result: (ImportCounts & { finishedAt: number }) | null
  progress: ImportProgress | null
  /** Why the job failed, as an error code with field errors. */
  /** Why the last dry run (`phase: dry_run`) or import stopped. */
  failure: { code: string; errors?: FieldError[]; phase?: 'dry_run' | 'import' } | null
  createdBy: string
  createdAt: number
  expiresAt: number
}

// New tables (§17 step 7, E28): admins only, through the schema user.

export const newColumnDefault = z.discriminatedUnion('kind', [
  /** A literal in the JSON-free text form of the type, e.g. `0`, `12.50`, `2026-05-09`. */
  z.object({ kind: z.literal('value'), value: z.string().max(255) }).strict(),
  /** `CURRENT_TIMESTAMP`, for date-times only. */
  z.object({ kind: z.literal('now') }).strict(),
])
export type NewColumnDefault = z.infer<typeof newColumnDefault>

export const newTableColumn = z
  .object({
    name: z.string().min(1).max(64),
    /** The CSV column it is filled from; null in the table designer. */
    source: z.number().int().min(0).max(999).nullable(),
    type: z.enum(newColumnTypes),
    length: z.number().int().min(1).max(16383).optional(),
    precision: z.number().int().min(1).max(65).optional(),
    scale: z.number().int().min(0).max(30).optional(),
    /** NOT NULL. */
    required: z.boolean(),
    unique: z.boolean(),
    default: newColumnDefault.nullable(),
    /**
     * Text columns only: compare case and accents (`COLLATE utf8mb4_bin`) instead of the
     * schema's collation, in unique keys, sorting and search alike.
     */
    caseSensitive: z.boolean().optional(),
  })
  .strict()
export type NewTableColumn = z.infer<typeof newTableColumn>

export const newTablePrimaryKey = z.discriminatedUnion('kind', [
  /** An added `BIGINT AUTO_INCREMENT` column, first in the table. */
  z.object({ kind: z.literal('added'), name: z.string().min(1).max(64) }).strict(),
  /** One of the columns; it must be unique and never empty. */
  z.object({ kind: z.literal('column'), column: z.string().min(1).max(64) }).strict(),
])
export type NewTablePrimaryKey = z.infer<typeof newTablePrimaryKey>

export const newTableDefinition = z
  .object({
    connectionId: z.uuid(),
    name: z.string().min(1).max(64),
    columns: z.array(newTableColumn).min(1).max(200),
    primaryKey: newTablePrimaryKey,
  })
  .strict()
export type NewTableDefinition = z.infer<typeof newTableDefinition>

export const newTableImport = z
  .object({ definition: newTableDefinition, skipFailed: z.boolean() })
  .strict()
export type NewTableImport = z.infer<typeof newTableImport>

/** What creating a table left to do: the grants Stashley's users still need. */
export interface NewTableOutcome {
  tableAccessId: string | null
  /** The `CREATE TABLE` statement as it ran. */
  ddl: string
  /** The read user can see the table; until then its table access waits for grants. */
  readable: boolean
  /** `GRANT` statements for the database administrator; empty when nothing is missing. */
  statements: { purpose: 'read' | 'write'; statement: string }[]
}
