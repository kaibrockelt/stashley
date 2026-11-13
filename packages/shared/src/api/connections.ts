// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { ValueKind } from '../values/column-kinds.ts'

export const engines = ['mariadb', 'mysql'] as const
export type Engine = (typeof engines)[number]

export const tlsModes = ['disabled', 'required', 'verify-ca', 'verify-full'] as const
export type TlsMode = (typeof tlsModes)[number]

export const credentialPurposes = ['read', 'write', 'schema'] as const
export type CredentialPurpose = (typeof credentialPurposes)[number]

/** Why a database user could not connect; also used as a field error code. */
export const connectionFailures = [
  'unreachable',
  'timeout',
  'access_denied',
  'unknown_database',
  'tls_failed',
  'host_not_allowed',
  'failed',
] as const
export type ConnectionFailure = (typeof connectionFailures)[number]

const identifier = z.string().trim().min(1).max(64)

/** Omitted password: keep the stored one. */
const credentialInput = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(1000).optional(),
})

export const connectionInput = z.object({
  name: z.string().trim().min(1).max(80),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    // Underscores occur in Docker service and container names.
    .regex(/^[A-Za-z0-9_.:[\]-]+$/),
  port: z.number().int().min(1).max(65535),
  databaseName: identifier,
  tls: z.object({
    mode: z.enum(tlsModes),
    caPem: z.string().trim().max(20_000).nullable(),
    serverName: z.string().trim().max(253).nullable(),
  }),
  timezone: z.string().min(1).max(64),
  queryTimeoutSeconds: z.number().int().min(1).max(300),
  credentials: z.object({
    read: credentialInput,
    write: credentialInput.nullable(),
    schema: credentialInput.nullable(),
  }),
})
export type ConnectionInput = z.infer<typeof connectionInput>

/** The settings that decide which server receives a connection's passwords. */
export interface ConnectionTarget {
  host: string
  port: number
  tls: { mode: TlsMode; caPem: string | null; serverName: string | null }
}

/**
 * Stored passwords are sent only to the server they were saved for: the same host, port and
 * TLS settings. With any other target, a test or save could hand them to a different server,
 * so all passwords must be entered again.
 */
export function sameConnectionTarget(a: ConnectionTarget, b: ConnectionTarget): boolean {
  const text = (value: string | null) => {
    const trimmed = (value ?? '').trim()
    return trimmed === '' ? null : trimmed
  }
  return (
    a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
    a.port === b.port &&
    a.tls.mode === b.tls.mode &&
    text(a.tls.caPem) === text(b.tls.caPem) &&
    text(a.tls.serverName) === text(b.tls.serverName)
  )
}

/** A privilege the user has beyond what its purpose needs, or a grant that cannot be judged. */
export interface GrantWarning {
  code:
    | 'global_privilege'
    | 'other_schema'
    | 'excess_privilege'
    | 'grant_option'
    | 'routine_privilege'
    | 'proxy'
    | 'unparsed'
    | 'inactive_role'
    | 'role_unreadable'
  privilege?: string
  /** `*.*`, `schema.*`, `schema.table`, the raw grant line for `unparsed`, or the role. */
  scope: string
}

export interface ObjectGrant {
  object: string
  privileges: string[]
  /** Column-level privileges, e.g. `{ UPDATE: ['status'] }`. */
  columns?: Record<string, string[]>
}

export interface GrantReport {
  purpose: CredentialPurpose
  required: string[]
  missing: string[]
  warnings: GrantWarning[]
  /** Privileges on the whole target schema. */
  schemaPrivileges: string[]
  /** Table-level privileges in the target schema. */
  objects: ObjectGrant[]
  roles: string[]
  /** Set when the user could not connect. */
  failure?: ConnectionFailure
}

export interface ConnectionCredential {
  purpose: CredentialPurpose
  username: string
  grants: GrantReport | null
  checkedAt: string | null
}

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  databaseName: string
  engine: Engine | null
  serverVersion: string | null
  /** False for server versions without vendor support; they connect but are not tested. */
  versionSupported: boolean | null
  tls: { mode: TlsMode; caPem: string | null; serverName: string | null }
  timezone: string
  queryTimeoutSeconds: number
  credentials: ConnectionCredential[]
  schemaCapturedAt: string | null
  /** The last schema read, and why it failed; the daily check runs unattended. */
  schemaCheck: { checkedAt: string | null; failure: ConnectionFailure | null }
  openDrifts: number
  createdAt: string
  updatedAt: string
}

export interface ConnectionTestResult {
  engine: Engine
  serverVersion: string
  versionSupported: boolean
  grants: GrantReport[]
}

// Catalog

export interface CatalogColumn {
  name: string
  position: number
  dataType: string
  columnType: string
  kind: ValueKind
  nullable: boolean
  defaultValue: string | null
  autoIncrement: boolean
  /** A virtual or stored generated column; expression defaults do not count. */
  generated: boolean
  /** `ON UPDATE` expression, e.g. `CURRENT_TIMESTAMP`; absent in snapshots before it existed. */
  onUpdate?: string | null
  maxLength: number | null
  precision: number | null
  scale: number | null
  enumValues?: string[]
}

export interface CatalogForeignKey {
  name: string
  columns: string[]
  targetObject: string
  targetColumns: string[]
}

export interface CatalogObject {
  name: string
  type: 'table' | 'view'
  rowEstimate: number | null
  columns: CatalogColumn[]
  primaryKey: string[]
  uniqueKeys: string[][]
  foreignKeys: CatalogForeignKey[]
  /** Views: base tables, resolved through nested views. */
  baseTables?: string[]
  /** Views: columns that likely identify a row. */
  keyCandidates?: string[]
  /** Views: false when the read user cannot read the definition (no SHOW VIEW). */
  dependenciesKnown?: boolean
}

export interface CatalogSnapshot {
  connectionId: string
  capturedAt: string
  objects: CatalogObject[]
}

export interface ObjectChange {
  object: string
  typeChanged?: [string, string]
  addedColumns: string[]
  removedColumns: string[]
  changedColumns: { column: string; fields: string[] }[]
  keysChanged: boolean
}

export interface SchemaDiff {
  addedObjects: string[]
  removedObjects: string[]
  changedObjects: ObjectChange[]
}

export interface ImpactItem {
  kind: 'table_access' | 'column_exclusion' | 'display_template' | 'relation'
  id: string
  label: string
  reason: 'object_removed' | 'column_removed' | 'column_changed' | 'key_changed' | 'type_changed'
}

export interface SchemaRefreshResult {
  changed: boolean
  capturedAt: string
  diff: SchemaDiff
  impact: ImpactItem[]
}

export interface SchemaDrift {
  id: string
  detectedAt: string
  diff: SchemaDiff
  impact: ImpactItem[]
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

// Table access

export const tableOps = ['read', 'create', 'update', 'delete'] as const
export type TableOp = (typeof tableOps)[number]

export const exclusionScopes = ['all', 'mcp'] as const
export type ExclusionScope = (typeof exclusionScopes)[number]

const tableAccessFields = {
  ops: z.array(z.enum(tableOps)).min(1).max(4),
  keyColumn: identifier.nullable(),
  displayTemplate: z.string().trim().max(500).nullable(),
  apiResource: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .nullable(),
  mcpEnabled: z.boolean(),
  exclusions: z.array(z.object({ column: identifier, scope: z.enum(exclusionScopes) })).max(500),
}

export const tableAccessCreate = z.object({
  connectionId: z.uuid(),
  objectName: identifier,
  ...tableAccessFields,
})
export const tableAccessUpdate = z.object(tableAccessFields)

export interface AccessWarning {
  code:
    | 'ops_without_grant'
    | 'no_write_user'
    | 'view_without_key'
    | 'not_in_schema'
    /** The stored display template no longer passes; the default template is used. */
    | 'template_invalid'
    /** The table's primary key changed and no longer matches the key column. */
    | 'key_mismatch'
    /** The read user lacks SHOW VIEW, so the view's base tables are unknown. */
    | 'view_dependencies_unknown'
    /** The view's key column can hold NULL. */
    | 'view_key_nullable'
  ops?: TableOp[]
}

export interface TableAccess {
  id: string
  connectionId: string
  objectName: string
  objectType: 'table' | 'view'
  ops: TableOp[]
  keyColumn: string | null
  displayTemplate: string | null
  /** The stored template, or the default: first text column, otherwise the key. */
  effectiveTemplate: string
  apiResource: string
  mcpEnabled: boolean
  exclusions: { column: string; scope: ExclusionScope }[]
  state: 'active' | 'pending_grants'
  /** Operations the database grants allow; the effective right is the smaller set. */
  grantedOps: TableOp[]
  warnings: AccessWarning[]
  updatedAt: string
}

// Relations

export const relationKinds = ['many_to_one', 'one_to_one'] as const
export type RelationKind = (typeof relationKinds)[number]

export const relationInput = z.object({
  connectionId: z.uuid(),
  sourceObject: identifier,
  sourceColumn: identifier,
  targetObject: identifier,
  targetColumn: identifier,
  kind: z.enum(relationKinds),
})

export interface Relation {
  /** Null for relations read from foreign key constraints. */
  id: string | null
  origin: 'constraint' | 'virtual'
  name: string
  sourceObject: string
  sourceColumn: string
  targetObject: string
  targetColumn: string
  kind: RelationKind
}
