// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * In-process events (§5.1). Caches and compiled models listen to them; publishers do not
 * know their listeners. Handlers run synchronously and must not throw.
 */
export interface EventMap {
  /** Table access, column exclusions, display templates or relations of a connection changed. */
  'table-access.changed': { connectionId: string }
  /** A schema read stored a new catalog snapshot. */
  'catalog.refreshed': { connectionId: string }
  /** Settings, credentials or grant reports of a connection changed, or it was removed. */
  'connection.changed': { connectionId: string }
  'page.published': { pageId: string }
  'page.changed': { pageId: string }
  'query.changed': { queryId: string }
  /** The result columns of a query version became known (§10.8). */
  'query.described': { queryId: string }
  'roles.changed': Record<string, never>
  'user.changed': { userId: string }
  'variable.changed': { name: string }
  /** Endpoints, tokens or token grants of the public API changed. */
  'api.changed': Record<string, never>
  /** Rows of these objects were written through the UI, the public API or an import. */
  'rows.written': { connectionId: string; objects: string[] }
}

export type EventName = keyof EventMap
type Handler<K extends EventName> = (payload: EventMap[K]) => void

export class EventBus {
  private readonly handlers = new Map<EventName, Set<Handler<never>>>()
  private readonly onError: (error: unknown, event: EventName) => void

  constructor(onError: (error: unknown, event: EventName) => void = () => undefined) {
    this.onError = onError
  }

  on<K extends EventName>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        ;(handler as Handler<K>)(payload)
      } catch (error) {
        this.onError(error, event)
      }
    }
  }
}
