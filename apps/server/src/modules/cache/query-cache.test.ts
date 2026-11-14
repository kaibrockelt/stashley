// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { TargetUnreachable } from '../execution/errors.ts'
import {
  maxEntryBytes,
  QueryCache,
  snapshotSeconds,
  type CacheDependencies,
} from './query-cache.ts'

const zahlungen: CacheDependencies = {
  connectionId: 'c1',
  tables: ['anmeldung', 'hotelbuchung', 'zahlung'],
  allTables: false,
  variables: ['current_event_id'],
}

function setup(maxBytes = 1_000_000) {
  let now = 1_000_000
  const events = new EventBus()
  const cache = new QueryCache({ maxBytes, events, clock: () => now })
  let loads = 0
  const load =
    (value: unknown = 'rows', size = 10) =>
    async () => {
      loads++
      await Promise.resolve()
      return { value, size }
    }
  return {
    cache,
    events,
    load,
    loads: () => loads,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('query cache', () => {
  it('serves fresh entries and loads again after the cache duration', async () => {
    const t = setup()
    const options = { key: 'q:1', ttlSeconds: 60, dependencies: zahlungen, load: t.load() }
    expect(await t.cache.load(options)).toEqual({
      value: 'rows',
      fetchedAt: 1_000_000,
      stale: false,
      tooLarge: false,
    })
    t.advance(59_000)
    expect((await t.cache.load(options)).fetchedAt).toBe(1_000_000)
    expect(t.loads()).toBe(1)
    t.advance(1_000)
    expect((await t.cache.load(options)).fetchedAt).toBe(1_060_000)
    expect(t.loads()).toBe(2)
  })

  it('runs concurrent misses once', async () => {
    const t = setup()
    const options = { key: 'q:1', ttlSeconds: 60, dependencies: zahlungen, load: t.load() }
    const results = await Promise.all([
      t.cache.load(options),
      t.cache.load(options),
      t.cache.load(options),
    ])
    expect(t.loads()).toBe(1)
    expect(results.map((result) => result.value)).toEqual(['rows', 'rows', 'rows'])
  })

  it('never stores live results, but still shares concurrent loads', async () => {
    const t = setup()
    const options = { key: 'q:live', ttlSeconds: 0, dependencies: zahlungen, load: t.load() }
    await Promise.all([t.cache.load(options), t.cache.load(options)])
    await t.cache.load(options)
    expect(t.loads()).toBe(2)
    expect(t.cache.size).toBe(0)
  })

  it('evicts entries when a dependency table is written, through views too', async () => {
    const t = setup()
    const status = { key: 'q:status', ttlSeconds: 300, dependencies: zahlungen, load: t.load() }
    const persons = {
      key: 'q:persons',
      ttlSeconds: 300,
      dependencies: { ...zahlungen, tables: ['person'], variables: [] },
      load: t.load(),
    }
    await t.cache.load(status)
    await t.cache.load(persons)
    t.events.emit('rows.written', { connectionId: 'c1', objects: ['zahlung'] })
    await t.cache.load(status)
    await t.cache.load(persons)
    expect(t.loads()).toBe(3)
    // Another connection's tables of the same name do not matter.
    t.events.emit('rows.written', { connectionId: 'c2', objects: ['person'] })
    await t.cache.load(persons)
    expect(t.loads()).toBe(3)
  })

  it('treats views with unknown base tables as depending on every table', async () => {
    const t = setup()
    const unknown = {
      key: 'q:unknown',
      ttlSeconds: 300,
      dependencies: { connectionId: 'c1', tables: ['v_geheim'], allTables: true, variables: [] },
      load: t.load(),
    }
    const persons = {
      key: 'q:persons',
      ttlSeconds: 300,
      dependencies: { ...zahlungen, tables: ['person'], variables: [] },
      load: t.load(),
    }
    await t.cache.load(unknown)
    await t.cache.load(persons)
    t.cache.invalidateTables('c1', ['station'])
    await t.cache.load(unknown)
    await t.cache.load(persons)
    expect(t.loads()).toBe(3)
  })

  it('evicts entries that used a changed instance variable, also variables found while loading', async () => {
    const t = setup()
    const event = { key: 'q:event', ttlSeconds: 300, dependencies: zahlungen, load: t.load() }
    const table = {
      key: 't:base-filter',
      ttlSeconds: 300,
      dependencies: { ...zahlungen, variables: [] },
      load: () => Promise.resolve({ value: 'rows', size: 10, variables: ['hotel_id'] }),
    }
    await t.cache.load(event)
    await t.cache.load(table)
    t.events.emit('variable.changed', { name: 'current_event_id' })
    t.events.emit('variable.changed', { name: 'hotel_id' })
    await t.cache.load(event)
    expect(t.loads()).toBe(2)
    let reloaded = false
    await t.cache.load({
      ...table,
      load: () => {
        reloaded = true
        return Promise.resolve({ value: 'x', size: 1 })
      },
    })
    expect(reloaded).toBe(true)
  })

  it('drops a connection on table access, catalog and connection changes', async () => {
    const t = setup()
    const options = { key: 'q:1', ttlSeconds: 300, dependencies: zahlungen, load: t.load() }
    for (const event of [
      'table-access.changed',
      'catalog.refreshed',
      'connection.changed',
    ] as const) {
      await t.cache.load(options)
      t.events.emit(event, { connectionId: 'c1' })
    }
    await t.cache.load(options)
    expect(t.loads()).toBe(4)
  })

  it('does not store a result whose load overlapped a write', async () => {
    const t = setup()
    let release: () => void = () => undefined
    const slow = {
      key: 'q:slow',
      ttlSeconds: 300,
      dependencies: zahlungen,
      load: () =>
        new Promise<{ value: string; size: number }>((resolve) => {
          release = () => resolve({ value: 'old', size: 10 })
        }),
    }
    const pending = t.cache.load(slow)
    await Promise.resolve()
    t.cache.invalidateTables('c1', ['zahlung'])
    release()
    expect((await pending).value).toBe('old')
    expect(t.cache.size).toBe(0)
  })

  it('does not hand a load that predates a write to requests after it', async () => {
    const t = setup()
    const releases: (() => void)[] = []
    const slow = (value: string) => () =>
      new Promise<{ value: string; size: number }>((resolve) => {
        releases.push(() => resolve({ value, size: 10 }))
      })
    const options = { key: 'q:race', ttlSeconds: 300, dependencies: zahlungen }
    const before = t.cache.load({ ...options, load: slow('old') })
    const joined = t.cache.load({ ...options, load: slow('unused') })
    await Promise.resolve()
    t.cache.invalidateTables('c1', ['zahlung'])
    const after = t.cache.load({ ...options, load: slow('new') })
    await Promise.resolve()
    expect(releases).toHaveLength(2)
    // The newer load finishes first and is stored; the older one is not.
    releases[1]?.()
    releases[0]?.()
    expect((await before).value).toBe('old')
    expect((await joined).value).toBe('old')
    expect((await after).value).toBe('new')
    const cached = await t.cache.load({ ...options, load: slow('again') })
    expect(cached.value).toBe('new')
    expect(releases).toHaveLength(2)
  })

  it('serves no stale entry once the database refuses the read', async () => {
    const t = setup()
    const ok = { key: 'q:1', ttlSeconds: 60, dependencies: zahlungen, load: t.load('cached') }
    await t.cache.load(ok)
    t.advance(120_000)
    await expect(
      t.cache.load({ ...ok, load: () => Promise.reject(new AppError('target_permission_denied')) }),
    ).rejects.toMatchObject({ code: 'target_permission_denied' })
    // The refused entry is gone: a later outage cannot bring it back.
    await expect(
      t.cache.load({ ...ok, load: () => Promise.reject(new TargetUnreachable()) }),
    ).rejects.toMatchObject({ code: 'target_unavailable' })
    // A plain `target_unavailable` (e.g. no read user) is no outage either.
    await t.cache.load({ ...ok, key: 'q:2' })
    t.advance(120_000)
    await expect(
      t.cache.load({
        ...ok,
        key: 'q:2',
        load: () => Promise.reject(new AppError('target_unavailable')),
      }),
    ).rejects.toMatchObject({ code: 'target_unavailable' })
  })

  it('serves expired entries as stale only while the database is unavailable', async () => {
    const t = setup()
    const ok = { key: 'q:1', ttlSeconds: 60, dependencies: zahlungen, load: t.load('cached') }
    await t.cache.load(ok)
    t.advance(120_000)
    const unavailable = () => Promise.reject(new TargetUnreachable())
    expect(await t.cache.load({ ...ok, load: unavailable })).toEqual({
      value: 'cached',
      fetchedAt: 1_000_000,
      stale: true,
      tooLarge: false,
    })
    await expect(
      t.cache.load({ ...ok, load: () => Promise.reject(new AppError('query_timeout')) }),
    ).rejects.toMatchObject({ code: 'query_timeout' })
    // An entry evicted by a write is gone and never served as stale.
    t.cache.invalidateTables('c1', ['zahlung'])
    await expect(t.cache.load({ ...ok, load: unavailable })).rejects.toMatchObject({
      code: 'target_unavailable',
    })
    await expect(t.cache.load({ ...ok, key: 'q:new', load: unavailable })).rejects.toBeInstanceOf(
      AppError,
    )
    await expect(
      t.cache.load({ ...ok, key: 'q:other', load: () => Promise.reject(new Error('x')) }),
    ).rejects.toThrow('x')
  })

  it('refreshes on demand and leaves out oversized results', async () => {
    const t = setup(10 * maxEntryBytes)
    const options = { key: 'q:1', ttlSeconds: 60, dependencies: zahlungen, load: t.load() }
    await t.cache.load(options)
    await t.cache.load({ ...options, refresh: true })
    expect(t.loads()).toBe(2)
    const big = await t.cache.load({
      key: 'q:big',
      ttlSeconds: 60,
      dependencies: zahlungen,
      load: () => Promise.resolve({ value: 'big', size: maxEntryBytes + 1 }),
    })
    expect(big.tooLarge).toBe(true)
    expect(t.cache.size).toBe(10)
  })

  it('evicts the least recently used entries at the size limit', async () => {
    const t = setup(25)
    for (const key of ['a', 'b', 'c']) {
      await t.cache.load({ key, ttlSeconds: 60, dependencies: zahlungen, load: t.load(key, 10) })
    }
    expect(t.cache.size).toBe(20)
    await t.cache.load({ key: 'a', ttlSeconds: 60, dependencies: zahlungen, load: t.load('a', 10) })
    expect(t.loads()).toBe(4)
    // Evicted entries leave the index, so a write later finds nothing to evict.
    t.cache.invalidateTables('c1', ['zahlung'])
    expect(t.cache.size).toBe(0)
  })

  it('keeps paging snapshots for five minutes', () => {
    const t = setup()
    const id = t.cache.keepSnapshot({ rows: [1, 2, 3] }, 30)
    expect(t.cache.snapshot(id)).toEqual({ value: { rows: [1, 2, 3] }, fetchedAt: 1_000_000 })
    t.advance(snapshotSeconds * 1000)
    expect(t.cache.snapshot(id)).toBeUndefined()
    expect(t.cache.snapshot('missing')).toBeUndefined()
  })
})
