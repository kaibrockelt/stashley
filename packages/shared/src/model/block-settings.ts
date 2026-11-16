// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import {
  chartTypes,
  columnRoles,
  effectiveColumns,
  isDimension,
  type ShapeColumn,
} from '../values/shape.ts'

/**
 * Display settings of blocks (architecture §13.1, `settings`). The page document stores them
 * as an open record; these schemas define what the editor writes and the renderers read.
 * Settings that do not parse, or that name columns the result no longer has, are an issue
 * (§8.6, §10.8) and render as a neutral error state.
 */

const column = z.string().min(1).max(64)
const label = z.string().max(200)

export const columnFormat = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('integer') }).strict(),
  z.object({ kind: z.literal('decimal'), digits: z.number().int().min(0).max(10) }).strict(),
  z
    .object({
      kind: z.literal('currency'),
      currency: z.string().regex(/^[A-Z]{3}$/),
      digits: z.number().int().min(0).max(4).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('percent'), digits: z.number().int().min(0).max(6) }).strict(),
  /** The value counts seconds or minutes. */
  z.object({ kind: z.literal('duration'), unit: z.enum(['seconds', 'minutes']) }).strict(),
  z.object({ kind: z.literal('date') }).strict(),
  z.object({ kind: z.literal('datetime') }).strict(),
  z.object({ kind: z.literal('relative') }).strict(),
])
export type ColumnFormat = z.infer<typeof columnFormat>
export const formatKinds = columnFormat.options.map((option) => option.shape.kind.value)

const columnDisplay = z
  .object({ column, label: label.optional(), format: columnFormat.optional() })
  .strict()
export type ColumnDisplay = z.infer<typeof columnDisplay>

const shared = {
  /** Role overrides per result column (E5). */
  roles: z.record(column, z.enum(columnRoles)).optional(),
  formats: z.record(column, columnFormat).optional(),
  labels: z.record(column, label).optional(),
}

export const thresholdTones = ['success', 'warning', 'danger'] as const

export const metricSettings = z
  .object({
    ...shared,
    value: column,
    /** A second measure: the trend against it in percent, or the target of a progress bar. */
    comparison: z
      .object({ column, mode: z.enum(['trend', 'target']) })
      .strict()
      .optional(),
    /** A fixed target instead of a target column. */
    target: z.number().finite().optional(),
    /** Ascending lower bounds; the highest bound the value reaches gives its tone. */
    thresholds: z
      .array(z.object({ min: z.number().finite(), tone: z.enum(thresholdTones) }).strict())
      .max(5)
      .optional(),
  })
  .strict()
export type MetricSettings = z.infer<typeof metricSettings>

export const chartHeights = ['S', 'M', 'L'] as const
export const chartSorts = ['value_desc', 'value_asc', 'label', 'query'] as const

export const chartSettings = z
  .object({
    ...shared,
    chart: z.enum(chartTypes),
    height: z.enum(chartHeights),
    /** Dimension on the category or time axis; the first measure on scatter and bubble. */
    x: column,
    /** Long format: the dimension whose values become series. Heatmap: the y axis. */
    series: column.optional(),
    /** Measures; scatter and bubble take y (and size) from here. */
    measures: z.array(column).min(1).max(12),
    /** Scatter and bubble: a category that colors the points. */
    group: column.optional(),
    orientation: z.enum(['vertical', 'horizontal']).optional(),
    /** Stacked bars normalized to 100 %. */
    normalize: z.boolean().optional(),
    /** Time charts: a missing value breaks the line or counts as 0. */
    gaps: z.enum(['break', 'zero']).optional(),
    sort: z.enum(chartSorts).optional(),
  })
  .strict()
export type ChartSettings = z.infer<typeof chartSettings>

export const recordSettings = z
  .object({ ...shared, columns: z.array(columnDisplay).max(100).optional() })
  .strict()
export type RecordSettings = z.infer<typeof recordSettings>

/** A row link opens a page and hands it one column of the row as URL parameter. */
export const rowLink = z
  .object({
    pageId: z.uuid(),
    parameter: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
    column,
  })
  .strict()

export const tableSettings = z
  .object({
    ...shared,
    /** Query sources: shown columns in order; all when absent. */
    columns: z.array(columnDisplay).max(100).optional(),
    rowLink: rowLink.optional(),
    searchable: z.boolean().optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    /** Query sources: CSV export, on unless turned off (table sources use `csvExport`). */
    csvExport: z.boolean().optional(),
  })
  .strict()
export type TableSettings = z.infer<typeof tableSettings>

export const settingsSchemas = {
  metric: metricSettings,
  chart: chartSettings,
  record: recordSettings,
  table: tableSettings,
} as const
export type SettingsBlockType = keyof typeof settingsSchemas
export interface BlockSettingsMap {
  metric: MetricSettings
  chart: ChartSettings
  record: RecordSettings
  table: TableSettings
}

export type SettingsProblem =
  | { code: 'settings_invalid'; path: string }
  | { code: 'mapping_broken'; column: string }
  | { code: 'mapping_unsuitable'; column: string; expected: 'measure' | 'dimension' }

/** Parses a block's settings; `undefined` settings are valid for records and tables. */
export function parseSettings<T extends SettingsBlockType>(
  type: T,
  settings: unknown,
): { ok: true; value: BlockSettingsMap[T] } | { ok: false; path: string } {
  const input = settings ?? (type === 'record' || type === 'table' ? {} : undefined)
  const parsed = settingsSchemas[type].safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data as BlockSettingsMap[T] }
  return { ok: false, path: parsed.error.issues[0]?.path.join('.') ?? '' }
}

/** Columns a block's settings refer to, with the role each needs. */
function mappedColumns(type: SettingsBlockType, value: BlockSettingsMap[SettingsBlockType]) {
  const needs: { column: string; expected?: 'measure' | 'dimension' }[] = []
  if (type === 'metric') {
    const metric = value as MetricSettings
    needs.push({ column: metric.value, expected: 'measure' })
    if (metric.comparison) needs.push({ column: metric.comparison.column, expected: 'measure' })
  } else if (type === 'chart') {
    const chart = value as ChartSettings
    const scatter = chart.chart === 'scatter' || chart.chart === 'bubble'
    needs.push({ column: chart.x, expected: scatter ? 'measure' : 'dimension' })
    if (chart.series) needs.push({ column: chart.series, expected: 'dimension' })
    if (chart.group) needs.push({ column: chart.group, expected: 'dimension' })
    for (const measure of chart.measures) needs.push({ column: measure, expected: 'measure' })
  } else {
    const list = value as RecordSettings | TableSettings
    for (const entry of list.columns ?? []) needs.push({ column: entry.column })
    if (type === 'table') {
      const link = (value as TableSettings).rowLink
      if (link) needs.push({ column: link.column })
    }
  }
  return needs
}

/**
 * Problems of a block's settings against the columns of its query's current result (§10.8).
 * `columns` are the stored result columns of the query version; without them only the
 * settings themselves are checked.
 */
export function settingsProblems(
  type: SettingsBlockType,
  settings: unknown,
  columns: readonly ShapeColumn[] | null,
): SettingsProblem[] {
  const parsed = parseSettings(type, settings)
  if (!parsed.ok) return [{ code: 'settings_invalid', path: parsed.path }]
  if (columns === null) return []
  const roles = new Map(
    effectiveColumns(columns, parsed.value.roles).map((entry) => [entry.name, entry.role]),
  )
  const problems: SettingsProblem[] = []
  for (const need of mappedColumns(type, parsed.value)) {
    const role = roles.get(need.column)
    if (role === undefined) problems.push({ code: 'mapping_broken', column: need.column })
    else if (need.expected === 'measure' && role !== 'measure')
      problems.push({ code: 'mapping_unsuitable', column: need.column, expected: 'measure' })
    else if (need.expected === 'dimension' && !isDimension(role))
      problems.push({ code: 'mapping_unsuitable', column: need.column, expected: 'dimension' })
  }
  return problems
}
