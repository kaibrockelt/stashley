// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { chartPalettes, contrast, mix, seriesSymbols } from './chart-palette.ts'

describe('chart palettes', () => {
  for (const [theme, palette] of Object.entries(chartPalettes)) {
    it(`keeps every ${theme} series color at 3:1 against the surface`, () => {
      for (const color of [...palette.categorical, palette.other, palette.sequential[1]]) {
        expect(contrast(color, palette.surface), color).toBeGreaterThanOrEqual(3)
      }
    })

    it(`keeps ${theme} chart text at 4.5:1`, () => {
      expect(contrast(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.textMuted, palette.surface)).toBeGreaterThanOrEqual(4.5)
    })

    it(`spreads the ${theme} sequential scale`, () => {
      expect(contrast(palette.sequential[0], palette.sequential[1])).toBeGreaterThanOrEqual(3)
    })
  }

  it('gives every series color its own marker', () => {
    expect(seriesSymbols.length).toBe(chartPalettes.light.categorical.length)
    expect(new Set(seriesSymbols).size).toBe(seriesSymbols.length)
  })

  it('mixes colors linearly', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})
