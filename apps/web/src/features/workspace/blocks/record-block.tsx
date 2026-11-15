// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ColumnDisplay, ComponentResult, RenderComponent } from '@stashley/shared'
import { parseSettings } from '@stashley/shared'
import { Fragment, type ReactNode } from 'react'
import { useValueFormatter } from '../format.ts'
import { BlockFrame, BlockState, FreshnessLine } from './block-frame.tsx'
import styles from './blocks.module.css'
import { useComponentData } from './use-component.ts'

/** One row as a key-value list (§ Blöcke: Datensatz). */
export function RecordBlock(props: { component: RenderComponent }) {
  const formatValue = useValueFormatter()
  const { query, refresh } = useComponentData<ComponentResult>(props.component.id)
  const settings = parseSettings('record', props.component.settings)
  const frame = (body: ReactNode, footer = true) => (
    <BlockFrame
      component={props.component}
      footer={
        footer ? (
          <FreshnessLine
            freshness={query.data}
            onRefresh={() => refresh.mutate()}
            refreshing={refresh.isPending}
            refreshError={refresh.error}
          />
        ) : undefined
      }
    >
      {body}
    </BlockFrame>
  )
  if (!settings.ok) return frame(<BlockState kind="error" />, false)
  if (query.isPending) return frame(<BlockState kind="loading" />, false)
  if (query.isError) return frame(<BlockState kind="error" />, false)
  const result = query.data
  const row = result.rows[0]
  if (row === undefined) return frame(<BlockState kind="empty" />)
  const value = settings.value
  const shown: ColumnDisplay[] =
    value.columns ?? result.columns.map((column) => ({ column: column.name }))
  const entries = shown.map((entry) => ({
    ...entry,
    kind: result.columns.find((column) => column.name === entry.column)?.kind,
  }))
  return frame(
    <dl className={styles.record}>
      {entries.map((entry) => (
        <Fragment key={entry.column}>
          <dt>{entry.label ?? value.labels?.[entry.column] ?? entry.column}</dt>
          <dd>
            {formatValue(
              row[entry.column],
              entry.kind,
              entry.format ?? value.formats?.[entry.column],
            )}
          </dd>
        </Fragment>
      ))}
    </dl>,
  )
}
