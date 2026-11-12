// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { minute, systemClock, type Clock } from '../../platform/clock.ts'

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
}
