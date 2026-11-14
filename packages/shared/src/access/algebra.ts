// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { TableOp } from '../api/connections.ts'

/**
 * The access algebra (architecture §8). Pure functions over bitmasks; the server's `access`
 * module wraps them and is the only place that grants access to data.
 *
 * effective(u, k) = ( ⋃ over r ∈ principals(u) of pageOps(r, page(k), source(k)) ∩ restriction(k, r) )
 *                   ∩ capability(k) ∩ ceiling(source(k)) ∩ dbGrants(source(k))
 */

/** Operations as a bitmask: read 1, create 2, update 4, delete 8. */
export type OpMask = number

export const opBits: Readonly<Record<TableOp, OpMask>> = {
  read: 1,
  create: 2,
  update: 4,
  delete: 8,
}
export const noOps: OpMask = 0
export const allOps: OpMask = 15
const orderedOps: readonly TableOp[] = ['read', 'create', 'update', 'delete']

export function toMask(ops: readonly TableOp[]): OpMask {
  let mask = noOps
  for (const op of ops) mask |= opBits[op]
  return mask
}

export function toOps(mask: OpMask): TableOp[] {
  return orderedOps.filter((op) => (mask & opBits[op]) !== 0)
}

export function hasOp(mask: OpMask, op: TableOp): boolean {
  return (mask & opBits[op]) !== 0
}

/** Every signed-in user is this principal, in addition to their roles. */
export const authenticatedPrincipal = 'authenticated'
/** A role ID, or every signed-in user. */
export type Principal = string

/** A data source of a page: a stored query or exposed table access. */
export type SourceKey = `query:${string}` | `table:${string}`

export function querySource(queryId: string): SourceKey {
  return `query:${queryId}`
}

export function tableSource(tableAccessId: string): SourceKey {
  return `table:${tableAccessId}`
}

export interface PageGrant {
  principal: Principal
  source: SourceKey
  ops: TableOp[]
}

/** Rights of a page (manager): who sees it, and per data source what each principal may do. */
export interface PageAccess {
  view: Principal[]
  grants: PageGrant[]
}

/** Narrows the page rights for one principal on one component; it can never widen them. */
export interface ComponentRestriction {
  principal: Principal
  ops: TableOp[]
}

/** The principals of a user: their roles plus `authenticated` (§8.3). */
export function principalsOf(roleIds: readonly string[]): Principal[] {
  return [...new Set([...roleIds, authenticatedPrincipal])]
}

export function canView(access: PageAccess, principals: readonly Principal[]): boolean {
  return access.view.some((principal) => principals.includes(principal))
}

/** pageOps(r, p, s): the grant, if the principal may see the page at all. */
export function pageOps(access: PageAccess, principal: Principal, source: SourceKey): OpMask {
  if (!access.view.includes(principal)) return noOps
  let mask = noOps
  for (const grant of access.grants) {
    if (grant.principal === principal && grant.source === source) mask |= toMask(grant.ops)
  }
  return mask
}

/** restriction(k, r): all operations unless the component restricts this principal. */
export function restrictionOf(
  restrictions: readonly ComponentRestriction[],
  principal: Principal,
): OpMask {
  const own = restrictions.filter((restriction) => restriction.principal === principal)
  if (own.length === 0) return allOps
  let mask = allOps
  for (const restriction of own) mask &= toMask(restriction.ops)
  return mask
}

/** compOps(r, k) = pageOps ∩ restriction. */
export function componentOps(
  access: PageAccess,
  restrictions: readonly ComponentRestriction[],
  principal: Principal,
  source: SourceKey,
): OpMask {
  return pageOps(access, principal, source) & restrictionOf(restrictions, principal)
}

/** The union over the principals; it is the only part that depends on the user. */
export function principalOps(
  access: PageAccess,
  restrictions: readonly ComponentRestriction[],
  principals: readonly Principal[],
  source: SourceKey,
): OpMask {
  let mask = noOps
  for (const principal of new Set(principals)) {
    mask |= componentOps(access, restrictions, principal, source)
  }
  return mask
}

/**
 * What limits a component regardless of who asks: what it can do at all, the ceiling of its
 * source and the database grants. Computed once per compiled page.
 */
export interface StaticLimits {
  capability: OpMask
  ceiling: OpMask
  dbGrants: OpMask
}

export function staticMask(limits: StaticLimits): OpMask {
  return limits.capability & limits.ceiling & limits.dbGrants
}

export interface ComponentAccess {
  access: PageAccess
  restrictions: readonly ComponentRestriction[]
  source: SourceKey
  limits: StaticLimits
}

/**
 * effective(u, k). The union across principals comes first; ceiling and grants do not
 * depend on the principal, so intersecting afterwards equals intersecting per principal.
 */
export function effectiveOps(component: ComponentAccess, principals: readonly Principal[]): OpMask {
  return (
    principalOps(component.access, component.restrictions, principals, component.source) &
    staticMask(component.limits)
  )
}

/** Component types as access control sees them. */
export type ComponentKind =
  | { type: 'metric' | 'chart' | 'record' }
  | { type: 'table'; editing?: OpMask }
  | { type: 'form'; mode: 'create' | 'edit' | 'upsert' }
  | { type: 'text' }

/** capability(k): what a component can do at all (§8.2). */
export function capabilityOf(kind: ComponentKind): OpMask {
  switch (kind.type) {
    case 'metric':
    case 'chart':
    case 'record':
      return opBits.read
    case 'table':
      return opBits.read | ((kind.editing ?? noOps) & ~opBits.read)
    case 'form':
      return kind.mode === 'create'
        ? opBits.create
        : kind.mode === 'edit'
          ? opBits.read | opBits.update
          : opBits.create | opBits.update
    case 'text':
      return noOps
  }
}

/**
 * Delivery rule (§8.3): a component is delivered when it may read, or when it is a form
 * whose effective rights contain its write operation; a form in edit mode needs both read
 * and update. Text blocks have no source and are shown whenever the page is visible.
 */
export function isDelivered(kind: ComponentKind, effective: OpMask): boolean {
  switch (kind.type) {
    case 'text':
      return true
    case 'form': {
      const needed = capabilityOf(kind)
      if (kind.mode === 'edit') return (effective & needed) === needed
      return (effective & needed) !== noOps
    }
    default:
      return hasOp(effective, 'read')
  }
}

/** What a stored query references, as far as access control needs it (§10.2). */
export interface QueryReferences {
  objects: readonly string[]
  columns: readonly { object: string; column: string }[]
  /** Objects covered by `*` or `t.*`. */
  stars: readonly string[]
}

/** The table access of one object as access control sees it. */
export interface ObjectAccess {
  ceiling: OpMask
  /** Columns excluded for everyone. */
  excluded: ReadonlySet<string>
  active: boolean
}

/**
 * Ceiling of a query source (§8.2): `read` if every referenced object is exposed and active
 * with `read` in its ceiling, no referenced column is excluded, and no `*` covers an object
 * with exclusions. Otherwise empty. Column names compare case-insensitively, like MySQL.
 */
export function queryCeiling(
  references: QueryReferences,
  accessOf: (object: string) => ObjectAccess | undefined,
): OpMask {
  const lowered = new Map<string, Set<string>>()
  const excludedOf = (object: string, access: ObjectAccess) => {
    let set = lowered.get(object)
    if (set === undefined) {
      set = new Set([...access.excluded].map((column) => column.toLowerCase()))
      lowered.set(object, set)
    }
    return set
  }
  for (const object of references.objects) {
    const access = accessOf(object)
    if (access === undefined || !access.active || !hasOp(access.ceiling, 'read')) return noOps
  }
  for (const { object, column } of references.columns) {
    const access = accessOf(object)
    if (access === undefined || excludedOf(object, access).has(column.toLowerCase())) return noOps
  }
  for (const object of references.stars) {
    const access = accessOf(object)
    if (access === undefined || access.excluded.size > 0) return noOps
  }
  return opBits.read
}

/** Grants that exceed the ceiling of their source; the manager cannot save them (§8.6). */
export function grantsAboveCeiling(
  access: PageAccess,
  ceilingOf: (source: SourceKey) => OpMask,
): { index: number; ops: TableOp[] }[] {
  const problems: { index: number; ops: TableOp[] }[] = []
  access.grants.forEach((grant, index) => {
    const excess = toMask(grant.ops) & ~ceilingOf(grant.source)
    if (excess !== noOps) problems.push({ index, ops: toOps(excess) })
  })
  return problems
}

/** Restrictions that are not subsets of the page rights of their principal (§8.6). */
export function restrictionsAbovePage(
  access: PageAccess,
  restrictions: readonly ComponentRestriction[],
  source: SourceKey | undefined,
): { index: number; ops: TableOp[] }[] {
  const problems: { index: number; ops: TableOp[] }[] = []
  restrictions.forEach((restriction, index) => {
    const page = source === undefined ? noOps : pageOps(access, restriction.principal, source)
    const excess = toMask(restriction.ops) & ~page
    if (excess !== noOps) problems.push({ index, ops: toOps(excess) })
  })
  return problems
}
