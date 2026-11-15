// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ChartSettings, MetricSettings } from '../model/block-settings.ts'
import { chartLimits } from './shape.ts'

/**
 * Turns a query result into what a renderer draws (architecture §10.8). Blocks never aggregate,
 * except for the "Other" bucket. A NULL measure stays a gap (`null`), a NULL dimension becomes
 * the `empty` label. Over a limit the first values are kept and `exceeded` is set, so managers
 * see a hint and users the values up to the limit.
 */

type Row = Readonly<Record<string, unknown>>

/** A dimension value: `null` is labeled "(empty)", `other` is the "Other" bucket. */
export type DimensionValue =
  { kind: 'value'; value: string | number } | { kind: 'empty' } | { kind: 'other' }

export interface ChartSeries {
  /** The measure column (wide format) or the series dimension value (long format). */
  name: DimensionValue
  measure: string
  values: (number | null)[]
}

export interface CategoryChart {
  kind: 'category'
  categories: DimensionValue[]
  series: ChartSeries[]
  exceeded: boolean
}

export interface HeatmapChart {
  kind: 'heatmap'
  x: DimensionValue[]
  y: DimensionValue[]
  /** [xIndex, yIndex, value] */
  cells: [number, number, number | null][]
  min: number | null
  max: number | null
  exceeded: boolean
}

export interface ScatterPoint {
  x: number
  y: number
  size: number | null
  group: DimensionValue | null
}

export interface ScatterChart {
  kind: 'scatter'
  points: ScatterPoint[]
  groups: DimensionValue[]
  exceeded: boolean
}

export interface FunnelStage {
  label: DimensionValue
  value: number | null
  /** Share of the first stage, 0–1. */
  share: number | null
  /** Loss against the previous stage, 0–1. */
  loss: number | null
}

export interface FunnelChart {
  kind: 'funnel'
  stages: FunnelStage[]
  exceeded: boolean
}

export type ChartData = CategoryChart | HeatmapChart | ScatterChart | FunnelChart

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function toDimension(value: unknown): DimensionValue {
  if (value === null || value === undefined) return { kind: 'empty' }
  if (typeof value === 'number' || typeof value === 'string') return { kind: 'value', value }
  if (typeof value === 'boolean') return { kind: 'value', value: value ? 1 : 0 }
  return { kind: 'value', value: JSON.stringify(value) ?? '' }
}

export function dimensionKey(value: DimensionValue): string {
  return value.kind === 'value' ? `v:${typeof value.value}:${String(value.value)}` : value.kind
}

/** Distinct dimension values in order of first appearance. */
function distinct(rows: readonly Row[], column: string): DimensionValue[] {
  const seen = new Map<string, DimensionValue>()
  for (const row of rows) {
    const value = toDimension(row[column])
    const key = dimensionKey(value)
    if (!seen.has(key)) seen.set(key, value)
  }
  return [...seen.values()]
}

function compareDimensions(a: DimensionValue, b: DimensionValue): number {
  // Empty sorts last; time values are ISO strings or years, so plain comparison is ascending.
  if (a.kind !== 'value') return b.kind !== 'value' ? 0 : 1
  if (b.kind !== 'value') return -1
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value
  return String(a.value) < String(b.value) ? -1 : String(a.value) > String(b.value) ? 1 : 0
}

const sum = (values: readonly (number | null)[]) =>
  values.reduce<number | null>(
    (total, value) => (value === null ? total : (total ?? 0) + value),
    null,
  )

function isTimeChart(settings: ChartSettings): boolean {
  return settings.chart === 'line' || settings.chart === 'area' || settings.chart === 'column'
}

/** Category, bar, stacked, donut and time charts, in wide or long format. */
function categoryChart(
  rows: readonly Row[],
  settings: ChartSettings,
  ordered: boolean,
): CategoryChart {
  const time = isTimeChart(settings)
  let categories = distinct(rows, settings.x)
  if (time) categories.sort(compareDimensions)
  const index = new Map(categories.map((value, i) => [dimensionKey(value), i]))

  let series: ChartSeries[]
  if (settings.series !== undefined) {
    const measure = settings.measures[0] ?? ''
    const names = distinct(rows, settings.series)
    const byName = new Map(
      names.map((name) => [
        dimensionKey(name),
        { name, measure, values: categories.map(() => null as number | null) },
      ]),
    )
    for (const row of rows) {
      const entry = byName.get(dimensionKey(toDimension(row[settings.series])))
      const at = index.get(dimensionKey(toDimension(row[settings.x])))
      if (entry !== undefined && at !== undefined) entry.values[at] = toNumber(row[measure])
    }
    series = [...byName.values()]
    if (series.length > chartLimits.series) {
      // Keep the largest series; the rest become "Other", summed per category.
      series.sort((a, b) => (sum(b.values) ?? 0) - (sum(a.values) ?? 0))
      const rest = series.slice(chartLimits.series - 1)
      series = [
        ...series.slice(0, chartLimits.series - 1),
        {
          name: { kind: 'other' },
          measure,
          values: categories.map((_, i) => sum(rest.map((entry) => entry.values[i] ?? null))),
        },
      ]
    }
  } else {
    const values = settings.measures.map(() => categories.map(() => null as number | null))
    for (const row of rows) {
      const at = index.get(dimensionKey(toDimension(row[settings.x])))
      if (at === undefined) continue
      settings.measures.forEach((measure, m) => {
        const target = values[m]
        // Rows repeating a category keep the first value: blocks do not aggregate.
        if (target !== undefined && target[at] === null) target[at] = toNumber(row[measure])
      })
    }
    series = settings.measures.map((measure, m) => ({
      name: { kind: 'value', value: measure },
      measure,
      values: values[m] ?? [],
    }))
  }

  if (time && settings.gaps === 'zero') {
    for (const entry of series) entry.values = entry.values.map((value) => value ?? 0)
  }

  // Sorting: time ascending; ordered dimensions keep the query order; otherwise by value.
  // Donuts always sort by value, so "Other" holds the smallest segments.
  const sort =
    time || ordered
      ? 'query'
      : settings.chart === 'donut'
        ? 'value_desc'
        : (settings.sort ?? 'value_desc')
  if (sort !== 'query') {
    const totals = categories.map(
      (_, i) => sum(series.map((entry) => entry.values[i] ?? null)) ?? -Infinity,
    )
    const order = categories.map((_, i) => i)
    if (sort === 'label') order.sort((a, b) => compareDimensions(categories[a]!, categories[b]!))
    else
      order.sort((a, b) =>
        sort === 'value_desc' ? totals[b]! - totals[a]! : totals[a]! - totals[b]!,
      )
    categories = order.map((i) => categories[i]!)
    for (const entry of series) entry.values = order.map((i) => entry.values[i] ?? null)
  }

  let exceeded = false
  if (settings.chart === 'donut' && categories.length > chartLimits.segments) {
    // Donut segments are sorted by value, so "Other" sums the smallest ones.
    const keep = chartLimits.segments - 1
    categories = [...categories.slice(0, keep), { kind: 'other' }]
    for (const entry of series) {
      entry.values = [...entry.values.slice(0, keep), sum(entry.values.slice(keep))]
    }
  } else {
    const limit = time ? chartLimits.pointsPerSeries : chartLimits.categories
    if (categories.length > limit) {
      exceeded = true
      categories = categories.slice(0, limit)
      for (const entry of series) entry.values = entry.values.slice(0, limit)
    }
  }
  return { kind: 'category', categories, series, exceeded }
}

function heatmap(rows: readonly Row[], settings: ChartSettings): HeatmapChart {
  const yColumn = settings.series ?? ''
  const measure = settings.measures[0] ?? ''
  let x = distinct(rows, settings.x)
  let y = distinct(rows, yColumn)
  const exceeded = x.length > chartLimits.heatmapAxis || y.length > chartLimits.heatmapAxis
  x = x.slice(0, chartLimits.heatmapAxis)
  y = y.slice(0, chartLimits.heatmapAxis)
  const xIndex = new Map(x.map((value, i) => [dimensionKey(value), i]))
  const yIndex = new Map(y.map((value, i) => [dimensionKey(value), i]))
  const cells: [number, number, number | null][] = []
  let min: number | null = null
  let max: number | null = null
  for (const row of rows) {
    const xi = xIndex.get(dimensionKey(toDimension(row[settings.x])))
    const yi = yIndex.get(dimensionKey(toDimension(row[yColumn])))
    if (xi === undefined || yi === undefined) continue
    const value = toNumber(row[measure])
    cells.push([xi, yi, value])
    if (value !== null) {
      min = min === null ? value : Math.min(min, value)
      max = max === null ? value : Math.max(max, value)
    }
  }
  return { kind: 'heatmap', x, y, cells, min, max, exceeded }
}

function scatter(rows: readonly Row[], settings: ChartSettings): ScatterChart {
  const [yColumn, sizeColumn] = settings.measures
  const points: ScatterPoint[] = []
  for (const row of rows) {
    const x = toNumber(row[settings.x])
    const y = yColumn === undefined ? null : toNumber(row[yColumn])
    if (x === null || y === null) continue
    points.push({
      x,
      y,
      size:
        settings.chart === 'bubble' && sizeColumn !== undefined ? toNumber(row[sizeColumn]) : null,
      group: settings.group === undefined ? null : toDimension(row[settings.group]),
    })
  }
  const exceeded = points.length > chartLimits.scatterPoints
  const kept = points.slice(0, chartLimits.scatterPoints)
  const groups = new Map<string, DimensionValue>()
  for (const point of kept) if (point.group) groups.set(dimensionKey(point.group), point.group)
  return { kind: 'scatter', points: kept, groups: [...groups.values()], exceeded }
}

function funnel(rows: readonly Row[], settings: ChartSettings): FunnelChart {
  const measure = settings.measures[0] ?? ''
  const exceeded = rows.length > chartLimits.funnelStages
  const stages: FunnelStage[] = []
  const first = toNumber(rows[0]?.[measure])
  rows.slice(0, chartLimits.funnelStages).forEach((row, i) => {
    const value = toNumber(row[measure])
    const previous = i === 0 ? null : (stages[i - 1]?.value ?? null)
    stages.push({
      label: toDimension(row[settings.x]),
      value,
      share: value !== null && first !== null && first !== 0 ? value / first : null,
      loss:
        value !== null && previous !== null && previous !== 0
          ? (previous - value) / previous
          : null,
    })
  })
  return { kind: 'funnel', stages, exceeded }
}

/**
 * `ordered` says the x dimension has the role `ordered`, so the query order is kept.
 * Stacked charts and donuts need values ≥ 0; negative values are left out as gaps.
 */
export function prepareChart(
  rows: readonly Row[],
  settings: ChartSettings,
  ordered = false,
): ChartData {
  switch (settings.chart) {
    case 'heatmap':
      return heatmap(rows, settings)
    case 'scatter':
    case 'bubble':
      return scatter(rows, settings)
    case 'funnel':
      return funnel(rows, settings)
    default: {
      const chart = categoryChart(rows, settings, ordered)
      if (settings.chart === 'stacked' || settings.chart === 'donut') {
        for (const entry of chart.series) {
          entry.values = entry.values.map((value) => (value !== null && value < 0 ? null : value))
        }
      }
      if (settings.chart === 'stacked' && settings.normalize === true) {
        const totals = chart.categories.map((_, i) =>
          sum(chart.series.map((entry) => entry.values[i] ?? null)),
        )
        for (const entry of chart.series) {
          entry.values = entry.values.map((value, i) => {
            const total = totals[i]
            return value === null || total === null || total === undefined || total === 0
              ? null
              : value / total
          })
        }
      }
      return chart
    }
  }
}

export interface MetricData {
  value: number | null
  comparison: number | null
  /** Change against the comparison value, as a fraction (0.12 = +12 %). */
  trend: number | null
  target: number | null
  /** Progress towards the target, as a fraction. */
  progress: number | null
  tone: 'success' | 'warning' | 'danger' | null
}

export function prepareMetric(rows: readonly Row[], settings: MetricSettings): MetricData {
  const row = rows[0] ?? {}
  const value = toNumber(row[settings.value])
  const comparison =
    settings.comparison === undefined ? null : toNumber(row[settings.comparison.column])
  const target = settings.comparison?.mode === 'target' ? comparison : (settings.target ?? null)
  const trend =
    settings.comparison?.mode === 'trend' &&
    value !== null &&
    comparison !== null &&
    comparison !== 0
      ? (value - comparison) / Math.abs(comparison)
      : null
  const progress = value !== null && target !== null && target !== 0 ? value / target : null
  let tone: MetricData['tone'] = null
  if (value !== null) {
    for (const threshold of [...(settings.thresholds ?? [])].sort((a, b) => a.min - b.min)) {
      if (value >= threshold.min) tone = threshold.tone
    }
  }
  return {
    value,
    comparison: settings.comparison?.mode === 'trend' ? comparison : null,
    trend,
    target,
    progress,
    tone,
  }
}
