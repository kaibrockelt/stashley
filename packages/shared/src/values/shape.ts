// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Result shapes (architecture §10.8): column roles decide which visualizations a result allows,
 * and which one is suggested.
 */

/** The server infers all but `ordered`, which is always a manager's override. */
export const columnRoles = ['measure', 'time', 'category', 'ordered', 'identifier'] as const
export type ColumnRole = (typeof columnRoles)[number]

export const chartTypes = [
  'bar',
  'stacked',
  'donut',
  'line',
  'area',
  'column',
  'funnel',
  'heatmap',
  'scatter',
  'bubble',
] as const
export type ChartType = (typeof chartTypes)[number]

export const visualizations = ['metric', 'progress', 'record', ...chartTypes, 'table'] as const
export type Visualization = (typeof visualizations)[number]

/** Limits per chart type (§ Ergebnisformen). */
export const chartLimits = {
  categories: 50,
  segments: 8,
  series: 12,
  pointsPerSeries: 5000,
  heatmapAxis: 50,
  scatterPoints: 10_000,
  funnelStages: 50,
} as const

export interface ShapeColumn {
  name: string
  role: ColumnRole
}

export function isDimension(role: ColumnRole): boolean {
  return role === 'time' || role === 'category' || role === 'ordered'
}

/** Roles after a block's overrides; unknown override keys are ignored. */
export function effectiveColumns(
  columns: readonly ShapeColumn[],
  overrides: Readonly<Record<string, ColumnRole>> | undefined,
): ShapeColumn[] {
  return columns.map((column) => ({
    name: column.name,
    role: overrides?.[column.name] ?? column.role,
  }))
}

export interface ShapeAnalysis {
  allowed: Visualization[]
  suggested: Visualization
}

/**
 * Allowed visualizations for a result. `rowCount` is only known after a run; with `null` the
 * single-row shapes are offered whenever the columns fit them.
 */
export function analyzeShape(
  columns: readonly ShapeColumn[],
  rowCount: number | null,
): ShapeAnalysis {
  const shown = columns.filter((column) => column.role !== 'identifier')
  const measures = shown.filter((column) => column.role === 'measure')
  const dimensions = shown.filter((column) => isDimension(column.role))
  const allowed = new Set<Visualization>()
  let suggested: Visualization | null = null
  const suggest = (type: Visualization) => {
    allowed.add(type)
    suggested ??= type
  }
  const singleRow = rowCount === null || rowCount === 1

  if (singleRow && dimensions.length === 0 && measures.length === 1) suggest('metric')
  if (singleRow && dimensions.length === 0 && measures.length === 2) {
    suggest('metric')
    allowed.add('progress')
  }
  if (rowCount !== null && rowCount !== 1) {
    // More than one row: no single-row shapes.
  } else if (shown.length > 1) {
    if (rowCount === 1) suggest('record')
    else allowed.add('record')
  }

  const [first, second] = dimensions
  if (dimensions.length === 1 && first !== undefined && measures.length >= 1) {
    if (first.role === 'time') {
      suggest('line')
      allowed.add('area').add('column')
    } else {
      if (first.role === 'ordered' && measures.length === 1) suggest('funnel')
      suggest('bar')
      allowed.add('stacked')
      if (measures.length === 1) allowed.add('donut')
    }
  }
  if (
    dimensions.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    measures.length === 1
  ) {
    // Long format: the second dimension holds the series.
    if (first.role === 'time') {
      suggest('line')
      allowed.add('area').add('column')
    } else if (second.role === 'time' || first.role === 'ordered') {
      suggest('heatmap')
      allowed.add('bar').add('stacked')
    } else {
      suggest('bar')
      allowed.add('stacked')
    }
    allowed.add('heatmap')
  }
  if (measures.length >= 2 && dimensions.length <= 1) {
    allowed.add('scatter')
    if (measures.length >= 3) allowed.add('bubble')
    if (rowCount !== 1 && dimensions.length === 0) suggested ??= 'scatter'
  }

  allowed.add('table')
  return {
    allowed: visualizations.filter((type) => allowed.has(type)),
    suggested: suggested ?? 'table',
  }
}
