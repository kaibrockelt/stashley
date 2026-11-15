// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Block,
  ChartSettings,
  ColumnDisplay,
  ColumnFormat,
  ColumnRole,
  MetricSettings,
  PageDocument,
  QueryResult,
  ResultColumn,
  TableOp,
  TableSettings,
} from '@stashley/shared'
import {
  analyzeShape,
  chartTypes,
  effectiveColumns,
  isDimension,
  parseSettings,
  type ChartType,
} from '@stashley/shared'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useErrorText } from '../../i18n/errors.ts'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Button,
  CheckboxField,
  Dialog,
  Form,
  Notice,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../ui/controls.tsx'
import {
  useCatalog,
  useDesignConnections,
  usePages,
  useQueries,
  useQueryDetail,
  useRoles,
} from '../design/design-api.ts'
import { renderMarkdown } from '../workspace/blocks/text-block.tsx'
import { grantOf, setGrant, sourceKeyOf, withDescription } from './document-ops.ts'
import styles from './editor.module.css'

type BlockType = Block['type']
const none = ''
/** Stands in for a source until one is chosen; the dialog cannot be applied with it. */
export const unsetId = '00000000-0000-4000-8000-000000000000'

export const blockTypeLabels: Record<BlockType, MessageId> = {
  metric: 'editor.type.metric',
  chart: 'editor.type.chart',
  record: 'editor.type.record',
  table: 'editor.type.table',
  form: 'editor.type.form',
  text: 'editor.type.text',
}

const chartLabels: Record<ChartType, MessageId> = {
  bar: 'editor.chart.bar',
  stacked: 'editor.chart.stacked',
  donut: 'editor.chart.donut',
  line: 'editor.chart.line',
  area: 'editor.chart.area',
  column: 'editor.chart.column',
  funnel: 'editor.chart.funnel',
  heatmap: 'editor.chart.heatmap',
  scatter: 'editor.chart.scatter',
  bubble: 'editor.chart.bubble',
}

const roleLabels: Record<ColumnRole, MessageId> = {
  measure: 'editor.role.measure',
  time: 'editor.role.time',
  category: 'editor.role.category',
  ordered: 'editor.role.ordered',
  identifier: 'editor.role.identifier',
}

const formatLabels: Record<ColumnFormat['kind'] | 'auto', MessageId> = {
  auto: 'editor.format.auto',
  integer: 'editor.format.integer',
  decimal: 'editor.format.decimal',
  currency: 'editor.format.currency',
  percent: 'editor.format.percent',
  duration: 'editor.format.duration',
  date: 'editor.format.date',
  datetime: 'editor.format.datetime',
  relative: 'editor.format.relative',
}

const opLabels: Record<TableOp, MessageId> = {
  read: 'editor.op.read',
  create: 'editor.op.create',
  update: 'editor.op.update',
  delete: 'editor.op.delete',
}

/** A format from its kind with sensible defaults; `auto` removes it. */
function formatOf(kind: ColumnFormat['kind'] | 'auto', currency = 'EUR'): ColumnFormat | undefined {
  switch (kind) {
    case 'auto':
      return undefined
    case 'decimal':
      return { kind, digits: 2 }
    case 'percent':
      return { kind, digits: 0 }
    case 'currency':
      return { kind, currency }
    case 'duration':
      return { kind, unit: 'minutes' }
    default:
      return { kind }
  }
}

/** Settings that fit a result: the suggested visualization and its column mapping (§10.8). */
export function suggestSettings(
  type: BlockType,
  columns: readonly ResultColumn[],
): Record<string, unknown> | undefined {
  const roles = effectiveColumns(columns, undefined)
  const measures = roles.filter((column) => column.role === 'measure').map((column) => column.name)
  const dimensions = roles.filter((column) => isDimension(column.role)).map((column) => column.name)
  if (type === 'metric') {
    const [value, comparison] = measures
    if (value === undefined) return undefined
    return {
      value,
      ...(comparison !== undefined && { comparison: { column: comparison, mode: 'trend' } }),
    }
  }
  if (type === 'chart') {
    const shape = analyzeShape(roles, null)
    const chart = (chartTypes as readonly string[]).includes(shape.suggested)
      ? (shape.suggested as ChartType)
      : shape.allowed.find((entry): entry is ChartType =>
          (chartTypes as readonly string[]).includes(entry),
        )
    if (chart === undefined) return undefined
    if (chart === 'scatter' || chart === 'bubble') {
      const [x, ...rest] = measures
      if (x === undefined || rest.length === 0) return undefined
      return { chart, height: 'M', x, measures: rest.slice(0, chart === 'bubble' ? 2 : 1) }
    }
    const [x, series] = dimensions
    if (x === undefined || measures.length === 0) return undefined
    return {
      chart,
      height: 'M',
      x,
      ...(dimensions.length === 2 && series !== undefined && { series }),
      measures: dimensions.length === 2 ? measures.slice(0, 1) : measures,
    }
  }
  return {}
}

function useResultColumns(queryId: string) {
  const detail = useQueryDetail(queryId === none || queryId === unsetId ? undefined : queryId)
  const [learned, setLearned] = useState<{ id: string; columns: ResultColumn[] }>()
  const run = useMutation({
    mutationFn: async () => {
      const query = detail.data
      if (query === undefined) throw new Error('no query')
      const result = await api<QueryResult>('POST', '/internal/design/queries/run', {
        connectionId: query.connectionId,
        sql: query.current.sql,
        parameters: query.current.parameters,
        values: {},
      })
      setLearned({ id: query.id, columns: result.columns })
    },
  })
  const columns =
    detail.data?.current.resultColumns ?? (learned?.id === queryId ? learned.columns : null)
  return { detail, columns, run }
}

function ColumnSelect(props: {
  label: string
  value: string
  onChange: (value: string) => void
  columns: { name: string }[]
  optional?: boolean
}) {
  const t = useT()
  return (
    <SelectField
      label={props.label}
      value={props.value}
      onChange={props.onChange}
      options={[
        ...(props.optional === true ? [{ id: none, label: t('editor.none') }] : []),
        ...props.columns.map((column) => ({ id: column.name, label: column.name })),
      ]}
    />
  )
}

function FormatField(props: {
  column: string
  value: ColumnFormat | undefined
  onChange: (value: ColumnFormat | undefined) => void
}) {
  const t = useT()
  const kind = props.value?.kind ?? 'auto'
  return (
    <div className={styles.inline}>
      <SelectField
        label={t('editor.formatOf', { column: props.column })}
        value={kind}
        onChange={(next) => props.onChange(formatOf(next))}
        options={(Object.keys(formatLabels) as (keyof typeof formatLabels)[]).map((id) => ({
          id,
          label: t(formatLabels[id]),
        }))}
      />
      {props.value?.kind === 'currency' && (
        <TextField
          label={t('editor.currency')}
          value={props.value.currency}
          onChange={(currency) =>
            props.onChange({ kind: 'currency', currency: currency.toUpperCase().slice(0, 3) })
          }
        />
      )}
      {(props.value?.kind === 'decimal' || props.value?.kind === 'percent') && (
        <TextField
          label={t('editor.digits')}
          type="number"
          value={String(props.value.digits)}
          onChange={(digits) => {
            const current = props.value
            if (current?.kind === 'decimal' || current?.kind === 'percent') {
              props.onChange({ ...current, digits: Math.max(0, Math.min(6, Number(digits) || 0)) })
            }
          }}
        />
      )}
      {props.value?.kind === 'duration' && (
        <SelectField
          label={t('editor.durationUnit')}
          value={props.value.unit}
          onChange={(unit) => props.onChange({ kind: 'duration', unit })}
          options={[
            { id: 'seconds', label: t('editor.seconds') },
            { id: 'minutes', label: t('editor.minutes') },
          ]}
        />
      )}
    </div>
  )
}

type Settings = Record<string, unknown>

function ChartFields(props: {
  settings: Settings
  onChange: (settings: Settings) => void
  columns: ResultColumn[]
}) {
  const t = useT()
  const parsed = parseSettings('chart', props.settings)
  const value: Partial<ChartSettings> = parsed.ok ? parsed.value : props.settings
  const roles = effectiveColumns(props.columns, value.roles)
  const allowed = analyzeShape(roles, null).allowed.filter((entry): entry is ChartType =>
    (chartTypes as readonly string[]).includes(entry),
  )
  const chart = value.chart ?? allowed[0] ?? 'bar'
  const scatter = chart === 'scatter' || chart === 'bubble'
  const measures = roles.filter((column) => column.role === 'measure')
  const dimensions = roles.filter((column) => isDimension(column.role))
  const set = (patch: Partial<ChartSettings>) =>
    props.onChange({ height: 'M', ...props.settings, chart, ...patch })
  return (
    <>
      <SelectField
        label={t('editor.chartType')}
        value={chart}
        onChange={(next) => set({ chart: next })}
        options={(allowed.includes(chart) ? allowed : [chart, ...allowed]).map((id) => ({
          id,
          label: t(chartLabels[id]),
        }))}
      />
      <SelectField
        label={t('editor.height')}
        value={value.height ?? 'M'}
        onChange={(height) => set({ height })}
        options={[
          { id: 'S', label: t('editor.height.S') },
          { id: 'M', label: t('editor.height.M') },
          { id: 'L', label: t('editor.height.L') },
        ]}
      />
      <ColumnSelect
        label={scatter ? t('editor.xMeasure') : t('editor.xAxis')}
        value={value.x ?? none}
        onChange={(x) => set({ x })}
        columns={scatter ? measures : dimensions}
      />
      {!scatter && chart !== 'donut' && chart !== 'funnel' && (
        <ColumnSelect
          label={chart === 'heatmap' ? t('editor.yAxis') : t('editor.seriesColumn')}
          value={value.series ?? none}
          onChange={(series) => set({ series: series === none ? undefined : series })}
          columns={dimensions.filter((column) => column.name !== value.x)}
          optional={chart !== 'heatmap'}
        />
      )}
      <fieldset className={styles.fieldset}>
        <legend>{scatter ? t('editor.yAndSize') : t('editor.measures')}</legend>
        {measures
          .filter((column) => !scatter || column.name !== value.x)
          .map((column) => (
            <CheckboxField
              key={column.name}
              label={column.name}
              isSelected={value.measures?.includes(column.name) === true}
              onChange={(selected) =>
                set({
                  measures: selected
                    ? [...(value.measures ?? []), column.name]
                    : (value.measures ?? []).filter((name) => name !== column.name),
                })
              }
            />
          ))}
      </fieldset>
      {scatter && (
        <ColumnSelect
          label={t('editor.group')}
          value={value.group ?? none}
          onChange={(group) => set({ group: group === none ? undefined : group })}
          columns={dimensions}
          optional
        />
      )}
      {(chart === 'bar' || chart === 'stacked') && (
        <SelectField
          label={t('editor.orientation')}
          value={value.orientation ?? 'vertical'}
          onChange={(orientation) => set({ orientation })}
          options={[
            { id: 'vertical', label: t('editor.orientation.vertical') },
            { id: 'horizontal', label: t('editor.orientation.horizontal') },
          ]}
        />
      )}
      {chart === 'stacked' && (
        <SwitchField
          label={t('editor.normalize')}
          isSelected={value.normalize === true}
          onChange={(normalize) => set({ normalize })}
        />
      )}
      {(chart === 'line' || chart === 'area' || chart === 'column') && (
        <SelectField
          label={t('editor.gaps')}
          value={value.gaps ?? 'break'}
          onChange={(gaps) => set({ gaps })}
          options={[
            { id: 'break', label: t('editor.gaps.break') },
            { id: 'zero', label: t('editor.gaps.zero') },
          ]}
        />
      )}
      {(chart === 'bar' || chart === 'stacked') && (
        <SelectField
          label={t('editor.sort')}
          value={value.sort ?? 'value_desc'}
          onChange={(sort) => set({ sort })}
          options={[
            { id: 'value_desc', label: t('editor.sort.value_desc') },
            { id: 'value_asc', label: t('editor.sort.value_asc') },
            { id: 'label', label: t('editor.sort.label') },
            { id: 'query', label: t('editor.sort.query') },
          ]}
        />
      )}
    </>
  )
}

function MetricFields(props: {
  settings: Settings
  onChange: (settings: Settings) => void
  columns: ResultColumn[]
}) {
  const t = useT()
  const value = props.settings as Partial<MetricSettings>
  const measures = effectiveColumns(props.columns, value.roles).filter(
    (column) => column.role === 'measure',
  )
  const set = (patch: Partial<MetricSettings>) => props.onChange({ ...props.settings, ...patch })
  const thresholds = value.thresholds ?? []
  return (
    <>
      <ColumnSelect
        label={t('editor.valueColumn')}
        value={value.value ?? none}
        onChange={(column) => set({ value: column })}
        columns={measures}
      />
      <ColumnSelect
        label={t('editor.comparison')}
        value={value.comparison?.column ?? none}
        onChange={(column) =>
          set({
            comparison:
              column === none ? undefined : { column, mode: value.comparison?.mode ?? 'trend' },
          })
        }
        columns={measures.filter((column) => column.name !== value.value)}
        optional
      />
      {value.comparison !== undefined && (
        <SelectField
          label={t('editor.comparisonMode')}
          value={value.comparison.mode}
          onChange={(mode) => set({ comparison: { column: value.comparison?.column ?? '', mode } })}
          options={[
            { id: 'trend', label: t('editor.comparison.trend') },
            { id: 'target', label: t('editor.comparison.target') },
          ]}
        />
      )}
      {value.comparison?.mode !== 'target' && (
        <TextField
          label={t('editor.fixedTarget')}
          type="number"
          value={value.target === undefined ? '' : String(value.target)}
          onChange={(text) =>
            set({
              target: text === '' || !Number.isFinite(Number(text)) ? undefined : Number(text),
            })
          }
        />
      )}
      <fieldset className={styles.fieldset}>
        <legend>{t('editor.thresholds')}</legend>
        <p className={styles.muted}>{t('editor.thresholdsHint')}</p>
        {thresholds.map((threshold, index) => (
          <div key={index} className={styles.inline}>
            <TextField
              label={t('editor.thresholdFrom')}
              type="number"
              value={String(threshold.min)}
              onChange={(text) =>
                set({
                  thresholds: thresholds.map((entry, i) =>
                    i === index ? { ...entry, min: Number(text) || 0 } : entry,
                  ),
                })
              }
            />
            <SelectField
              label={t('editor.tone')}
              value={threshold.tone}
              onChange={(tone) =>
                set({
                  thresholds: thresholds.map((entry, i) =>
                    i === index ? { ...entry, tone } : entry,
                  ),
                })
              }
              options={[
                { id: 'success', label: t('metric.tone.success') },
                { id: 'warning', label: t('metric.tone.warning') },
                { id: 'danger', label: t('metric.tone.danger') },
              ]}
            />
            <Button
              variant="ghost"
              onPress={() => set({ thresholds: thresholds.filter((_, i) => i !== index) })}
            >
              {t('action.delete')}
            </Button>
          </div>
        ))}
        {thresholds.length < 5 && (
          <Button
            variant="ghost"
            onPress={() => set({ thresholds: [...thresholds, { min: 0, tone: 'success' }] })}
          >
            {t('editor.addThreshold')}
          </Button>
        )}
      </fieldset>
    </>
  )
}

function ColumnsFields(props: {
  settings: Settings
  onChange: (settings: Settings) => void
  columns: ResultColumn[]
  table: boolean
}) {
  const t = useT()
  const pages = usePages()
  const value = props.settings as Partial<TableSettings>
  const shown: ColumnDisplay[] =
    value.columns ?? props.columns.map((column) => ({ column: column.name }))
  const set = (patch: Partial<TableSettings>) => props.onChange({ ...props.settings, ...patch })
  return (
    <>
      <fieldset className={styles.fieldset}>
        <legend>{t('editor.columns')}</legend>
        {props.columns.map((column) => {
          const entry = shown.find((item) => item.column === column.name)
          return (
            <div key={column.name} className={styles.inline}>
              <CheckboxField
                label={column.name}
                isSelected={entry !== undefined}
                onChange={(selected) =>
                  set({
                    columns: selected
                      ? props.columns
                          .filter(
                            (candidate) =>
                              candidate.name === column.name ||
                              shown.some((item) => item.column === candidate.name),
                          )
                          .map(
                            (candidate) =>
                              shown.find((item) => item.column === candidate.name) ?? {
                                column: candidate.name,
                              },
                          )
                      : shown.filter((item) => item.column !== column.name),
                  })
                }
              />
              {entry !== undefined && (
                <TextField
                  label={t('editor.labelOf', { column: column.name })}
                  value={entry.label ?? ''}
                  onChange={(label) =>
                    set({
                      columns: shown.map((item) =>
                        item.column === column.name
                          ? {
                              column: item.column,
                              ...(item.format !== undefined && { format: item.format }),
                              ...(label !== '' && { label }),
                            }
                          : item,
                      ),
                    })
                  }
                />
              )}
            </div>
          )
        })}
      </fieldset>
      {props.table && (
        <>
          <SwitchField
            label={t('editor.searchable')}
            isSelected={value.searchable === true}
            onChange={(searchable) => set({ searchable })}
          />
          <TextField
            label={t('editor.pageSize')}
            type="number"
            value={String(value.pageSize ?? 50)}
            onChange={(text) => set({ pageSize: Math.max(1, Math.min(500, Number(text) || 50)) })}
          />
          <SelectField
            label={t('editor.rowLink')}
            value={value.rowLink?.pageId ?? none}
            onChange={(pageId) =>
              set({
                rowLink:
                  pageId === none
                    ? undefined
                    : {
                        pageId,
                        parameter: value.rowLink?.parameter ?? 'id',
                        column: value.rowLink?.column ?? props.columns[0]?.name ?? '',
                      },
              })
            }
            options={[
              { id: none, label: t('editor.none') },
              ...(pages.data ?? []).map((page) => ({ id: page.id, label: page.title })),
            ]}
          />
          {value.rowLink !== undefined && (
            <div className={styles.inline}>
              <ColumnSelect
                label={t('editor.rowLinkColumn')}
                value={value.rowLink.column}
                onChange={(column) =>
                  set({
                    rowLink: {
                      ...(value.rowLink as NonNullable<TableSettings['rowLink']>),
                      column,
                    },
                  })
                }
                columns={props.columns}
              />
              <TextField
                label={t('editor.rowLinkParameter')}
                value={value.rowLink.parameter}
                onChange={(parameter) =>
                  set({
                    rowLink: {
                      ...(value.rowLink as NonNullable<TableSettings['rowLink']>),
                      parameter,
                    },
                  })
                }
              />
            </div>
          )}
        </>
      )}
    </>
  )
}

function RolesAndFormats(props: {
  settings: Settings
  onChange: (settings: Settings) => void
  columns: ResultColumn[]
  formats: boolean
}) {
  const t = useT()
  const roles = (props.settings.roles ?? {}) as Record<string, ColumnRole>
  const formats = (props.settings.formats ?? {}) as Record<string, ColumnFormat>
  return (
    <details className={styles.details}>
      <summary>{t('editor.columnDetails')}</summary>
      {props.columns.map((column) => (
        <div key={column.name} className={styles.inline}>
          <SelectField
            label={t('editor.roleOf', { column: column.name })}
            value={roles[column.name] ?? column.role}
            onChange={(role) => {
              const next = { ...roles }
              if (role === column.role) delete next[column.name]
              else next[column.name] = role
              props.onChange({
                ...props.settings,
                roles: Object.keys(next).length === 0 ? undefined : next,
              })
            }}
            options={(Object.keys(roleLabels) as ColumnRole[]).map((id) => ({
              id,
              label: t(roleLabels[id]),
            }))}
          />
          {props.formats && (
            <FormatField
              column={column.name}
              value={formats[column.name]}
              onChange={(format) => {
                const next = { ...formats }
                if (format === undefined) delete next[column.name]
                else next[column.name] = format
                props.onChange({
                  ...props.settings,
                  formats: Object.keys(next).length === 0 ? undefined : next,
                })
              }}
            />
          )}
        </div>
      ))}
    </details>
  )
}

/** Rights of the page's viewers on this block's source, and restrictions of this block (§8.2). */
function RightsFields(props: {
  document: PageDocument
  onDocument: (document: PageDocument) => void
  block: Block
  onBlock: (block: Block) => void
}) {
  const t = useT()
  const roles = useRoles()
  const source = sourceKeyOf(props.block)
  const name = (principal: string) =>
    principal === 'authenticated'
      ? t('editor.everyone')
      : (roles.data?.find((role) => role.id === principal)?.name ?? principal)
  const viewers = props.document.access.view
  if (viewers.length === 0) return <Notice tone="info">{t('editor.noViewers')}</Notice>
  if (source === undefined) return <p className={styles.muted}>{t('editor.textRights')}</p>
  const ops: TableOp[] =
    props.block.type !== 'text' && props.block.source.kind === 'table'
      ? ['read', 'create', 'update', 'delete']
      : ['read']
  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('editor.rights')}</legend>
      <p className={styles.muted}>{t('editor.rightsHint')}</p>
      {viewers.map((principal) => {
        const granted = grantOf(props.document, principal, source)
        const restricted = props.block.restrictions.some((entry) => entry.principal === principal)
        return (
          <div key={principal} className={styles.rightsRow}>
            <strong>{name(principal)}</strong>
            {ops.map((op) => (
              <CheckboxField
                key={op}
                label={t(opLabels[op])}
                isSelected={granted.includes(op)}
                onChange={(selected) =>
                  props.onDocument(
                    setGrant(
                      props.document,
                      principal,
                      source,
                      selected ? [...granted, op] : granted.filter((entry) => entry !== op),
                    ),
                  )
                }
              />
            ))}
            <CheckboxField
              label={t('editor.hideHere')}
              isSelected={restricted}
              onChange={(selected) =>
                props.onBlock({
                  ...props.block,
                  restrictions: selected
                    ? [...props.block.restrictions, { principal: principal, ops: [] }]
                    : props.block.restrictions.filter((entry) => entry.principal !== principal),
                })
              }
            />
          </div>
        )
      })}
    </fieldset>
  )
}

/** Binds query parameters to page filters or URL parameters (§13.6). */
function BindingsFields(props: {
  block: Block & {
    bindings: {
      parameter: string
      from: { kind: 'filter'; filterId: string } | { kind: 'url'; name: string }
    }[]
  }
  document: PageDocument
  parameters: string[]
  onBlock: (block: Block) => void
}) {
  const t = useT()
  if (props.parameters.length === 0) return null
  const options = [
    { id: none, label: t('editor.binding.none') },
    ...props.document.filters.map((filter) => ({
      id: `filter:${filter.id}`,
      label: t('editor.binding.filter', { name: filter.label }),
    })),
    ...props.document.parameters.map((parameter) => ({
      id: `url:${parameter.name}`,
      label: t('editor.binding.url', { name: parameter.name }),
    })),
  ]
  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('editor.bindings')}</legend>
      {props.parameters.map((parameter) => {
        const binding = props.block.bindings.find((entry) => entry.parameter === parameter)
        const current =
          binding === undefined
            ? none
            : binding.from.kind === 'filter'
              ? `filter:${binding.from.filterId}`
              : `url:${binding.from.name}`
        return (
          <SelectField
            key={parameter}
            label={`:${parameter}`}
            value={current}
            onChange={(next) => {
              const others = props.block.bindings.filter((entry) => entry.parameter !== parameter)
              const [kind, id = ''] = next.split(/:(.*)/s)
              const from =
                kind === 'filter'
                  ? { kind: 'filter' as const, filterId: id }
                  : { kind: 'url' as const, name: id }
              props.onBlock({
                ...props.block,
                bindings: next === none ? others : [...others, { parameter, from }],
              } as Block)
            }}
            options={options}
          />
        )
      })}
    </fieldset>
  )
}

function TableSourceFields(props: { block: Block; onBlock: (block: Block) => void }) {
  const t = useT()
  const connections = useDesignConnections()
  const block = props.block
  const [connectionId, setConnectionId] = useState<string>(connections.data?.[0]?.id ?? none)
  const effectiveConnection =
    connectionId === none ? (connections.data?.[0]?.id ?? none) : connectionId
  const catalog = useCatalog(effectiveConnection === none ? undefined : effectiveConnection)
  if (block.type !== 'table' && block.type !== 'form') return null
  const tableAccessId = block.source.kind === 'table' ? block.source.tableAccessId : none
  const object = catalog.data?.objects.find((entry) => entry.tableAccessId === tableAccessId)
  const choose = (id: string) => {
    const chosen = catalog.data?.objects.find((entry) => entry.tableAccessId === id)
    if (chosen === undefined) return
    const source = {
      kind: 'table' as const,
      tableAccessId: id,
      cacheTtlSeconds: block.source.kind === 'table' ? block.source.cacheTtlSeconds : 60,
    }
    if (block.type === 'form') {
      props.onBlock({ ...block, source })
      return
    }
    props.onBlock({
      ...block,
      source,
      table: {
        columns: chosen.columns.slice(0, 12).map((column, index) => ({
          kind: 'column',
          id: `c${index + 1}`,
          column: { path: [], column: column.name },
          label: column.name,
        })),
        sort: null,
        searchColumns: [],
        baseFilter: [],
        bindings: [],
        pageSize: 50,
      },
    })
  }
  return (
    <>
      {(connections.data?.length ?? 0) > 1 && (
        <SelectField
          label={t('editor.connection')}
          value={effectiveConnection}
          onChange={setConnectionId}
          options={(connections.data ?? []).map((entry) => ({ id: entry.id, label: entry.name }))}
        />
      )}
      <SelectField
        label={t('editor.tableSource')}
        value={tableAccessId}
        onChange={choose}
        options={[
          { id: none, label: t('editor.choose') },
          ...(catalog.data?.objects ?? []).map((entry) => ({
            id: entry.tableAccessId,
            label: entry.name,
          })),
        ]}
      />
      {block.type === 'table' && block.table !== null && object !== undefined && (
        <fieldset className={styles.fieldset}>
          <legend>{t('editor.columns')}</legend>
          {object.columns.map((column) => {
            const entry = block.table?.columns.find(
              (item) =>
                item.kind === 'column' &&
                item.column.path.length === 0 &&
                item.column.column === column.name,
            )
            const table = block.table
            if (table === null) return null
            return (
              <CheckboxField
                key={column.name}
                label={column.name}
                isSelected={entry !== undefined}
                onChange={(selected) => {
                  const used = new Set(table.columns.map((item) => item.id))
                  let n = table.columns.length + 1
                  while (used.has(`c${n}`)) n += 1
                  const columns = selected
                    ? [
                        ...table.columns,
                        {
                          kind: 'column' as const,
                          id: `c${n}`,
                          column: { path: [], column: column.name },
                          label: column.name,
                        },
                      ]
                    : table.columns.filter((item) => item !== entry)
                  if (columns.length > 0)
                    props.onBlock({
                      ...block,
                      table: {
                        ...table,
                        columns,
                        sort:
                          table.sort !== null &&
                          columns.some((item) => item.id === table.sort?.columnId)
                            ? table.sort
                            : null,
                      },
                    })
                }}
              />
            )
          })}
          <p className={styles.muted}>{t('editor.tableLater')}</p>
        </fieldset>
      )}
      {block.type === 'form' && (
        <SelectField
          label={t('editor.formMode')}
          value={block.mode}
          onChange={(mode) => props.onBlock({ ...block, mode })}
          options={[
            { id: 'create', label: t('editor.formMode.create') },
            { id: 'edit', label: t('editor.formMode.edit') },
            { id: 'upsert', label: t('editor.formMode.upsert') },
          ]}
        />
      )}
    </>
  )
}

/** Creates or edits one block of the page (§ Blöcke). Changes stay local until the draft is saved. */
export function BlockDialog(props: {
  document: PageDocument
  block: Block
  isNew: boolean
  onSave: (block: Block, document: PageDocument) => void
  onClose: () => void
}) {
  const t = useT()
  const errors = useErrorText()
  const queries = useQueries()
  const [block, setBlock] = useState<Block>(props.block)
  const [document, setDocument] = useState<PageDocument>(props.document)
  const queryId =
    block.type !== 'text' && block.source.kind === 'query' ? block.source.queryId : none
  const { detail, columns, run } = useResultColumns(queryId)
  const settings = ('settings' in block ? block.settings : undefined) ?? {}
  const setSettings = (next: Settings) => setBlock({ ...block, settings: next } as Block)
  const queryBlock =
    block.type === 'metric' ||
    block.type === 'chart' ||
    block.type === 'record' ||
    (block.type === 'table' && block.source.kind === 'query')
  const parameters = (detail.data?.current.analysis.parameters ?? []).filter(
    (name) =>
      !(detail.data?.current.analysis.variables ?? []).includes(name) &&
      !name.startsWith('current_user_'),
  )

  const changeType = (type: BlockType) => {
    const base = {
      id: block.id,
      title: block.title,
      restrictions: block.restrictions,
      ...(block.description !== undefined && { description: block.description }),
    }
    const source = block.type !== 'text' && block.source.kind === 'query' ? block.source : undefined
    if (type === 'text') setBlock({ ...base, type, markdown: '' })
    else if (type === 'form')
      setBlock({
        ...base,
        type,
        mode: 'create',
        source: { kind: 'table', tableAccessId: unsetId, cacheTtlSeconds: 0 },
      })
    else if (type === 'table')
      setBlock({
        ...base,
        type,
        source: source ?? { kind: 'query', queryId: unsetId },
        bindings: [],
        table: null,
      })
    else
      setBlock({
        ...base,
        type,
        source: source ?? { kind: 'query', queryId: unsetId },
        bindings: [],
      })
  }
  const chooseQuery = (id: string) => {
    if (block.type === 'text' || block.type === 'form') return
    setBlock({
      ...block,
      source: { kind: 'query', queryId: id },
      bindings: [],
      table: block.type === 'table' ? null : undefined,
      settings: undefined,
    } as Block)
  }
  const suggestion =
    queryBlock && columns !== null ? suggestSettings(block.type, columns) : undefined
  const unset =
    block.type !== 'text' &&
    block.type !== 'form' &&
    block.source.kind === 'query' &&
    block.source.queryId === unsetId
  const unsetTable =
    (block.type === 'form' || block.type === 'table') &&
    block.source.kind === 'table' &&
    block.source.tableAccessId === unsetId

  return (
    <Dialog
      title={
        props.isNew
          ? t('editor.newBlock')
          : t('editor.editBlock', { title: block.title || block.id })
      }
      isOpen
      isWide
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => props.onSave(block, document)}>
        <div className={styles.dialogGrid}>
          <div className={styles.dialogColumn}>
            <SelectField
              label={t('editor.blockType')}
              value={block.type}
              onChange={changeType}
              options={(Object.keys(blockTypeLabels) as BlockType[]).map((id) => ({
                id,
                label: t(blockTypeLabels[id]),
              }))}
            />
            <TextField
              label={t('field.title')}
              value={block.title}
              onChange={(title) => setBlock({ ...block, title })}
            />
            <TextField
              label={t('field.description')}
              value={block.description ?? ''}
              onChange={(description) => {
                setBlock(withDescription(block, description))
              }}
            />
            {block.type === 'text' && (
              <>
                <TextAreaField
                  label={t('editor.markdown')}
                  value={block.markdown}
                  onChange={(markdown) => setBlock({ ...block, markdown })}
                  rows={8}
                  description={t('editor.markdownHint')}
                  isMono
                />
                <div
                  className={styles.preview}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(block.markdown) }}
                />
              </>
            )}
            {block.type === 'table' && (
              <SelectField
                label={t('editor.sourceKind')}
                value={block.source.kind}
                onChange={(kind) =>
                  setBlock(
                    kind === 'query'
                      ? {
                          ...block,
                          source: { kind: 'query', queryId: unsetId },
                          table: null,
                          settings: undefined,
                        }
                      : {
                          ...block,
                          source: { kind: 'table', tableAccessId: unsetId, cacheTtlSeconds: 60 },
                          table: null,
                          settings: undefined,
                        },
                  )
                }
                options={[
                  { id: 'query', label: t('editor.sourceKind.query') },
                  { id: 'table', label: t('editor.sourceKind.table') },
                ]}
              />
            )}
            {queryBlock && (
              <SelectField
                label={t('editor.query')}
                value={unset ? none : queryId}
                onChange={chooseQuery}
                options={[
                  { id: none, label: t('editor.choose') },
                  ...(queries.data ?? []).map((query) => ({ id: query.id, label: query.name })),
                ]}
              />
            )}
            {(block.type === 'form' ||
              (block.type === 'table' && block.source.kind === 'table')) && (
              <TableSourceFields block={block} onBlock={setBlock} />
            )}
            {unsetTable && <p className={styles.muted}>{t('editor.chooseTable')}</p>}
            {queryBlock && !unset && 'bindings' in block && (
              <BindingsFields
                block={block}
                document={document}
                parameters={parameters}
                onBlock={setBlock}
              />
            )}
          </div>
          <div className={styles.dialogColumn}>
            {queryBlock && !unset && columns === null && (
              <Notice tone="info">
                {t('editor.columnsUnknown')}{' '}
                <Button onPress={() => run.mutate()} isDisabled={run.isPending}>
                  {t('editor.learnColumns')}
                </Button>
                {errors.message(run.error) !== undefined && (
                  <span> {errors.message(run.error)}</span>
                )}
              </Notice>
            )}
            {queryBlock && columns !== null && (
              <>
                {suggestion !== undefined && block.type !== 'table' && block.type !== 'record' && (
                  <Button onPress={() => setSettings({ ...suggestion })}>
                    {t('editor.applySuggestion')}
                  </Button>
                )}
                {block.type === 'chart' && (
                  <ChartFields settings={settings} onChange={setSettings} columns={columns} />
                )}
                {block.type === 'metric' && (
                  <MetricFields settings={settings} onChange={setSettings} columns={columns} />
                )}
                {(block.type === 'record' || block.type === 'table') && (
                  <ColumnsFields
                    settings={settings}
                    onChange={setSettings}
                    columns={columns}
                    table={block.type === 'table'}
                  />
                )}
                <RolesAndFormats
                  settings={settings}
                  onChange={setSettings}
                  columns={columns}
                  formats
                />
              </>
            )}
            <RightsFields
              document={document}
              onDocument={setDocument}
              block={block}
              onBlock={setBlock}
            />
          </div>
        </div>
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={unset || unsetTable}>
            {t('editor.applyBlock')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}
