// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { TableOp } from './connections.ts'

/**
 * The public REST API (§16): admins enable single operations per table access, and tokens
 * get grants per table and operation, only within the enabled endpoints.
 */

export const apiOperations = [
  'list',
  'get',
  'count',
  'schema',
  'create',
  'update',
  'replace',
  'upsert',
  'delete',
] as const
export type ApiOperation = (typeof apiOperations)[number]

/** The ceiling operations an API operation needs (E15); upsert needs both create and update. */
export const apiOperationNeeds: Readonly<Record<ApiOperation, readonly TableOp[]>> = {
  list: ['read'],
  get: ['read'],
  count: ['read'],
  schema: ['read'],
  create: ['create'],
  update: ['update'],
  replace: ['update'],
  upsert: ['create', 'update'],
  delete: ['delete'],
}

export const apiWriteOperations: readonly ApiOperation[] = [
  'create',
  'update',
  'replace',
  'upsert',
  'delete',
]

/** The URL name of a resource (E14). */
export const apiResourcePattern = /^[a-z][a-z0-9_-]{0,62}$/

/**
 * Endpoints are enabled only once the alias differs from the object name, so the real table
 * name is never part of the public contract (E14).
 */
export function aliasExposesName(alias: string, objectName: string): boolean {
  return alias.toLowerCase() === objectName.toLowerCase()
}

export interface ApiObjectFacts {
  objectType: 'table' | 'view'
  /** The primary key of a table, the chosen unique column of a view, or null. */
  keyColumn: string | null
  ceiling: readonly TableOp[]
}

/**
 * Operations a table access can offer at all: tables need a single-column primary key
 * (the key column), views offer `get` only with a key column and never write (§16).
 */
export function apiOperationsFor(object: ApiObjectFacts): ApiOperation[] {
  if (object.objectType === 'table' && object.keyColumn === null) return []
  return apiOperations.filter((operation) => {
    if (object.objectType === 'view') {
      if (apiWriteOperations.includes(operation)) return false
      if (operation === 'get' && object.keyColumn === null) return false
    }
    return apiOperationNeeds[operation].every((op) => object.ceiling.includes(op))
  })
}

// Internal admin API

/** Why an endpoint of a table access cannot be enabled. */
export type ApiEndpointBlocker =
  /** The alias equals the object name (E14). */
  | 'alias_is_object_name'
  /** A table without a single-column primary key. */
  | 'no_single_key'
  /** The table access waits for grants or the object is gone from the catalog. */
  | 'not_active'

export interface ApiEndpointState {
  tableAccessId: string
  connectionId: string
  connectionName: string
  objectName: string
  objectType: 'table' | 'view'
  apiResource: string
  ceiling: TableOp[]
  /** Operations the ceiling and the object allow. */
  available: ApiOperation[]
  enabled: ApiOperation[]
  /**
   * Enabled operations the database grants or column grants currently rule out; requests
   * answer 403 until the grants are back.
   */
  withheld: ApiOperation[]
  blockers: ApiEndpointBlocker[]
}

export const apiEndpointsUpdate = z.object({
  operations: z.array(z.enum(apiOperations)).max(apiOperations.length),
  /**
   * The `confirmation` of a previous `confirmation_required` answer: the change runs only
   * while it takes away exactly what that answer listed (E15).
   */
  confirm: z.string().max(64).optional(),
})

/** What a change of a table access or its endpoints takes away (E15). */
export type ChangeConsequence =
  | { kind: 'api_endpoint_removed'; operation: ApiOperation }
  | { kind: 'api_grant_removed'; tokenId: string; tokenName: string; operation: ApiOperation }
  | { kind: 'api_alias_changed'; from: string; to: string }

export const apiTokenGrant = z.object({
  tableAccessId: z.uuid(),
  operation: z.enum(apiOperations),
})
export type ApiTokenGrant = z.infer<typeof apiTokenGrant>

const tokenFields = {
  name: z.string().trim().min(1).max(100),
  /** Milliseconds since the epoch, or null for no expiry (E20). */
  expiresAt: z.number().int().positive().nullable(),
  /** Addresses or CIDR ranges; empty means any address. */
  ipAllowlist: z.array(z.string().trim().min(1).max(50)).max(50),
  rateLimitPerMinute: z.number().int().min(1).max(10_000),
  grants: z.array(apiTokenGrant).max(5000),
}

export const apiTokenCreate = z.object(tokenFields)
export const apiTokenUpdate = z.object(tokenFields)

export const defaultApiRateLimit = 60

export interface ApiToken {
  id: string
  name: string
  /** The last characters of the token, to recognize it. */
  hint: string
  expiresAt: number | null
  ipAllowlist: string[]
  rateLimitPerMinute: number
  createdBy: string | null
  createdAt: number
  updatedAt: number
  revokedAt: number | null
  lastUsedAt: number | null
  requestCount: number
  grants: ApiTokenGrant[]
}

export interface ApiTokenCreated {
  token: ApiToken
  /** Shown once; only its hash is stored. */
  secret: string
}
