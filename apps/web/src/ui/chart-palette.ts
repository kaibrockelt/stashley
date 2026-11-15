// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chart palettes (§22). ECharts draws on a canvas and needs concrete colors, so the palettes
 * are defined here rather than as CSS custom properties. `chart-palette.test.ts` checks every
 * color against the chart surface of its theme (WCAG 1.4.11, 3:1 for graphical objects).
 * Series also differ in markers and dash patterns, so color never carries information alone.
 */
export interface ChartPalette {
  surface: string
  text: string
  textMuted: string
  grid: string
  categorical: readonly string[]
  /** Low to high; the heatmap's sequential scale. */
  sequential: readonly [string, string]
  /** The "Other" bucket. */
  other: string
}

export const chartPalettes: Record<'light' | 'dark', ChartPalette> = {
  light: {
    surface: '#ffffff',
    text: '#1f2229',
    textMuted: '#5d626e',
    grid: '#e3e5ea',
    categorical: [
      '#2a6fdb',
      '#c23b4f',
      '#16806a',
      '#b35f00',
      '#7b4fc9',
      '#7d6a00',
      '#b8337f',
      '#4f6070',
    ],
    sequential: ['#dbe7fb', '#0b3f91'],
    other: '#7a7f8a',
  },
  dark: {
    surface: '#1b1c21',
    text: '#eceef2',
    textMuted: '#a9aeb8',
    grid: '#33353d',
    categorical: [
      '#6ea8ff',
      '#ff8a96',
      '#4fd1a5',
      '#f5a524',
      '#b89bff',
      '#d9c24a',
      '#ff7ac6',
      '#a7b4c2',
    ],
    sequential: ['#24324f', '#a9ccff'],
    other: '#8c919c',
  },
}

/** Marker symbols per series, in the same order as the categorical colors. */
export const seriesSymbols = [
  'circle',
  'rect',
  'triangle',
  'diamond',
  'roundRect',
  'pin',
  'arrow',
  'emptyCircle',
] as const

/** Dash patterns per series for line charts. */
export const seriesDashes = ['solid', 'dashed', 'dotted'] as const

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Linear interpolation between two hex colors, for the sequential scale. */
export function mix(from: string, to: string, t: number): string {
  const a = Number.parseInt(from.slice(1), 16)
  const b = Number.parseInt(to.slice(1), 16)
  const part = (shift: number) => {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255
    return Math.round(x + (y - x) * t)
  }
  return `#${((part(16) << 16) | (part(8) << 8) | part(0)).toString(16).padStart(6, '0')}`
}
