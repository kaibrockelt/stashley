// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentResult, RenderComponent } from '@stashley/shared'
import { parseSettings, prepareMetric } from '@stashley/shared'
import { useIntl } from 'react-intl'
import { useT } from '../../../i18n/use-t.ts'
import { useValueFormatter } from '../format.ts'
import { BlockFrame, BlockState, FreshnessLine } from './block-frame.tsx'
import styles from './blocks.module.css'
import { useComponentData } from './use-component.ts'

/** A value with optional trend, progress and threshold tone (§ Blöcke: Kennzahl). */
export function MetricBlock(props: { component: RenderComponent }) {
  const t = useT()
  const intl = useIntl()
  const formatValue = useValueFormatter()
  const { query, refresh } = useComponentData<ComponentResult>(props.component.id)
  const settings = parseSettings('metric', props.component.settings)
  const footer = (
    <FreshnessLine
      freshness={query.data}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending}
      refreshError={refresh.error}
    />
  )
  if (!settings.ok) {
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
  if (query.isError)
    return (
      <BlockFrame component={props.component}>
        <BlockState kind="error" />
      </BlockFrame>
    )
  const result = query.data
  if (result.rows.length === 0) {
    return (
      <BlockFrame component={props.component} footer={footer}>
        <BlockState kind="empty" />
      </BlockFrame>
    )
  }
  const value = settings.value
  const data = prepareMetric(result.rows, value)
  const kindOf = (name: string) => result.columns.find((column) => column.name === name)?.kind
  const format = value.formats?.[value.value]
  const toneLabel = {
    success: t('metric.tone.success'),
    warning: t('metric.tone.warning'),
    danger: t('metric.tone.danger'),
  }
  return (
    <BlockFrame component={props.component} footer={footer}>
      <div className={styles.metric}>
        <span
          className={[styles.metricValue, data.tone !== null && styles[`tone_${data.tone}`]]
            .filter(Boolean)
            .join(' ')}
        >
          {formatValue(data.value, kindOf(value.value), format)}
        </span>
        <div className={styles.metricMeta}>
          {data.tone !== null && (
            <span className={styles[`tone_${data.tone}`]}>
              <span aria-hidden="true">
                {data.tone === 'success' ? '●' : data.tone === 'warning' ? '▲' : '◆'}{' '}
              </span>
              {toneLabel[data.tone]}
            </span>
          )}
          {data.trend !== null && value.comparison !== undefined && (
            <span>
              <span aria-hidden="true">{data.trend > 0 ? '↑' : data.trend < 0 ? '↓' : '→'} </span>
              {t('metric.trend', {
                change: intl.formatNumber(data.trend, {
                  style: 'percent',
                  maximumFractionDigits: 1,
                  signDisplay: 'exceptZero',
                }),
                comparison: formatValue(
                  data.comparison,
                  kindOf(value.comparison.column),
                  value.formats?.[value.comparison.column] ?? format,
                ),
              })}
            </span>
          )}
          {data.target !== null && (
            <span>
              {t('metric.target', {
                target: formatValue(
                  data.target,
                  value.comparison?.mode === 'target' ? kindOf(value.comparison.column) : undefined,
                  format,
                ),
                progress: intl.formatNumber(data.progress ?? 0, {
                  style: 'percent',
                  maximumFractionDigits: 0,
                }),
              })}
            </span>
          )}
        </div>
        {data.progress !== null && (
          <div
            className={styles.progress}
            role="progressbar"
            aria-label={t('metric.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(1, Math.max(0, data.progress)) * 100)}
          >
            <div
              className={styles.progressBar}
              style={{ width: `${Math.min(100, Math.max(0, data.progress * 100))}%` }}
            />
          </div>
        )}
      </div>
    </BlockFrame>
  )
}
