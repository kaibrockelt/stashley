// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  BarChart,
  FunnelChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
} from 'echarts/charts'
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { useEffect, useRef } from 'react'
import styles from './blocks.module.css'

// Modular imports keep ECharts in its own lazy chunk (§22).
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  FunnelChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  AriaComponent,
  CanvasRenderer,
])

export default function EChartsView(props: {
  option: EChartsOption
  height: number
  label: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (element.current === null) return
    const instance = echarts.init(element.current, undefined, { renderer: 'canvas' })
    chart.current = instance
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element.current)
    return () => {
      observer.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(props.option, { notMerge: true })
  }, [props.option])

  return (
    <div
      ref={element}
      className={styles.chart}
      style={{ height: props.height }}
      role="img"
      aria-label={props.label}
    />
  )
}
