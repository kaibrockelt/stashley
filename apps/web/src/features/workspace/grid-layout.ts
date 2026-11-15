// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RowLayout } from '@stashley/shared'

/**
 * Column spans of a row (§13.4). When blocks are missing, the remaining ones share the row
 * equally: 1 → 12, 2 → 6 + 6, 3 → 4 + 4 + 4.
 */
export function rowSpans(layout: RowLayout, count: number): number[] {
  const spans = layout.split('-').map(Number)
  if (count === spans.length) return spans
  if (count <= 0) return []
  return Array.from({ length: count }, () => 12 / count)
}

/** Layouts with the given number of blocks, for the editor. */
export function layoutsFor(count: number): RowLayout[] {
  const all: RowLayout[] = ['12', '6-6', '8-4', '4-8', '4-4-4', '6-3-3', '3-3-3-3']
  return all.filter((layout) => layout.split('-').length === count)
}

/** Chart heights S, M and L in pixels. */
export const chartHeights = { S: 200, M: 300, L: 440 } as const
