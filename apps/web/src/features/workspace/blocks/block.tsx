// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderComponent } from '@stashley/shared'
import { ChartBlock } from './chart-block.tsx'
import { MetricBlock } from './metric-block.tsx'
import { RecordBlock } from './record-block.tsx'
import { TableBlock } from './table-block.tsx'
import { TextBlock } from './text-block.tsx'
import { FormBlock } from '../form/form-block.tsx'

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
      return <FormBlock component={props.component} />
  }
}
