// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { pageDocument } from '../model/page.ts'
import { querySpec } from '../model/query-spec.ts'
import { paramNamePattern, paramTypes } from '../values/params.ts'
import { pageSlug } from './pages.ts'
import { queryParameter } from './queries.ts'
import { roleInput } from './roles.ts'

/**
 * The configuration file (§24): what managers build, portable between instances.
 * Connections are referred to by name; table access by `tables`, which maps the IDs used in
 * page documents to an object of a connection. Credentials, accounts, role assignments,
 * table access ceilings and API configuration are never part of it.
 */
export const configFormat = 'stashley-config'
export const configFormatVersion = 1

const connectionRef = z.string().min(1).max(120)
const objectName = z.string().min(1).max(64)

export const configFile = z
  .object({
    format: z.literal(configFormat),
    formatVersion: z.literal(configFormatVersion),
    appVersion: z.string().max(100),
    exportedAt: z.iso.datetime(),
    connections: z.array(z.object({ ref: connectionRef }).strict()).max(100),
    tables: z
      .array(z.object({ id: z.uuid(), connectionRef, object: objectName }).strict())
      .max(5000),
    /** In navigation order. */
    roles: z.array(roleInput.extend({ id: z.uuid() }).strict()).max(500),
    variables: z
      .array(
        z
          .object({
            name: z.string().regex(paramNamePattern),
            type: z.enum(paramTypes),
            value: z.union([z.string().max(1000), z.number(), z.boolean()]),
            description: z.string().max(500),
          })
          .strict(),
      )
      .max(500),
    relations: z
      .array(
        z
          .object({
            connectionRef,
            sourceObject: objectName,
            sourceColumn: objectName,
            targetObject: objectName,
            targetColumn: objectName,
            kind: z.enum(['many_to_one', 'one_to_one']),
          })
          .strict(),
      )
      .max(5000),
    displayTemplates: z
      .array(
        z
          .object({ connectionRef, object: objectName, template: z.string().min(1).max(500) })
          .strict(),
      )
      .max(5000),
    queries: z
      .array(
        z
          .object({
            id: z.uuid(),
            connectionRef,
            name: z.string().trim().min(1).max(120),
            description: z.string().max(2000),
            cacheTtlSeconds: z
              .number()
              .int()
              .min(0)
              .max(30 * 86400),
            /** The latest version and every version a published page pins, oldest first. */
            versions: z
              .array(
                z
                  .object({
                    version: z.number().int().positive(),
                    sql: z.string().min(1).max(100_000),
                    builder: z
                      .object({ spec: querySpec, notes: z.array(z.string().max(500)).max(50) })
                      .strict()
                      .nullable(),
                    parameters: z.array(queryParameter).max(50),
                  })
                  .strict(),
              )
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .max(2000),
    /** In navigation order. */
    sections: z
      .array(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120) }).strict())
      .max(500),
    /** In navigation order. */
    pages: z
      .array(
        z
          .object({
            id: z.uuid(),
            sectionId: z.uuid().nullable(),
            slug: pageSlug,
            draft: pageDocument,
            published: pageDocument.nullable(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict()
export type ConfigFile = z.infer<typeof configFile>

export const configImportInput = z
  .object({
    file: z.unknown(),
    /** Connection reference → target connection ID. */
    connections: z.record(connectionRef, z.uuid()),
  })
  .strict()

export const configImportApply = z
  .object({
    file: z.unknown(),
    connections: z.record(connectionRef, z.uuid()),
    /** The fingerprint of the preview the admin saw; the import runs only if it still holds. */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export const configItemKinds = [
  'section',
  'role',
  'variable',
  'relation',
  'display_template',
  'query',
  'page',
] as const
export type ConfigItemKind = (typeof configItemKinds)[number]

export const configConflictCodes = [
  /** A connection reference without a target connection. */
  'connection_unmapped',
  /** The object has no table access on the target connection. */
  'table_access_missing',
  /** A page refers to table access the file does not describe. */
  'table_unknown',
  /** The name or slug belongs to a different item on the target. */
  'name_taken',
  /** The item exists on the target but was deleted there. */
  'archived',
  /** The query exists on the target with another connection. */
  'connection_differs',
  /** A query version with this number has other content on the target. */
  'version_differs',
  /** The SQL of a version does not validate against the target. */
  'query_invalid',
  /** The variable exists with another type. */
  'type_differs',
  /** The page exists with another kind. */
  'kind_differs',
  /** The relation does not fit the target schema. */
  'relation_invalid',
  /** The source column already has a relation to another target. */
  'relation_differs',
  /** The display template does not fit the target. */
  'template_invalid',
  /** A page refers to a section, role or query the file and the target lack. */
  'reference_missing',
] as const
export type ConfigConflictCode = (typeof configConflictCodes)[number]

export interface ConfigImportItem {
  kind: ConfigItemKind
  /** Stable within a file: an ID or a natural key. */
  key: string
  label: string
  status: 'new' | 'changed' | 'unchanged' | 'conflict'
  conflicts: { code: ConfigConflictCode; detail?: string }[]
}

export interface ConfigImportPlan {
  fingerprint: string
  appVersion: string
  exportedAt: string
  connections: { ref: string; connectionId: string | null }[]
  items: ConfigImportItem[]
  counts: Record<ConfigImportItem['status'], number>
}
