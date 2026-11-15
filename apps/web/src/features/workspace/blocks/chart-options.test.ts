// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { prepareChart, type ChartSettings } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { chartPalettes } from '../../../ui/chart-palette.ts'
import { buildOption, type ChartLabels } from './chart-options.ts'

const labels: ChartLabels = {
  dimension: (value) => (value.kind === 'value' ? String(value.value) : value.kind),
  measure: (value) => (value === null ? '–' : String(value)),
  column: (column) => column.toUpperCase(),
  percent: (value) => (value === null ? '–' : `${Math.round(value * 100)} %`),
  funnelStage: (share, loss) => `${share}/${loss ?? ''}`,
}
const palette = chartPalettes.light
const settings = (partial: Partial<ChartSettings>): ChartSettings => ({
  chart: 'bar',
  height: 'M',
  x: 'k',
  measures: ['v'],
  ...partial,
})
const rows: Record<string, unknown>[] = [
  { k: 'DE', v: 3, w: 1 },
  { k: 'AT', v: 5, w: null },
]

function option(partial: Partial<ChartSettings>, data = rows) {
  const chartSettings = settings(partial)
  return buildOption(prepareChart(data, chartSettings), chartSettings, palette, labels) as Record<
    string,
    unknown
  > & { series: Record<string, unknown>[] }
}

describe('buildOption', () => {
  it('builds bars with categories, one series per measure and no legend for one series', () => {
    const bar = option({})
    expect(bar.xAxis).toMatchObject({ type: 'category', data: ['AT', 'DE'] })
    expect(bar.series).toMatchObject([{ type: 'bar', name: 'V', data: [5, 3] }])
    expect(bar.legend).toMatchObject({ show: false })
    const horizontal = option({ orientation: 'horizontal', measures: ['v', 'w'] })
    expect(horizontal.yAxis).toMatchObject({ type: 'category', inverse: true })
    expect(horizontal.legend).toMatchObject({ show: true })
    expect(horizontal.series[1]).toMatchObject({ itemStyle: { decal: { symbol: 'rect' } } })
  })

  it('stacks and normalizes', () => {
    const stacked = option({ chart: 'stacked', measures: ['v', 'w'], normalize: true })
    expect(stacked.series.every((entry) => entry.stack === 'total')).toBe(true)
    expect(stacked.yAxis).toMatchObject({ max: 1 })
  })

  it('draws lines with markers, dashes and gaps', () => {
    const line = option({ chart: 'area', measures: ['v', 'w'] })
    expect(line.series[0]).toMatchObject({
      type: 'line',
      symbol: 'circle',
      connectNulls: false,
      areaStyle: {},
    })
    expect(line.series[1]).toMatchObject({
      symbol: 'rect',
      lineStyle: { type: 'dashed' },
      data: [null, 1],
    })
  })

  it('leaves missing donut segments out and colors Other neutrally', () => {
    const donut = option({ chart: 'donut' }, [...rows, { k: 'CH', v: null, w: 0 }])
    const data = donut.series[0]?.data as { name: string }[]
    expect(data.map((entry) => entry.name)).toEqual(['AT', 'DE'])
    const many = option(
      { chart: 'donut' },
      Array.from({ length: 10 }, (_, i) => ({ k: `c${i}`, v: 10 - i })),
    )
    const last = (many.series[0]?.data as { name: string; itemStyle: { color: string } }[]).at(-1)
    expect(last).toMatchObject({ name: 'other', itemStyle: { color: palette.other } })
  })

  it('builds heatmaps, scatter, bubbles and funnels', () => {
    const heatmap = option({ chart: 'heatmap', series: 's' }, [{ k: 1, s: 'a', v: 2 }])
    expect(heatmap.series[0]).toMatchObject({ type: 'heatmap', data: [[0, 0, 2]] })
    expect(heatmap.visualMap).toMatchObject({ min: 2, max: 2 })
    const bubble = option({ chart: 'bubble', x: 'x', measures: ['y', 'z'], group: 'g' }, [
      { x: 1, y: 2, z: 4, g: 'a' },
      { x: 2, y: 3, z: 1, g: 'b' },
    ])
    expect(bubble.series.map((entry) => entry.name)).toEqual(['a', 'b'])
    const size = bubble.series[0]?.symbolSize as (value: number[]) => number
    expect(size([1, 2, 4])).toBe(40)
    const funnel = option({ chart: 'funnel' }, [
      { k: 'a', v: 10 },
      { k: 'b', v: 5 },
    ])
    expect(funnel.series[0]).toMatchObject({ type: 'funnel', sort: 'none' })
  })
})
