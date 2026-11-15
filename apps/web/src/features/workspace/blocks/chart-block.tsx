// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ChartSettings, ComponentResult, RenderComponent } from '@stashley/shared'
import { effectiveColumns, parseSettings, prepareChart } from '@stashley/shared'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import { useT } from '../../../i18n/use-t.ts'
import { chartPalettes } from '../../../ui/chart-palette.ts'
import { Button } from '../../../ui/controls.tsx'
import { useResolvedTheme } from '../../../ui/use-resolved-theme.ts'
import { useDimensionLabel, useValueFormatter } from '../format.ts'
import { chartHeights } from '../grid-layout.ts'
import { BlockFrame, BlockState, FreshnessLine, LimitHint } from './block-frame.tsx'
import { buildOption, type ChartLabels } from './chart-options.ts'
import { DataTable } from './data-table.tsx'
import { useComponentData } from './use-component.ts'

const EChartsView = lazy(() => import('./echarts-view.tsx'))

function useChartLabels(
  result: ComponentResult | undefined,
  settings: ChartSettings | undefined,
): ChartLabels {
  const t = useT()
  const intl = useIntl()
  const formatValue = useValueFormatter()
  const dimensionLabel = useDimensionLabel()
  const kindOf = (name: string) => result?.columns.find((column) => column.name === name)?.kind
  return {
    dimension: (value, axis) => {
      const column = axis === 'x' ? settings?.x : settings?.series
      return dimensionLabel(
        value,
        column === undefined ? undefined : kindOf(column),
        column === undefined ? undefined : settings?.formats?.[column],
      )
    },
    measure: (value, column) =>
      formatValue(value, kindOf(column) ?? 'float', settings?.formats?.[column]),
    column: (column) => settings?.labels?.[column] ?? column,
    percent: (value) =>
      value === null
        ? '–'
        : intl.formatNumber(value, { style: 'percent', maximumFractionDigits: 1 }),
    funnelStage: (share, loss) =>
      loss === null ? t('chart.funnelShare', { share }) : t('chart.funnelStage', { share, loss }),
  }
}

/** A chart with a switchable table view (§ Ergebnisformen und Diagrammtypen). */
export function ChartBlock(props: { component: RenderComponent }) {
  const t = useT()
  const theme = useResolvedTheme()
  const [asTable, setAsTable] = useState(false)
  const { query, refresh } = useComponentData<ComponentResult>(props.component.id)
  const parsed = parseSettings('chart', props.component.settings)
  const settings = parsed.ok ? parsed.value : undefined
  const result = query.data
  const labels = useChartLabels(result, settings)
  const prepared = useMemo(() => {
    if (settings === undefined || result === undefined) return undefined
    const roles = effectiveColumns(result.columns, settings.roles)
    const ordered = roles.find((column) => column.name === settings.x)?.role === 'ordered'
    return prepareChart(result.rows, settings, ordered)
  }, [settings, result])
  const option = useMemo(
    () =>
      prepared === undefined || settings === undefined
        ? undefined
        : buildOption(prepared, settings, chartPalettes[theme], labels),
    // Labels depend on the locale and settings, which the other inputs already cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prepared, settings, theme],
  )

  const footer = (
    <FreshnessLine
      freshness={result}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending}
      refreshError={refresh.error}
    />
  )
  const toggle = (
    <Button variant="ghost" onPress={() => setAsTable((value) => !value)} aria-pressed={asTable}>
      {asTable ? t('chart.showChart') : t('chart.showTable')}
    </Button>
  )
  if (settings === undefined) {
    return (
      <BlockFrame component={props.component}>
        <BlockState kind={props.component.settings === undefined ? 'unconfigured' : 'error'} />
      </BlockFrame>
    )
  }
  if (query.isPending)
    return (
      <BlockFrame component={props.component}>
        <BlockState kind="loading" />
      </BlockFrame>
    )
  if (query.isError || result === undefined)
    return (
      <BlockFrame component={props.component}>
        <BlockState kind="error" />
      </BlockFrame>
    )
  if (result.rows.length === 0) {
    return (
      <BlockFrame component={props.component} footer={footer}>
        <BlockState kind="empty" />
      </BlockFrame>
    )
  }
  const exceeded = prepared !== undefined && prepared.exceeded
  return (
    <BlockFrame component={props.component} tools={toggle} footer={footer}>
      <LimitHint exceeded={exceeded} truncated={result.truncated} />
      {asTable || option === undefined ? (
        <DataTable
          caption={props.component.title}
          columns={result.columns.map((column) => ({
            id: column.name,
            label: settings.labels?.[column.name] ?? column.name,
            kind: column.kind,
            format: settings.formats?.[column.name],
          }))}
          rows={result.rows}
        />
      ) : (
        <Suspense fallback={<BlockState kind="loading" />}>
          <EChartsView
            option={option}
            height={chartHeights[settings.height]}
            label={props.component.title}
          />
        </Suspense>
      )}
    </BlockFrame>
  )
}
