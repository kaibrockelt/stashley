// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ChartData, ChartSettings, DimensionValue } from '@stashley/shared'
import type { EChartsOption } from 'echarts'
import { mix, seriesDashes, seriesSymbols, type ChartPalette } from '../../../ui/chart-palette.ts'

/**
 * ECharts options from prepared chart data (§10.8). No 3D, no second y axis. Series differ in
 * color, marker and dash pattern; tooltips show exact formatted values.
 */
export interface ChartLabels {
  dimension: (value: DimensionValue, axis: 'x' | 'series') => string
  /** Formats a measure value of the given column. */
  measure: (value: number | null, column: string) => string
  column: (column: string) => string
  percent: (value: number | null) => string
  /** "Share {share}, loss {loss}" for funnel stages. */
  funnelStage: (share: string, loss: string | null) => string
}

const color = (palette: ChartPalette, index: number, name?: DimensionValue) =>
  name?.kind === 'other'
    ? palette.other
    : (palette.categorical[index % palette.categorical.length] ?? palette.other)

const symbol = (index: number) => seriesSymbols[index % seriesSymbols.length] ?? 'circle'

function axisStyle(palette: ChartPalette) {
  return {
    axisLabel: { color: palette.textMuted, hideOverlap: true },
    axisLine: { lineStyle: { color: palette.grid } },
    splitLine: { lineStyle: { color: palette.grid } },
    nameTextStyle: { color: palette.textMuted },
  }
}

function base(palette: ChartPalette): EChartsOption {
  return {
    animation: false,
    aria: { enabled: true },
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
  }
}

export function buildOption(
  data: ChartData,
  settings: ChartSettings,
  palette: ChartPalette,
  labels: ChartLabels,
): EChartsOption {
  const option = base(palette)
  // Tooltips render on the canvas: ECharts' HTML tooltips use style attributes, which the
  // CSP blocks, and would insert data values as HTML.
  const tooltip = {
    renderMode: 'richText' as const,
    backgroundColor: palette.surface,
    borderColor: palette.grid,
    textStyle: { color: palette.text },
  }
  const legend = {
    type: 'scroll' as const,
    bottom: 0,
    textStyle: { color: palette.textMuted },
    pageTextStyle: { color: palette.textMuted },
  }

  if (data.kind === 'category') {
    const categories = data.categories.map((value) => labels.dimension(value, 'x'))
    const seriesName = (index: number) => {
      const entry = data.series[index]
      if (entry === undefined) return ''
      return settings.series !== undefined
        ? labels.dimension(entry.name, 'series')
        : labels.column(entry.measure)
    }
    if (settings.chart === 'donut') {
      const entry = data.series[0]
      return {
        ...option,
        tooltip: {
          ...tooltip,
          trigger: 'item',
          valueFormatter: (value) =>
            labels.measure(typeof value === 'number' ? value : null, entry?.measure ?? ''),
        },
        legend: { ...legend, show: true },
        series: [
          {
            type: 'pie',
            radius: ['45%', '70%'],
            center: ['50%', '45%'],
            avoidLabelOverlap: true,
            label: { color: palette.text, formatter: '{b}: {d} %' },
            // A missing value is a gap: its segment is left out.
            data: data.categories.flatMap((category, index) => {
              const value = entry?.values[index] ?? null
              if (value === null) return []
              return [
                {
                  name: categories[index] ?? '',
                  value,
                  itemStyle: {
                    color: color(palette, index, category),
                    borderColor: palette.surface,
                    borderWidth: 2,
                  },
                },
              ]
            }),
          },
        ],
      }
    }
    const horizontal =
      (settings.chart === 'bar' || settings.chart === 'stacked') &&
      settings.orientation === 'horizontal'
    const normalized = settings.chart === 'stacked' && settings.normalize === true
    const categoryAxis = {
      type: 'category' as const,
      data: categories,
      ...axisStyle(palette),
      boundaryGap: settings.chart === 'line' || settings.chart === 'area' ? false : true,
    }
    const valueAxis = {
      type: 'value' as const,
      ...axisStyle(palette),
      ...(normalized && {
        max: 1,
        axisLabel: {
          ...axisStyle(palette).axisLabel,
          formatter: (value: number) => labels.percent(value),
        },
      }),
    }
    const line = settings.chart === 'line' || settings.chart === 'area'
    return {
      ...option,
      grid: { ...option.grid, bottom: data.series.length > 1 ? 40 : 8 },
      tooltip: {
        ...tooltip,
        trigger: 'axis',
        axisPointer: { type: line ? 'line' : 'shadow' },
        valueFormatter: (value) =>
          normalized
            ? labels.percent(typeof value === 'number' ? value : null)
            : labels.measure(
                typeof value === 'number' ? value : null,
                data.series[0]?.measure ?? '',
              ),
      },
      legend: { ...legend, show: data.series.length > 1 },
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
      series: data.series.map((entry, index) => ({
        name: seriesName(index),
        type: line ? 'line' : 'bar',
        data: entry.values,
        itemStyle: { color: color(palette, index, entry.name) },
        ...(settings.chart === 'stacked' && { stack: 'total' }),
        ...(line && {
          symbol: symbol(index),
          symbolSize: 7,
          showSymbol: entry.values.length <= 60,
          connectNulls: false,
          lineStyle: { width: 2, type: seriesDashes[index % seriesDashes.length] ?? 'solid' },
          ...(settings.chart === 'area' && { areaStyle: { opacity: 0.18 } }),
        }),
        // Bars of several series also differ in their decal pattern.
        ...(!line &&
          data.series.length > 1 && {
            itemStyle: {
              color: color(palette, index, entry.name),
              decal: { symbol: symbol(index), symbolSize: 0.4, color: 'rgba(255,255,255,0.35)' },
            },
          }),
      })),
    }
  }

  if (data.kind === 'heatmap') {
    const measure = settings.measures[0] ?? ''
    return {
      ...option,
      grid: { ...option.grid, bottom: 56 },
      tooltip: {
        ...tooltip,
        trigger: 'item',
        formatter: (params) => {
          const item = Array.isArray(params) ? params[0] : params
          const [x, y, value] = (item?.data ?? []) as [number, number, number | null]
          const xLabel = labels.dimension(data.x[x] ?? { kind: 'empty' }, 'x')
          const yLabel = labels.dimension(data.y[y] ?? { kind: 'empty' }, 'series')
          return `${xLabel} · ${yLabel}: ${labels.measure(value, measure)}`
        },
      },
      xAxis: {
        type: 'category',
        data: data.x.map((value) => labels.dimension(value, 'x')),
        ...axisStyle(palette),
        splitArea: { show: true },
      },
      yAxis: {
        type: 'category',
        data: data.y.map((value) => labels.dimension(value, 'series')),
        ...axisStyle(palette),
        splitArea: { show: true },
      },
      visualMap: {
        min: data.min ?? 0,
        max: data.max ?? 1,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemHeight: 120,
        textStyle: { color: palette.textMuted },
        inRange: {
          color: [
            palette.sequential[0],
            mix(palette.sequential[0], palette.sequential[1], 0.5),
            palette.sequential[1],
          ],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: data.cells,
          // Values are printed in small grids, so the scale is not the only carrier.
          label: {
            show: data.x.length * data.y.length <= 300,
            color: palette.text,
            formatter: (params) =>
              labels.measure((params.data as [number, number, number | null])[2], measure),
          },
          itemStyle: { borderColor: palette.surface, borderWidth: 1 },
        },
      ],
    }
  }

  if (data.kind === 'scatter') {
    const [yColumn = '', sizeColumn] = settings.measures
    const groups = data.groups.length > 0 ? data.groups : [null]
    const sizes = data.points.map((point) => point.size ?? 0)
    const maxSize = Math.max(1, ...sizes)
    return {
      ...option,
      grid: { ...option.grid, bottom: groups.length > 1 ? 40 : 8 },
      tooltip: {
        ...tooltip,
        trigger: 'item',
        formatter: (params) => {
          const item = Array.isArray(params) ? params[0] : params
          const [x, y, size] = (item?.data ?? []) as [number, number, number | null]
          const parts = [
            `${labels.column(settings.x)}: ${labels.measure(x, settings.x)}`,
            `${labels.column(yColumn)}: ${labels.measure(y, yColumn)}`,
          ]
          if (sizeColumn !== undefined && settings.chart === 'bubble')
            parts.push(`${labels.column(sizeColumn)}: ${labels.measure(size, sizeColumn)}`)
          return `${item?.seriesName ? `${item.seriesName}\n` : ''}${parts.join('\n')}`
        },
      },
      legend: { ...legend, show: groups.length > 1 },
      xAxis: {
        type: 'value',
        name: labels.column(settings.x),
        nameLocation: 'middle',
        nameGap: 28,
        scale: true,
        ...axisStyle(palette),
      },
      yAxis: { type: 'value', name: labels.column(yColumn), scale: true, ...axisStyle(palette) },
      series: groups.map((group, index) => ({
        type: 'scatter',
        name: group === null ? labels.column(yColumn) : labels.dimension(group, 'series'),
        symbol: symbol(index),
        itemStyle: { color: color(palette, index, group ?? undefined), opacity: 0.85 },
        data: data.points
          .filter((point) =>
            group === null
              ? true
              : point.group !== null && JSON.stringify(point.group) === JSON.stringify(group),
          )
          .map((point) => [point.x, point.y, point.size]),
        symbolSize:
          settings.chart === 'bubble'
            ? (value: [number, number, number | null]) =>
                6 + 34 * Math.sqrt(Math.max(0, value[2] ?? 0) / maxSize)
            : 8,
      })),
    }
  }

  const measure = settings.measures[0] ?? ''
  return {
    ...option,
    tooltip: {
      ...tooltip,
      trigger: 'item',
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params
        const stage = data.stages[item?.dataIndex ?? 0]
        if (stage === undefined) return ''
        return `${labels.dimension(stage.label, 'x')}: ${labels.measure(stage.value, measure)}\n${labels.funnelStage(labels.percent(stage.share), stage.loss === null ? null : labels.percent(stage.loss))}`
      },
    },
    series: [
      {
        type: 'funnel',
        sort: 'none',
        left: '10%',
        width: '80%',
        gap: 2,
        minSize: '8%',
        label: {
          color: palette.text,
          position: 'right',
          formatter: (params) => {
            const stage = data.stages[params.dataIndex]
            return stage === undefined
              ? ''
              : `${labels.dimension(stage.label, 'x')} · ${labels.measure(stage.value, measure)} (${labels.percent(stage.share)})`
          },
        },
        data: data.stages.map((stage, index) => ({
          name: labels.dimension(stage.label, 'x'),
          value: stage.value ?? 0,
          itemStyle: {
            color: color(palette, 0),
            opacity: 1 - (index / Math.max(1, data.stages.length)) * 0.5,
            borderColor: palette.surface,
          },
        })),
      },
    ],
  }
}
