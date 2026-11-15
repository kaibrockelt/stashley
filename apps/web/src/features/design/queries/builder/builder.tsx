// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { BuilderOperator, DesignCatalog, FieldError } from '@stashley/shared'
import { useState, type ReactNode } from 'react'
import type { MessageId } from '../../../../i18n/locale.ts'
import { useT } from '../../../../i18n/use-t.ts'
import { Button, Notice, SelectField, SwitchField, TextField } from '../../../../ui/controls.tsx'
import { SortableList } from '../../../../ui/sortable.tsx'
import styles from './builder.module.css'
import {
  addColumn,
  addJoin,
  columnKind,
  constantFor,
  constantTexts,
  errorTarget,
  functionOf,
  functionsFor,
  groupingOf,
  isValidOutputName,
  joinOptions,
  maxColumns,
  maxFilters,
  maxJoins,
  maxSort,
  newFilter,
  objectOf,
  operatorsFor,
  removeColumn,
  removeJoin,
  sanitize,
  sourcesOf,
  specFor,
  updateColumn,
  withOperator,
  type BuilderSpec,
  type ColumnFunction,
  type JoinOption,
  type SpecFilter,
} from './spec-ops.ts'

const functionLabels: Record<ColumnFunction, MessageId> = {
  value: 'builder.fn.value',
  count: 'builder.fn.count',
  count_distinct: 'builder.fn.count_distinct',
  sum: 'builder.fn.sum',
  avg: 'builder.fn.avg',
  min: 'builder.fn.min',
  max: 'builder.fn.max',
  quarter_hour: 'builder.fn.quarter_hour',
  hour: 'builder.fn.hour',
  day: 'builder.fn.day',
  week: 'builder.fn.week',
  month: 'builder.fn.month',
  year: 'builder.fn.year',
}

const operatorLabels: Record<BuilderOperator, MessageId> = {
  eq: 'builder.op.eq',
  ne: 'builder.op.ne',
  lt: 'builder.op.lt',
  lte: 'builder.op.lte',
  gt: 'builder.op.gt',
  gte: 'builder.op.gte',
  in: 'builder.op.in',
  not_in: 'builder.op.not_in',
  like: 'builder.op.like',
  between: 'builder.op.between',
  null: 'builder.op.null',
  not_null: 'builder.op.not_null',
}

/** Texts for the compiler's field errors (§10.3); others fall back to a generic text. */
const errorTexts: Record<string, MessageId> = {
  unknown_object: 'builder.error.unknown_object',
  unknown_alias: 'builder.error.unknown_alias',
  unknown_relation: 'builder.error.unknown_relation',
  unknown_column: 'builder.error.unknown_column',
  duplicate: 'builder.error.duplicate',
  aggregate_and_bucket: 'builder.error.aggregate_and_bucket',
  required: 'builder.error.required',
  not_a_time: 'builder.error.not_a_time',
  not_numeric: 'builder.error.not_numeric',
  not_allowed: 'builder.error.not_allowed',
  invalid: 'builder.error.invalid',
}

const countAll = '*'
const constantMode = 'constant'
const parameterMode = 'parameter'

function useErrorsAt(errors: readonly FieldError[]) {
  const t = useT()
  return (
    section: 'base' | 'joins' | 'columns' | 'filters' | 'sort',
    index: number | null,
  ): string | undefined => {
    const found = errors.filter((error) => {
      const target = errorTarget(error.field)
      return target.section === section && (index === null || target.index === index)
    })
    if (found.length === 0) return undefined
    return found
      .map((error) => t(errorTexts[error.code] ?? 'builder.error.other', { code: error.code }))
      .join(' ')
  }
}

function SectionBox(props: {
  title: string
  hint?: string
  children: ReactNode
  error?: string | undefined
}) {
  return (
    <fieldset className={styles.section}>
      <legend className={styles.legend}>{props.title}</legend>
      {props.hint !== undefined && <p className={styles.hint}>{props.hint}</p>}
      {props.error !== undefined && <p className={styles.error}>{props.error}</p>}
      {props.children}
    </fieldset>
  )
}

/** The joins: each follows a known relation from the base or an earlier join. */
function JoinsSection(props: {
  catalog: DesignCatalog
  spec: BuilderSpec
  onChange: (spec: BuilderSpec) => void
  errorAt: ReturnType<typeof useErrorsAt>
}) {
  const t = useT()
  const { spec, catalog } = props
  const sources = sourcesOf(spec, catalog)
  const [from, setFrom] = useState('base')
  const effectiveFrom = sources.some((source) => source.alias === from) ? from : 'base'
  const options = joinOptions(spec, catalog, effectiveFrom)
  const [choice, setChoice] = useState('')
  const key = (option: JoinOption) => `${option.column}>${option.target}.${option.targetColumn}`
  const chosen = options.find((option) => key(option) === choice) ?? options[0]
  const sourceName = (alias: string) => {
    const object = objectOf(spec, catalog, alias)?.name ?? alias
    return alias === 'base' || alias === object ? object : `${object} (${alias})`
  }
  return (
    <SectionBox title={t('builder.joins')} hint={t('builder.joinsHint')}>
      {spec.joins.length > 0 && (
        <ul className={styles.list}>
          {spec.joins.map((join, index) => (
            <li key={join.alias} className={styles.row}>
              <span className={styles.grow}>
                {t('builder.joinLabel', {
                  target: sourceName(join.alias),
                  from: sourceName(join.from),
                  column: join.column,
                  targetColumn: join.targetColumn,
                })}
              </span>
              <SelectField
                label={t('builder.joinKindOf', { target: sourceName(join.alias) })}
                isLabelHidden
                value={join.kind}
                onChange={(kind) =>
                  props.onChange({
                    ...spec,
                    joins: spec.joins.map((entry, i) => (i === index ? { ...entry, kind } : entry)),
                  })
                }
                options={[
                  { id: 'left', label: t('builder.join.left') },
                  { id: 'inner', label: t('builder.join.inner') },
                ]}
              />
              <Button
                variant="ghost"
                onPress={() => props.onChange(removeJoin(spec, join.alias))}
                aria-label={t('builder.removeJoin', { target: sourceName(join.alias) })}
              >
                {t('action.delete')}
              </Button>
              {props.errorAt('joins', index) !== undefined && (
                <p className={styles.error}>{props.errorAt('joins', index)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {spec.joins.length < maxJoins && (
        <div className={styles.row}>
          <SelectField
            label={t('builder.joinFrom')}
            value={effectiveFrom}
            onChange={(next) => {
              setFrom(next)
              setChoice('')
            }}
            options={sources.map((source) => ({
              id: source.alias,
              label: sourceName(source.alias),
            }))}
          />
          {options.length === 0 ? (
            <p className={styles.hint}>{t('builder.noRelations')}</p>
          ) : (
            <>
              <SelectField
                label={t('builder.joinVia')}
                value={chosen === undefined ? '' : key(chosen)}
                onChange={setChoice}
                options={options.map((option) => ({
                  id: key(option),
                  label: t(
                    option.direction === 'forward'
                      ? 'builder.join.forward'
                      : 'builder.join.reverse',
                    {
                      target: option.target,
                      column: option.column,
                      targetColumn: option.targetColumn,
                    },
                  ),
                }))}
              />
              <Button
                onPress={() =>
                  chosen !== undefined && props.onChange(addJoin(spec, effectiveFrom, chosen))
                }
              >
                {t('builder.addJoin')}
              </Button>
            </>
          )}
        </div>
      )}
    </SectionBox>
  )
}

/** Output columns with their function: a value, an aggregate or a time bucket. */
function ColumnsSection(props: {
  catalog: DesignCatalog
  spec: BuilderSpec
  onChange: (spec: BuilderSpec) => void
  errorAt: ReturnType<typeof useErrorsAt>
}) {
  const t = useT()
  const { spec, catalog } = props
  const sources = sourcesOf(spec, catalog)
  const sourceLabel = (alias: string) => {
    const object = objectOf(spec, catalog, alias)?.name ?? alias
    return alias === 'base' || alias === object ? object : `${object} (${alias})`
  }
  const grouping = groupingOf(spec)
  const items = spec.columns.map((column, index) => ({
    ...column,
    id: `${index}:${column.name}`,
    index,
  }))
  return (
    <SectionBox
      title={t('builder.columns')}
      error={
        props.errorAt('columns', null) !== undefined && items.length === 0
          ? props.errorAt('columns', null)
          : undefined
      }
    >
      <SortableList
        items={items}
        label={(item) => item.name}
        onReorder={(next) => {
          props.onChange({
            ...spec,
            columns: next.flatMap((item) => spec.columns[item.index] ?? []),
          })
        }}
      >
        {(item, handle) => {
          const kind = columnKind(spec, catalog, item.source, item.column)
          const object = objectOf(spec, catalog, item.source)
          const fn = functionOf(item)
          const functions =
            item.column === null ? (['count'] as ColumnFunction[]) : functionsFor(kind)
          const error = props.errorAt('columns', item.index)
          const nameValid = isValidOutputName(item.name)
          return (
            <div className={styles.columnRow}>
              {handle}
              <SelectField
                label={t('builder.columnSource', { n: item.index + 1 })}
                isLabelHidden
                value={item.source}
                onChange={(source) => {
                  const first = objectOf(spec, catalog, source)?.columns[0]?.name ?? null
                  props.onChange(
                    updateColumn(spec, item.index, { source, column: first, fn: 'value' }),
                  )
                }}
                options={sources.map((source) => ({
                  id: source.alias,
                  label: sourceLabel(source.alias),
                }))}
              />
              <SelectField
                label={t('builder.columnColumn', { n: item.index + 1 })}
                isLabelHidden
                value={item.column ?? countAll}
                onChange={(column) => {
                  const next = column === countAll ? null : column
                  const nextKind = columnKind(spec, catalog, item.source, next)
                  const keep = next !== null && functionsFor(nextKind).includes(fn)
                  props.onChange(
                    updateColumn(spec, item.index, {
                      column: next,
                      fn: next === null ? 'count' : keep ? fn : 'value',
                    }),
                  )
                }}
                options={[
                  ...(object?.columns ?? []).map((column) => ({
                    id: column.name,
                    label: column.name,
                  })),
                  ...(item.source === 'base'
                    ? [{ id: countAll, label: t('builder.allRows') }]
                    : []),
                ]}
              />
              <SelectField
                label={t('builder.columnFunction', { n: item.index + 1 })}
                isLabelHidden
                value={fn}
                onChange={(next) => props.onChange(updateColumn(spec, item.index, { fn: next }))}
                options={functions.map((id) => ({ id, label: t(functionLabels[id]) }))}
              />
              <TextField
                label={t('builder.columnName', { n: item.index + 1 })}
                value={item.name}
                onChange={(name) => props.onChange(updateColumn(spec, item.index, { name }))}
                error={nameValid ? undefined : t('builder.error.name')}
              />
              <Button
                variant="ghost"
                isDisabled={spec.columns.length <= 1}
                onPress={() => props.onChange(removeColumn(spec, item.index))}
                aria-label={t('builder.removeColumn', { name: item.name })}
              >
                {t('action.delete')}
              </Button>
              {error !== undefined && <p className={styles.error}>{error}</p>}
            </div>
          )
        }}
      </SortableList>
      {spec.columns.length < maxColumns && (
        <div className={styles.row}>
          <Button
            onPress={() => {
              const first = objectOf(spec, catalog, 'base')?.columns[0]?.name ?? null
              props.onChange(addColumn(spec, 'base', first))
            }}
          >
            {t('builder.addColumn')}
          </Button>
          <Button onPress={() => props.onChange(addColumn(spec, 'base', null))}>
            {t('builder.addCount')}
          </Button>
        </div>
      )}
      <p className={styles.hint} role="status">
        {grouping.length === 0
          ? t('builder.noGrouping')
          : t('builder.grouping', { columns: grouping.join(', ') })}
      </p>
    </SectionBox>
  )
}

function FilterRow(props: {
  catalog: DesignCatalog
  spec: BuilderSpec
  filter: SpecFilter
  index: number
  variables: readonly string[]
  onChange: (filter: SpecFilter) => void
  onRemove: () => void
  error: string | undefined
}) {
  const t = useT()
  const { spec, catalog, filter, index } = props
  const sources = sourcesOf(spec, catalog)
  const object = objectOf(spec, catalog, filter.source)
  const kind = columnKind(spec, catalog, filter.source, filter.column)
  const operators = operatorsFor(kind)
  const value = filter.value
  const noValue = filter.operator === 'null' || filter.operator === 'not_null'
  const between = filter.operator === 'between'
  const mode =
    value?.kind === 'parameter'
      ? props.variables.includes(value.name)
        ? `var:${value.name}`
        : parameterMode
      : constantMode
  const texts = value?.kind === 'constant' ? constantTexts(value.value, filter.operator) : ['']
  const setConstant = (nextTexts: string[]) =>
    props.onChange({
      ...filter,
      value: { kind: 'constant', value: constantFor(filter.operator, kind, nextTexts) },
    })
  const n = index + 1
  return (
    <div className={styles.columnRow}>
      <SelectField
        label={t('builder.filterSource', { n })}
        isLabelHidden
        value={filter.source}
        onChange={(source) => {
          const first = objectOf(spec, catalog, source)?.columns[0]?.name
          if (first !== undefined) props.onChange(newFilter(spec, catalog, source, first))
        }}
        options={sources.map((source) => ({
          id: source.alias,
          label: source.object?.name ?? source.alias,
        }))}
      />
      <SelectField
        label={t('builder.filterColumn', { n })}
        isLabelHidden
        value={filter.column}
        onChange={(column) => props.onChange(newFilter(spec, catalog, filter.source, column))}
        options={(object?.columns ?? []).map((column) => ({ id: column.name, label: column.name }))}
      />
      <SelectField
        label={t('builder.filterOperator', { n })}
        isLabelHidden
        value={filter.operator}
        onChange={(operator) => props.onChange(withOperator(filter, operator, kind))}
        options={operators.map((id) => ({ id, label: t(operatorLabels[id]) }))}
      />
      {!noValue && (
        <SelectField
          label={t('builder.filterMode', { n })}
          isLabelHidden
          value={mode}
          onChange={(next) => {
            if (next === constantMode)
              props.onChange(
                withOperator(
                  { ...filter, value: { kind: 'constant', value: '' } },
                  filter.operator,
                  kind,
                ),
              )
            else if (next === parameterMode)
              props.onChange({
                ...filter,
                value: {
                  kind: 'parameter',
                  name: sanitize(filter.column, 'value').toLowerCase().slice(0, 63),
                },
              })
            else props.onChange({ ...filter, value: { kind: 'parameter', name: next.slice(4) } })
          }}
          options={[
            { id: constantMode, label: t('builder.value.constant') },
            ...(between ? [] : [{ id: parameterMode, label: t('builder.value.parameter') }]),
            ...(between
              ? []
              : props.variables.map((name) => ({
                  id: `var:${name}`,
                  label: t('builder.value.variable', { name }),
                }))),
          ]}
        />
      )}
      {!noValue && mode === constantMode && kind === 'boolean' && (
        <SelectField
          label={t('builder.filterValue', { n })}
          isLabelHidden
          value={texts[0] === 'false' ? 'false' : 'true'}
          onChange={(next) => setConstant([next])}
          options={[
            { id: 'true', label: t('value.yes') },
            { id: 'false', label: t('value.no') },
          ]}
        />
      )}
      {!noValue && mode === constantMode && kind !== 'boolean' && (
        <>
          <TextField
            label={between ? t('builder.filterFrom', { n }) : t('builder.filterValue', { n })}
            value={texts[0] ?? ''}
            onChange={(text) => setConstant(between ? [text, texts[1] ?? ''] : [text])}
            {...((filter.operator === 'in' || filter.operator === 'not_in') && {
              description: t('builder.listHint'),
            })}
            {...(filter.operator === 'like' && { description: t('builder.likeHint') })}
          />
          {between && (
            <TextField
              label={t('builder.filterTo', { n })}
              value={texts[1] ?? ''}
              onChange={(text) => setConstant([texts[0] ?? '', text])}
            />
          )}
        </>
      )}
      {!noValue && mode === parameterMode && value?.kind === 'parameter' && (
        <TextField
          label={t('builder.parameterName', { n })}
          value={value.name}
          onChange={(name) =>
            props.onChange({
              ...filter,
              value: {
                kind: 'parameter',
                name: name
                  .toLowerCase()
                  .replace(/[^a-z0-9_]/g, '_')
                  .slice(0, 63),
              },
            })
          }
          description={t('builder.parameterHint')}
        />
      )}
      <Button
        variant="ghost"
        onPress={props.onRemove}
        aria-label={t('builder.removeFilter', { n })}
      >
        {t('action.delete')}
      </Button>
      {props.error !== undefined && <p className={styles.error}>{props.error}</p>}
    </div>
  )
}

/**
 * The query builder (§ Abfrage-Builder): base object, joins along known relations, columns
 * with aggregates or time buckets, filters, sort order and a limit. It edits the spec only;
 * the server compiles and validates it (§10.3).
 */
export function QueryBuilder(props: {
  catalog: DesignCatalog
  spec: BuilderSpec | null
  onChange: (spec: BuilderSpec) => void
  errors: readonly FieldError[]
  /** Names of instance variables, offered as filter values. */
  variables: readonly string[]
}) {
  const t = useT()
  const errorAt = useErrorsAt(props.errors)
  const [pendingBase, setPendingBase] = useState<string>()
  const { catalog, spec } = props
  const objects = catalog.objects
  const chooseBase = (name: string) => {
    const object = objects.find((entry) => entry.name === name)
    if (object !== undefined) props.onChange(specFor(object))
    setPendingBase(undefined)
  }
  if (objects.length === 0) return <Notice tone="info">{t('builder.noObjects')}</Notice>
  return (
    <div className={styles.builder}>
      <SectionBox
        title={t('builder.base')}
        hint={t('builder.baseHint')}
        error={errorAt('base', null)}
      >
        <SelectField
          label={t('builder.baseObject')}
          value={spec?.base ?? ''}
          onChange={(name) => {
            if (spec === null) chooseBase(name)
            else if (name !== spec.base) setPendingBase(name)
          }}
          options={[
            ...(spec === null ? [{ id: '', label: t('editor.choose') }] : []),
            ...objects.map((object) => ({ id: object.name, label: object.name })),
          ]}
        />
        {pendingBase !== undefined && (
          <Notice tone="info">
            {t('builder.baseReset', { name: pendingBase })}{' '}
            <Button onPress={() => chooseBase(pendingBase)}>{t('builder.baseResetConfirm')}</Button>{' '}
            <Button variant="ghost" onPress={() => setPendingBase(undefined)}>
              {t('action.cancel')}
            </Button>
          </Notice>
        )}
      </SectionBox>
      {spec !== null && (
        <>
          <JoinsSection catalog={catalog} spec={spec} onChange={props.onChange} errorAt={errorAt} />
          <ColumnsSection
            catalog={catalog}
            spec={spec}
            onChange={props.onChange}
            errorAt={errorAt}
          />
          <SectionBox title={t('builder.filters')} hint={t('builder.filtersHint')}>
            {spec.filters.map((filter, index) => (
              <FilterRow
                key={index}
                catalog={catalog}
                spec={spec}
                filter={filter}
                index={index}
                variables={props.variables}
                error={errorAt('filters', index)}
                onChange={(next) =>
                  props.onChange({
                    ...spec,
                    filters: spec.filters.map((entry, i) => (i === index ? next : entry)),
                  })
                }
                onRemove={() =>
                  props.onChange({ ...spec, filters: spec.filters.filter((_, i) => i !== index) })
                }
              />
            ))}
            {spec.filters.length < maxFilters && (
              <div className={styles.row}>
                <Button
                  onPress={() => {
                    const first = objectOf(spec, catalog, 'base')?.columns[0]?.name
                    if (first !== undefined)
                      props.onChange({
                        ...spec,
                        filters: [...spec.filters, newFilter(spec, catalog, 'base', first)],
                      })
                  }}
                >
                  {t('builder.addFilter')}
                </Button>
              </div>
            )}
          </SectionBox>
          <SectionBox title={t('builder.sortAndLimit')}>
            {spec.sort.map((entry, index) => (
              <div key={index} className={styles.row}>
                <SelectField
                  label={t('builder.sortColumn', { n: index + 1 })}
                  value={entry.column}
                  onChange={(column) =>
                    props.onChange({
                      ...spec,
                      sort: spec.sort.map((item, i) => (i === index ? { ...item, column } : item)),
                    })
                  }
                  options={spec.columns.map((column) => ({ id: column.name, label: column.name }))}
                />
                <SelectField
                  label={t('builder.sortDirection', { n: index + 1 })}
                  value={entry.direction}
                  onChange={(direction) =>
                    props.onChange({
                      ...spec,
                      sort: spec.sort.map((item, i) =>
                        i === index ? { ...item, direction } : item,
                      ),
                    })
                  }
                  options={[
                    { id: 'asc', label: t('builder.sort.asc') },
                    { id: 'desc', label: t('builder.sort.desc') },
                  ]}
                />
                <Button
                  variant="ghost"
                  onPress={() =>
                    props.onChange({ ...spec, sort: spec.sort.filter((_, i) => i !== index) })
                  }
                  aria-label={t('builder.removeSort', { n: index + 1 })}
                >
                  {t('action.delete')}
                </Button>
                {errorAt('sort', index) !== undefined && (
                  <p className={styles.error}>{errorAt('sort', index)}</p>
                )}
              </div>
            ))}
            {spec.sort.length < maxSort && spec.columns[0] !== undefined && (
              <div className={styles.row}>
                <Button
                  onPress={() => {
                    const used = new Set(spec.sort.map((entry) => entry.column))
                    const column =
                      spec.columns.find((entry) => !used.has(entry.name))?.name ??
                      spec.columns[0]?.name ??
                      ''
                    props.onChange({ ...spec, sort: [...spec.sort, { column, direction: 'asc' }] })
                  }}
                >
                  {t('builder.addSort')}
                </Button>
              </div>
            )}
            <div className={styles.row}>
              <SwitchField
                label={t('builder.limit')}
                isSelected={spec.limit !== null}
                onChange={(on) => props.onChange({ ...spec, limit: on ? 100 : null })}
                description={t('builder.limitHint')}
              />
              {spec.limit !== null && (
                <TextField
                  label={t('builder.limitRows')}
                  type="number"
                  value={String(spec.limit)}
                  onChange={(text) =>
                    props.onChange({
                      ...spec,
                      limit: Math.max(1, Math.min(10_000, Math.round(Number(text)) || 1)),
                    })
                  }
                />
              )}
            </div>
          </SectionBox>
        </>
      )}
    </div>
  )
}
