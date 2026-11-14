// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { LRUCache } from 'lru-cache'
import { v7 as uuidv7 } from 'uuid'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { isUnavailable } from '../execution/errors.ts'

/** What a cached result depends on; writes and variable changes evict it (§12). */
export interface CacheDependencies {
  connectionId: string
  /** Tables, with views already expanded to their base tables. */
  tables: readonly string[]
  /** A view's base tables are unknown: every table of the connection counts. */
  allTables: boolean
  variables: readonly string[]
}

interface Entry {
  value: unknown
  fetchedAt: number
  expiresAt: number
  size: number
  dependencies: string[]
}

export interface Loaded<T> {
  value: T
  fetchedAt: number
  /** Served from an expired entry because the database could not be reached. */
  stale: boolean
  /** Not cached because the result exceeds the entry limit. */
  tooLarge: boolean
}

export interface LoadOptions<T> {
  key: string
  ttlSeconds: number
  dependencies: CacheDependencies
  /** Bypasses a fresh entry and replaces it (manual refresh). */
  refresh?: boolean
  load: () => Promise<{ value: T; size: number; variables?: readonly string[] }>
}

/** Results over this size are not cached (§12). */
export const maxEntryBytes = 20 * 1024 * 1024
/** Live query results stay this long as a paging snapshot (§10.7). */
export const snapshotSeconds = 5 * 60

const tableKey = (connectionId: string, table: string) => `t:${connectionId}:${table}`
/** Entries whose view dependencies are unknown: every write to the connection evicts them. */
const anyTableKey = (connectionId: string) => `a:${connectionId}`
const connectionKey = (connectionId: string) => `c:${connectionId}`
const variableKey = (name: string) => `v:${name}`

/**
 * The query cache (§12): an in-memory LRU with a size limit, single flight for concurrent
 * misses and an invalidation index from tables and variables to entries. Authorization runs
 * before every lookup; entries hold results only, never decisions.
 */
export class QueryCache {
  private readonly lru: LRUCache<string, Entry>
  private readonly index = new Map<string, Set<string>>()
  private readonly inflight = new Map<string, Promise<Loaded<unknown>>>()
  /** Sequence numbers of invalidations, so a load that started earlier is not stored. */
  private sequence = 0
  private readonly invalidated = new Map<string, number>()
  private readonly clock: Clock

  constructor(options: { maxBytes: number; events?: EventBus; clock?: Clock }) {
    this.clock = options.clock ?? systemClock
    this.lru = new LRUCache<string, Entry>({
      maxSize: options.maxBytes,
      maxEntrySize: maxEntryBytes,
      sizeCalculation: (entry) => Math.max(1, entry.size),
      dispose: (entry, key) => {
        for (const dependency of entry.dependencies) {
          const keys = this.index.get(dependency)
          keys?.delete(key)
          if (keys?.size === 0) this.index.delete(dependency)
        }
      },
    })
    const events = options.events
    if (events !== undefined) {
      events.on('rows.written', ({ connectionId, objects }) =>
        this.invalidateTables(connectionId, objects),
      )
      events.on('variable.changed', ({ name }) => this.invalidateVariable(name))
      // Exclusions, ceilings or relations changed: drop everything of the connection.
      events.on('table-access.changed', ({ connectionId }) =>
        this.invalidateConnection(connectionId),
      )
      events.on('connection.changed', ({ connectionId }) => this.invalidateConnection(connectionId))
      events.on('catalog.refreshed', ({ connectionId }) => this.invalidateConnection(connectionId))
    }
  }

  /** Bytes in use, for tests and diagnostics. */
  get size(): number {
    return this.lru.calculatedSize
  }

  private keysOf(dependencies: CacheDependencies, variables: readonly string[]): string[] {
    const keys = new Set<string>([connectionKey(dependencies.connectionId)])
    if (dependencies.allTables) keys.add(anyTableKey(dependencies.connectionId))
    for (const table of dependencies.tables) keys.add(tableKey(dependencies.connectionId, table))
    for (const name of [...dependencies.variables, ...variables]) keys.add(variableKey(name))
    return [...keys]
  }

  /**
   * The cached value, or the result of `load`. Concurrent misses for one key share a single
   * load. When the database is unreachable, an expired entry is served as stale.
   */
  async load<T>(options: LoadOptions<T>): Promise<Loaded<T>> {
    const existing = this.lru.get(options.key)
    const now = this.clock()
    if (existing !== undefined && options.refresh !== true && existing.expiresAt > now) {
      return {
        value: existing.value as T,
        fetchedAt: existing.fetchedAt,
        stale: false,
        tooLarge: false,
      }
    }
    const running = this.inflight.get(options.key)
    if (running !== undefined) return running as Promise<Loaded<T>>
    const started = this.sequence
    const promise = (async (): Promise<Loaded<T>> => {
      let loaded: Awaited<ReturnType<LoadOptions<T>['load']>>
      try {
        loaded = await options.load()
      } catch (error) {
        const stale = this.lru.get(options.key)
        if (error instanceof AppError && isUnavailable(error) && stale !== undefined) {
          return {
            value: stale.value as T,
            fetchedAt: stale.fetchedAt,
            stale: true,
            tooLarge: false,
          }
        }
        throw error
      }
      const fetchedAt = this.clock()
      const tooLarge = loaded.size > maxEntryBytes
      const dependencies = this.keysOf(options.dependencies, loaded.variables ?? [])
      const outdated = dependencies.some((key) => (this.invalidated.get(key) ?? -1) >= started)
      if (options.ttlSeconds > 0 && !tooLarge && !outdated) {
        this.store(options.key, {
          value: loaded.value,
          fetchedAt,
          expiresAt: fetchedAt + options.ttlSeconds * 1000,
          size: loaded.size,
          dependencies,
        })
      }
      return { value: loaded.value, fetchedAt, stale: false, tooLarge }
    })()
    this.inflight.set(options.key, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(options.key)
    }
  }

  private store(key: string, entry: Entry): void {
    this.lru.set(key, entry)
    if (!this.lru.has(key)) return
    for (const dependency of entry.dependencies) {
      let keys = this.index.get(dependency)
      if (keys === undefined) {
        keys = new Set()
        this.index.set(dependency, keys)
      }
      keys.add(key)
    }
  }

  private evict(dependency: string): void {
    this.invalidated.set(dependency, this.sequence++)
    for (const key of [...(this.index.get(dependency) ?? [])]) this.lru.delete(key)
  }

  /** A write evicts every entry that depends on one of the tables (§12). */
  invalidateTables(connectionId: string, tables: readonly string[]): void {
    for (const table of tables) this.evict(tableKey(connectionId, table))
    this.evict(anyTableKey(connectionId))
  }

  invalidateVariable(name: string): void {
    this.evict(variableKey(name))
  }

  invalidateConnection(connectionId: string): void {
    this.evict(connectionKey(connectionId))
  }

  /** Keeps a result for paging through it later (live queries, §10.7); returns its ID. */
  keepSnapshot(value: unknown, size: number): string {
    const id = uuidv7()
    const now = this.clock()
    this.store(`snapshot:${id}`, {
      value,
      fetchedAt: now,
      expiresAt: now + snapshotSeconds * 1000,
      size,
      dependencies: [],
    })
    return id
  }

  snapshot<T>(id: string): { value: T; fetchedAt: number } | undefined {
    const entry = this.lru.get(`snapshot:${id}`)
    if (entry === undefined || entry.expiresAt <= this.clock()) return undefined
    return { value: entry.value as T, fetchedAt: entry.fetchedAt }
  }
}
