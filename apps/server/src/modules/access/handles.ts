// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiOperation, OpMask, PageMode } from '@stashley/shared'
import type { CompiledComponent, CompiledFilter, CompiledPage } from './compile.ts'
import type { ResourceModel } from './resource.ts'

/**
 * Authorized handles (§8.4). Execution takes one as its first argument, and only this
 * module can create them: the factories are not exported from `access/service.ts`, and a
 * lint rule keeps every other module from importing this file.
 */
declare const authorized: unique symbol

export interface RequestUser {
  id: string
  email: string
}

export interface AuthorizedComponent {
  readonly [authorized]: 'component'
  readonly page: CompiledPage
  readonly component: CompiledComponent
  readonly mode: PageMode
  /** The caller's effective operations on the component. */
  readonly ops: OpMask
  readonly user: RequestUser
}

/** Options of a page filter, authorized through the page's view right (D12). */
export interface AuthorizedFilter {
  readonly [authorized]: 'filter'
  readonly page: CompiledPage
  readonly filter: CompiledFilter
  readonly mode: PageMode
  readonly user: RequestUser
}

/** One operation on a public API resource, for one token (§16). */
export interface AuthorizedResource {
  readonly [authorized]: 'resource'
  readonly resource: ResourceModel
  readonly operation: ApiOperation
  readonly token: { id: string; name: string }
  /** The token may also read the resource (`get` or `list`); writes answer with the row then. */
  readonly readable: boolean
}

export function grantResource(
  value: Omit<AuthorizedResource, typeof authorized>,
): AuthorizedResource {
  return Object.freeze(value) as AuthorizedResource
}

export function grantComponent(
  value: Omit<AuthorizedComponent, typeof authorized>,
): AuthorizedComponent {
  return Object.freeze(value) as AuthorizedComponent
}

export function grantFilter(value: Omit<AuthorizedFilter, typeof authorized>): AuthorizedFilter {
  return Object.freeze(value) as AuthorizedFilter
}
