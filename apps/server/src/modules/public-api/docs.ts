// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiOperation } from '@stashley/shared'
import type { EventBus } from '../../platform/events.ts'
import type { AccessService } from '../access/service.ts'
import type { ApiEndpoints } from './endpoints.ts'
import { openApiDocument, type DocumentedResource } from './openapi.ts'
import type { ApiPrincipal } from './tokens.ts'

/**
 * Generated OpenAPI documents (§16), cached per token and dropped whenever endpoints,
 * tokens, table access, the catalog or a connection change.
 */
export class ApiDocs {
  private readonly deps: { access: AccessService; endpoints: ApiEndpoints; baseUrl: string }
  private cache = new Map<string, Promise<Record<string, unknown>>>()

  constructor(deps: ApiDocs['deps'] & { events: EventBus }) {
    this.deps = deps
    const drop = () => {
      this.cache = new Map()
    }
    for (const event of [
      'api.changed',
      'table-access.changed',
      'catalog.refreshed',
      'connection.changed',
    ] as const) {
      deps.events.on(event, drop)
    }
  }

  private async documented(
    tableAccessId: string,
    allowed: (operation: ApiOperation) => boolean,
  ): Promise<DocumentedResource | undefined> {
    const resource = await this.deps.access.resourceModel(tableAccessId)
    if (resource === undefined) return undefined
    const enabled = await this.deps.endpoints.enabled(tableAccessId)
    const operations = resource.available.filter(
      (operation) => enabled.has(operation) && allowed(operation),
    )
    return operations.length === 0 ? undefined : { resource, operations }
  }

  private cached(key: string, build: () => Promise<Record<string, unknown>>) {
    let document = this.cache.get(key)
    if (document === undefined) {
      document = build()
      document.catch(() => this.cache.delete(key))
      this.cache.set(key, document)
    }
    return document
  }

  /** Only the endpoints this token can use. */
  forToken(principal: ApiPrincipal): Promise<Record<string, unknown>> {
    return this.cached(`token:${principal.tokenId}`, async () => {
      const resources: DocumentedResource[] = []
      for (const [id, granted] of principal.grants) {
        const entry = await this.documented(id, (operation) => granted.has(operation))
        if (entry !== undefined) resources.push(entry)
      }
      return openApiDocument(this.deps.baseUrl, resources)
    })
  }

  /** Every enabled endpoint, for admins. */
  full(): Promise<Record<string, unknown>> {
    return this.cached('full', async () => {
      const resources: DocumentedResource[] = []
      for (const state of await this.deps.endpoints.list()) {
        if (state.enabled.length === 0) continue
        const entry = await this.documented(state.tableAccessId, () => true)
        if (entry !== undefined) resources.push(entry)
      }
      return openApiDocument(this.deps.baseUrl, resources)
    })
  }
}
