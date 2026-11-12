// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
export type Clock = () => number

export const systemClock: Clock = () => Date.now()

export const minute = 60_000
export const hour = 60 * minute
export const day = 24 * hour

export function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
