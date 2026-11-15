// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { ChartSettings } from '../model/block-settings.ts'
import {
  prepareChart,
  prepareMetric,
  toDimension,
  toNumber,
  type CategoryChart,
} from './chart-data.ts'

const base = (settings: Partial<ChartSettings>): ChartSettings => ({
  chart: 'bar',
  height: 'M',
  x: 'k',
  measures: ['v'],
  ...settings,
})
const v = (value: string | number) => ({ kind: 'value' as const, value })

describe('prepareChart', () => {
  it('sorts categories by value, labels NULL as empty and keeps NULL measures as gaps', () => {
    const chart = prepareChart(
      [
        { k: 'DE', v: 3 },
        { k: null, v: 9 },
        { k: 'AT', v: null },
        { k: 'CH', v: '5.5' },
      ],
      base({}),
    ) as CategoryChart
    expect(chart.categories).toEqual([{ kind: 'empty' }, v('CH'), v('DE'), v('AT')])
    expect(chart.series[0]?.values).toEqual([9, 5.5, 3, null])
  })

  it('sorts by label, ascending or in query order', () => {
    const rows = [
      { k: 'b', v: 1 },
      { k: 'a', v: 2 },
      { k: 'c', v: 3 },
    ]
    const labels = (sort: ChartSettings['sort']) =>
      (prepareChart(rows, base({ sort })) as CategoryChart).categories.map((c) =>
        c.kind === 'value' ? c.value : c.kind,
      )
    expect(labels('label')).toEqual(['a', 'b', 'c'])
    expect(labels('value_asc')).toEqual(['b', 'a', 'c'])
    expect(labels('query')).toEqual(['b', 'a', 'c'])
    expect((prepareChart(rows, base({}), true) as CategoryChart).categories[0]).toEqual(v('b'))
  })

  it('keeps time ascending and fills gaps with zero when asked', () => {
    const rows = [
      { k: '2026-02-01', v: 2 },
      { k: '2026-01-01', v: null },
    ]
    const chart = prepareChart(rows, base({ chart: 'line', sort: 'value_desc' })) as CategoryChart
    expect(chart.categories).toEqual([v('2026-01-01'), v('2026-02-01')])
    expect(chart.series[0]?.values).toEqual([null, 2])
    expect(
      (prepareChart(rows, base({ chart: 'line', gaps: 'zero' })) as CategoryChart).series[0]
        ?.values,
    ).toEqual([0, 2])
  })

  it('cuts categories at the limit and flags it', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ k: `c${i}`, v: i }))
    const chart = prepareChart(rows, base({})) as CategoryChart
    expect(chart.categories).toHaveLength(50)
    expect(chart.exceeded).toBe(true)
    expect(chart.series[0]?.values[0]).toBe(59)
  })

  it('folds donut segments beyond 8 into Other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ k: `c${i}`, v: i + 1 }))
    const chart = prepareChart(rows, base({ chart: 'donut', sort: 'label' })) as CategoryChart
    expect(chart.categories).toHaveLength(8)
    expect(chart.categories[7]).toEqual({ kind: 'other' })
    expect(chart.series[0]?.values[7]).toBe(1 + 2 + 3)
    expect(chart.exceeded).toBe(false)
  })

  it('builds series from the long format and folds series beyond 12', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ k: 'w1', s: `s${i}`, v: 14 - i }))
    rows.push({ k: 'w2', s: 's0', v: 1 })
    const chart = prepareChart(rows, base({ chart: 'line', series: 's' })) as CategoryChart
    expect(chart.series).toHaveLength(12)
    expect(chart.series[11]).toEqual({
      name: { kind: 'other' },
      measure: 'v',
      values: [3 + 2 + 1, null],
    })
    expect(chart.series[0]?.values).toEqual([14, 1])
  })

  it('builds wide format series per measure and keeps the first value of a repeated category', () => {
    const chart = prepareChart(
      [
        { k: 'a', v: 1, w: 2 },
        { k: 'a', v: 5, w: 6 },
      ],
      base({ measures: ['v', 'w'] }),
    ) as CategoryChart
    expect(chart.series.map((s) => s.values)).toEqual([[1], [2]])
  })

  it('normalizes stacked bars and drops negative values', () => {
    const chart = prepareChart(
      [
        { k: 'a', v: 1, w: 3 },
        { k: 'b', v: -1, w: 2 },
        { k: 'c', v: 0, w: 0 },
      ],
      base({ chart: 'stacked', measures: ['v', 'w'], normalize: true, sort: 'query' }),
    ) as CategoryChart
    expect(chart.series[0]?.values).toEqual([0.25, null, null])
    expect(chart.series[1]?.values).toEqual([0.75, 1, null])
  })

  it('builds a heatmap with its range', () => {
    const chart = prepareChart(
      [
        { k: 1, s: '10:00', v: 4 },
        { k: 2, s: '10:15', v: null },
        { k: 1, s: '10:15', v: 7 },
      ],
      base({ chart: 'heatmap', series: 's' }),
    )
    expect(chart).toEqual({
      kind: 'heatmap',
      x: [v(1), v(2)],
      y: [v('10:00'), v('10:15')],
      cells: [
        [0, 0, 4],
        [1, 1, null],
        [0, 1, 7],
      ],
      min: 4,
      max: 7,
      exceeded: false,
    })
  })

  it('flags heatmaps over 50 values per axis', () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ k: i, s: 'a', v: i }))
    const chart = prepareChart(rows, base({ chart: 'heatmap', series: 's' }))
    expect(chart.kind === 'heatmap' && chart.exceeded && chart.x.length).toBe(50)
  })

  it('builds scatter and bubble points and skips incomplete ones', () => {
    const chart = prepareChart(
      [
        { x: 1, y: 2, z: 3, g: 'a' },
        { x: null, y: 2, z: 3, g: 'a' },
        { x: 2, y: 4, z: null, g: 'b' },
      ],
      base({ chart: 'bubble', x: 'x', measures: ['y', 'z'], group: 'g' }),
    )
    expect(chart).toEqual({
      kind: 'scatter',
      points: [
        { x: 1, y: 2, size: 3, group: v('a') },
        { x: 2, y: 4, size: null, group: v('b') },
      ],
      groups: [v('a'), v('b')],
      exceeded: false,
    })
    const plain = prepareChart(
      [{ x: 1, y: 1 }],
      base({ chart: 'scatter', x: 'x', measures: ['y'] }),
    )
    expect(plain.kind === 'scatter' && plain.points[0]).toEqual({
      x: 1,
      y: 1,
      size: null,
      group: null,
    })
  })

  it('computes funnel shares and losses', () => {
    const chart = prepareChart(
      [
        { k: 'registered', v: 260 },
        { k: 'paid', v: 221 },
        { k: 'checked in', v: null },
        { k: 'finished', v: 61 },
      ],
      base({ chart: 'funnel' }),
    )
    expect(chart.kind === 'funnel' && chart.stages.map((s) => [s.share, s.loss])).toEqual([
      [1, null],
      [0.85, 0.15],
      [null, null],
      [61 / 260, null],
    ])
  })
})

describe('prepareMetric', () => {
  it('computes trend, progress and tone', () => {
    const settings = {
      value: 'v',
      comparison: { column: 'c', mode: 'trend' as const },
      target: 200,
      thresholds: [
        { min: 150, tone: 'success' as const },
        { min: 0, tone: 'danger' as const },
        { min: 100, tone: 'warning' as const },
      ],
    }
    expect(prepareMetric([{ v: 120, c: 100 }], settings)).toEqual({
      value: 120,
      comparison: 100,
      trend: 0.2,
      target: 200,
      progress: 0.6,
      tone: 'warning',
    })
  })

  it('takes the target from a column and handles missing values', () => {
    expect(
      prepareMetric([{ v: 50, t: 200 }], {
        value: 'v',
        comparison: { column: 't', mode: 'target' },
      }),
    ).toMatchObject({ target: 200, progress: 0.25, trend: null, comparison: null })
    expect(prepareMetric([], { value: 'v' })).toEqual({
      value: null,
      comparison: null,
      trend: null,
      target: null,
      progress: null,
      tone: null,
    })
  })
})

describe('value conversion', () => {
  it('reads numbers and dimensions', () => {
    expect([
      toNumber('12.5'),
      toNumber('x'),
      toNumber(true),
      toNumber(10n),
      toNumber(Infinity),
      toNumber({}),
    ]).toEqual([12.5, null, 1, 10, null, null])
    expect([toDimension(false), toDimension({ a: 1 })]).toEqual([v(0), v('{"a":1}')])
  })
})
