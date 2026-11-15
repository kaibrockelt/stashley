// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { layoutsFor, rowSpans } from './grid-layout.ts'

describe('rowSpans', () => {
  it('uses the layout when every block is there', () => {
    expect(rowSpans('8-4', 2)).toEqual([8, 4])
    expect(rowSpans('6-3-3', 3)).toEqual([6, 3, 3])
  })

  it('shares the width equally when blocks are missing', () => {
    expect(rowSpans('8-4', 1)).toEqual([12])
    expect(rowSpans('3-3-3-3', 2)).toEqual([6, 6])
    expect(rowSpans('3-3-3-3', 3)).toEqual([4, 4, 4])
    expect(rowSpans('12', 0)).toEqual([])
  })

  it('lists layouts per block count', () => {
    expect(layoutsFor(2)).toEqual(['6-6', '8-4', '4-8'])
    expect(layoutsFor(4)).toEqual(['3-3-3-3'])
  })
})
