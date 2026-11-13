// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { minute, systemClock, type Clock } from '../../platform/clock.ts'

/** Above this many keys, expired entries are swept, so random keys cannot grow memory. */
const maxEntries = 10_000

/**
 * Counts failures per key (account, session) in memory. After `threshold` failures within
 * the window, attempts are blocked for a delay that doubles with every further failure.
 */
export class FailureLimiter {
  private readonly entries = new Map<
    string,
    { failures: number; first: number; blockedUntil: number }
  >()
  private readonly threshold: number
  private readonly window: number
  private readonly clock: Clock

  constructor(options: { threshold?: number; windowMs?: number; clock?: Clock } = {}) {
    this.threshold = options.threshold ?? 5
    this.window = options.windowMs ?? 15 * minute
    this.clock = options.clock ?? systemClock
  }

  /** Milliseconds until the key may try again; 0 when allowed. */
  retryAfter(key: string): number {
    const entry = this.entries.get(key)
    if (entry === undefined) return 0
    const now = this.clock()
    if (now - entry.first > this.window && now >= entry.blockedUntil) {
      this.entries.delete(key)
      return 0
    }
    return Math.max(0, entry.blockedUntil - now)
  }

  fail(key: string): void {
    const now = this.clock()
    if (this.entries.size > maxEntries) this.sweep(now)
    const entry = this.entries.get(key)
    if (entry === undefined || now - entry.first > this.window) {
      this.entries.set(key, { failures: 1, first: now, blockedUntil: 0 })
      return
    }
    entry.failures += 1
    if (entry.failures >= this.threshold) {
      const exponent = Math.min(entry.failures - this.threshold, 10)
      entry.blockedUntil = now + 2 ** exponent * 30_000
    }
  }

  reset(key: string): void {
    this.entries.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.first > this.window && now >= entry.blockedUntil) this.entries.delete(key)
    }
  }
}

/** Allows at most `max` hits per key within a fixed window, e.g. reset emails per address. */
export class WindowLimiter {
  private readonly entries = new Map<string, { count: number; start: number }>()
  private readonly max: number
  private readonly window: number
  private readonly clock: Clock

  constructor(options: { max: number; windowMs: number; clock?: Clock }) {
    this.max = options.max
    this.window = options.windowMs
    this.clock = options.clock ?? systemClock
  }

  /** Counts a hit; false when the key is over its limit. */
  hit(key: string): boolean {
    const now = this.clock()
    if (this.entries.size > maxEntries) this.sweep(now)
    const entry = this.entries.get(key)
    if (entry === undefined || now - entry.start >= this.window) {
      this.entries.set(key, { count: 1, start: now })
      return true
    }
    entry.count += 1
    return entry.count <= this.max
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.start >= this.window) this.entries.delete(key)
    }
  }
}
