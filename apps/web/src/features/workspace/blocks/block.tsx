// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderComponent } from '@stashley/shared'
import { useT } from '../../../i18n/use-t.ts'
import { BlockFrame } from './block-frame.tsx'
import { ChartBlock } from './chart-block.tsx'
import { MetricBlock } from './metric-block.tsx'
import { RecordBlock } from './record-block.tsx'
import { TableBlock } from './table-block.tsx'
import { TextBlock } from './text-block.tsx'
import styles from './blocks.module.css'

/** Forms render their fields from M6 on; until then the block names its mode. */
function FormPlaceholder(props: { component: RenderComponent }) {
  const t = useT()
  return (
    <BlockFrame component={props.component}>
      <p className={styles.hint}>{t('block.formLater')}</p>
    </BlockFrame>
  )
}

export function Block(props: { component: RenderComponent }) {
  switch (props.component.type) {
    case 'metric':
      return <MetricBlock component={props.component} />
    case 'chart':
      return <ChartBlock component={props.component} />
    case 'record':
      return <RecordBlock component={props.component} />
    case 'table':
      return <TableBlock component={props.component} />
    case 'text':
      return <TextBlock component={props.component} />
    case 'form':
      return <FormPlaceholder component={props.component} />
  }
}
