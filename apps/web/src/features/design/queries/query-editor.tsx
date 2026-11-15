// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  FieldError,
  ParamType,
  Query,
  QueryParameter,
  QueryResult,
  SqlProblemCode,
  Visualization,
} from '@stashley/shared'
import { analyzeShape, paramTypes } from '@stashley/shared'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Button,
  CheckboxField,
  Notice,
  PageHeader,
  Section,
  SelectField,
  TextAreaField,
  TextField,
} from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import { StateView } from '../../../ui/state.tsx'
import { DataTable } from '../../workspace/blocks/data-table.tsx'
import {
  designKeys,
  useCatalog,
  useDesignConnections,
  useQueryDetail,
  useVariables,
} from '../design-api.ts'
import { QueryBuilder } from './builder/builder.tsx'
import builderStyles from './builder/builder.module.css'
import { specParameters, syncSpecDefinitions, type BuilderSpec } from './builder/spec-ops.ts'
import { parameterNames, syncDefinitions, testValue } from './param-values.ts'
import { lineAndColumn, sqlProblemTexts } from './sql-problems.ts'
import styles from './queries.module.css'
import { ttlOptions, useTtlLabel } from './ttl.ts'

// CodeMirror is a lazy chunk (§22).
const SqlEditor = lazy(() => import('./sql-editor-view.tsx'))

const typeLabels: Record<ParamType, MessageId> = {
  string: 'variables.type.string',
  integer: 'variables.type.integer',
  decimal: 'variables.type.decimal',
  date: 'variables.type.date',
  datetime: 'variables.type.datetime',
  boolean: 'variables.type.boolean',
}

const visualizationLabels: Record<Visualization, MessageId> = {
  metric: 'editor.type.metric',
  progress: 'queries.shape.progress',
  record: 'editor.type.record',
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
  table: 'editor.type.table',
}

const builderNotes: Record<string, MessageId> = {
  timestamp_buckets_utc: 'builder.note.timestamp_buckets_utc',
}

interface Validation {
  sql: string
  analysis: Query['current']['analysis']
  limit: 'append' | 'wrap'
  notes: string[]
}

type Mode = 'builder' | 'sql'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/** The SQL problem of a failed validation or run, with its position (§10.2). */
function useSqlProblem() {
  const t = useT()
  return (error: unknown, text: string) => {
    if (!(error instanceof ApiError)) return undefined
    const problem = error.errors.find((entry) => entry.field === 'sql')
    if (problem === undefined) return undefined
    const id = sqlProblemTexts[problem.code as SqlProblemCode] as MessageId | undefined
    const detail = typeof problem.params?.detail === 'string' ? problem.params.detail : ''
    const message =
      id === undefined ? t('sql.problem.other', { code: problem.code }) : t(id, { detail })
    const offset =
      typeof problem.params?.position === 'number' ? problem.params.position : undefined
    const at = offset === undefined ? undefined : lineAndColumn(text, offset)
    return { message, offset, at }
  }
}

const fieldErrorsOf = (error: unknown): FieldError[] =>
  error instanceof ApiError ? error.errors : []

function QueryForm(props: { query: Query | undefined }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const ttlLabel = useTtlLabel()
  const sqlProblem = useSqlProblem()
  const connections = useDesignConnections()
  const variables = useVariables()
  const query = props.query
  const [mode, setMode] = useState<Mode>(query?.mode ?? 'builder')
  const [spec, setSpec] = useState<BuilderSpec | null>(query?.builder?.spec ?? null)
  const [name, setName] = useState(query?.name ?? '')
  const [description, setDescription] = useState(query?.description ?? '')
  const [connectionId, setConnectionId] = useState(query?.connectionId ?? '')
  const [ttl, setTtl] = useState(String(query?.cacheTtlSeconds ?? 300))
  const [customTtl, setCustomTtl] = useState('')
  const [sqlText, setSqlText] = useState(query?.current.sql ?? '')
  const [definitions, setDefinitions] = useState<QueryParameter[]>(query?.current.parameters ?? [])
  const [values, setValues] = useState<Record<string, string>>({})
  const [focus, setFocus] = useState<{ offset: number; nonce: number }>()
  const [confirmConvert, setConfirmConvert] = useState(false)
  const effectiveConnection = connectionId === '' ? (connections.data?.[0]?.id ?? '') : connectionId
  const catalog = useCatalog(effectiveConnection === '' ? undefined : effectiveConnection)
  const engine = connections.data?.find((entry) => entry.id === effectiveConnection)?.engine ?? null
  const builder = mode === 'builder'

  const schema = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const object of catalog.data?.objects ?? [])
      map[object.name] = object.columns.map((column) => column.name)
    return map
  }, [catalog.data])
  const variableNames = (variables.data ?? []).map((variable) => variable.name)
  const definable = (entry: string) =>
    !variableNames.includes(entry) && !entry.startsWith('current_user_')
  const params =
    builder && spec !== null && catalog.data !== undefined
      ? syncSpecDefinitions(
          definitions,
          specParameters(spec, catalog.data).filter((entry) => definable(entry.name)),
        )
      : builder
        ? []
        : syncDefinitions(definitions, parameterNames(sqlText).filter(definable))
  const usedVariables = builder
    ? (spec?.filters ?? []).flatMap((filter) =>
        filter.value?.kind === 'parameter' && variableNames.includes(filter.value.name)
          ? [filter.value.name]
          : [],
      )
    : parameterNames(sqlText).filter((entry) => variableNames.includes(entry))
  const setDefinition = (index: number, patch: Partial<QueryParameter>) =>
    setDefinitions(params.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  const ttlSeconds =
    ttl === 'custom' ? Math.max(0, Math.min(30 * 86400, Number(customTtl) || 0)) : Number(ttl)
  const source = builder ? { builder: spec } : { sql: sqlText }
  const ready = builder ? spec !== null : sqlText.trim() !== ''

  // The builder compiles on the server as the manager edits (§10.3).
  const previewInput = useDebounced(
    JSON.stringify({ connectionId: effectiveConnection, builder: spec, parameters: params }),
    400,
  )
  const preview = useQuery({
    queryKey: ['design', 'builder-preview', previewInput],
    queryFn: () =>
      api<Validation>('POST', '/internal/design/queries/validate', JSON.parse(previewInput)),
    enabled: builder && spec !== null && effectiveConnection !== '',
    placeholderData: keepPreviousData,
    retry: false,
  })
  const compiledSql = builder ? (preview.data?.sql ?? '') : sqlText

  const validate = useMutation({
    mutationFn: () =>
      api<Validation>('POST', '/internal/design/queries/validate', {
        connectionId: effectiveConnection,
        ...source,
        parameters: params,
      }),
  })
  const run = useMutation({
    mutationFn: () => {
      const typed: Record<string, unknown> = {}
      for (const definition of params) {
        const value = testValue(definition, values[definition.name] ?? '')
        if (value !== undefined) typed[definition.name] = value
      }
      for (const variable of usedVariables) {
        const value = values[variable]
        if (value !== undefined && value !== '') typed[variable] = value
      }
      return api<QueryResult & { durationMs: number }>('POST', '/internal/design/queries/run', {
        connectionId: effectiveConnection,
        ...source,
        parameters: params,
        values: typed,
      })
    },
  })
  const save = useMutation({
    mutationFn: () => {
      const common = { name, description, parameters: params, cacheTtlSeconds: ttlSeconds }
      return query === undefined
        ? api<Query>('POST', '/internal/design/queries', {
            ...common,
            connectionId: effectiveConnection,
            ...source,
          })
        : api<Query>('PATCH', `/internal/design/queries/${query.id}`, { ...common, ...source })
    },
    onSuccess: async (saved) => {
      client.setQueryData(designKeys.query(saved.id), saved)
      await client.invalidateQueries({ queryKey: designKeys.queries })
      if (query === undefined)
        void navigate({
          to: '/design/queries/$queryId',
          params: { queryId: saved.id },
          replace: true,
        })
    },
  })
  // Converting is one way (§ Abfrage-Builder): the next version is plain SQL.
  const convert = useMutation({
    mutationFn: () =>
      api<Query>('PATCH', `/internal/design/queries/${query?.id ?? ''}`, {
        sql: compiledSql === '' ? (query?.current.sql ?? '') : compiledSql,
        parameters: params,
      }),
    onSuccess: async (saved) => {
      client.setQueryData(designKeys.query(saved.id), saved)
      await client.invalidateQueries({ queryKey: designKeys.queries })
    },
  })
  const convertNow = () => {
    setConfirmConvert(false)
    if (query === undefined || query.mode === 'sql') {
      setSqlText(compiledSql)
      setMode('sql')
    } else convert.mutate()
  }
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/design/queries/${query?.id ?? ''}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: designKeys.queries })
      void navigate({ to: '/design/queries' })
    },
  })

  const actionError = run.error ?? save.error ?? validate.error
  const builderErrors = [
    ...fieldErrorsOf(builder && actionError === null ? preview.error : null),
    ...fieldErrorsOf(builder ? actionError : null),
  ].filter((entry) => entry.field.startsWith('builder.'))
  const problem = sqlProblem(
    actionError ?? (builder ? preview.error : null),
    builder ? compiledSql : sqlText,
  )
  const fieldErrors = [actionError, builder ? preview.error : null]
    .flatMap(fieldErrorsOf)
    .filter(
      (entry) =>
        entry.field !== 'sql' && entry.field !== 'name' && !entry.field.startsWith('builder.'),
    )
  const generalError = [save.error, run.error, validate.error, remove.error, convert.error]
    .map((error) => errors.message(error))
    .find((text) => text !== undefined)
  const result = run.data
  const shape = result === undefined ? undefined : analyzeShape(result.columns, result.rows.length)
  const notes = (builder ? preview.data?.notes : undefined) ?? []

  return (
    <>
      <PageHeader
        title={query?.name ?? t('queries.new')}
        actions={
          <Actions>
            <Link to="/design/queries">{t('queries.back')}</Link>
          </Actions>
        }
      />
      {generalError !== undefined && <Notice tone="error">{generalError}</Notice>}
      {save.isSuccess && (
        <Notice tone="success">{t('queries.saved', { version: save.data.latestVersion })}</Notice>
      )}
      <div className={styles.layout}>
        <div className={styles.main}>
          {query === undefined && spec === null && sqlText.trim() === '' && (
            <SelectField
              label={t('queries.createWith')}
              value={mode}
              onChange={setMode}
              options={[
                { id: 'builder', label: t('queries.mode.builderLong') },
                { id: 'sql', label: t('queries.mode.sqlLong') },
              ]}
            />
          )}
          {builder ? (
            catalog.data === undefined ? (
              <p className={table.muted}>{t('block.loading')}</p>
            ) : (
              <>
                <QueryBuilder
                  catalog={catalog.data}
                  spec={spec}
                  onChange={setSpec}
                  errors={builderErrors}
                  variables={variableNames}
                />
                <Section title={t('builder.sql')}>
                  <p className={table.muted}>{t('builder.sqlHint')}</p>
                  {compiledSql !== '' && (
                    <pre className={builderStyles.sql} aria-busy={preview.isFetching}>
                      {compiledSql}
                    </pre>
                  )}
                  {notes.map((note) => (
                    <Notice key={note} tone="info">
                      {builderNotes[note] === undefined ? note : t(builderNotes[note])}
                    </Notice>
                  ))}
                  {spec !== null && (
                    <div>
                      {confirmConvert ? (
                        <Notice tone="info">
                          {t('queries.convertConfirm')}{' '}
                          <Button
                            variant="danger"
                            onPress={convertNow}
                            isDisabled={compiledSql === '' || convert.isPending}
                          >
                            {t('queries.convert')}
                          </Button>{' '}
                          <Button variant="ghost" onPress={() => setConfirmConvert(false)}>
                            {t('action.cancel')}
                          </Button>
                        </Notice>
                      ) : (
                        <Button
                          onPress={() => setConfirmConvert(true)}
                          isDisabled={compiledSql === ''}
                        >
                          {t('queries.convert')}
                        </Button>
                      )}
                    </div>
                  )}
                </Section>
              </>
            )
          ) : (
            <Suspense fallback={<p className={table.muted}>{t('block.loading')}</p>}>
              <SqlEditor
                value={sqlText}
                onChange={setSqlText}
                schema={schema}
                dialect={engine}
                label={t('queries.sql')}
                placeholderText={t('queries.sqlPlaceholder')}
                focus={focus}
              />
            </Suspense>
          )}
          {problem !== undefined && (
            <Notice tone="error">
              {problem.message}
              {!builder && problem.at !== undefined && problem.offset !== undefined && (
                <>
                  {' '}
                  <Button
                    variant="ghost"
                    onPress={() => setFocus({ offset: problem.offset ?? 0, nonce: Date.now() })}
                  >
                    {t('queries.goTo', { line: problem.at.line, column: problem.at.column })}
                  </Button>
                </>
              )}
            </Notice>
          )}
          {fieldErrors.length > 0 && (
            <Notice tone="error">
              <ul className={styles.list}>
                {fieldErrors.map((error, index) => (
                  <li key={index}>
                    <code>{error.field}</code>: {error.code}
                    {typeof error.params?.name === 'string' && ` (${error.params.name})`}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {validate.isSuccess && problem === undefined && (
            <Notice tone="success">
              {t('queries.valid', { objects: validate.data.analysis.objects.join(', ') })}
              {validate.data.analysis.usesUserContext && ` ${t('queries.perUser')}`}
            </Notice>
          )}
          <Actions>
            <Button onPress={() => validate.mutate()} isDisabled={validate.isPending || !ready}>
              {t('queries.validate')}
            </Button>
            <Button onPress={() => run.mutate()} isDisabled={run.isPending || !ready}>
              {t('queries.run')}
            </Button>
            <Button
              variant="primary"
              onPress={() => save.mutate()}
              isDisabled={save.isPending || name.trim() === '' || !ready}
            >
              {t('action.save')}
            </Button>
          </Actions>
          {result !== undefined && (
            <Section
              title={t('queries.result', { count: result.rows.length, ms: result.durationMs })}
            >
              {result.truncated && <p className={table.muted}>{t('queries.resultTruncated')}</p>}
              {shape !== undefined && (
                <p className={table.muted}>
                  {t('queries.shape', {
                    suggested: t(visualizationLabels[shape.suggested]),
                    allowed: shape.allowed.map((entry) => t(visualizationLabels[entry])).join(', '),
                  })}
                </p>
              )}
              <DataTable
                caption={t('queries.resultCaption')}
                columns={result.columns.map((column) => ({
                  id: column.name,
                  label: `${column.name} (${column.type})`,
                  kind: column.kind,
                }))}
                rows={result.rows}
              />
            </Section>
          )}
        </div>
        <aside className={styles.side}>
          <TextField
            label={t('field.name')}
            value={name}
            onChange={setName}
            error={errors.field(save.error, 'name')}
            isRequired
          />
          <TextAreaField
            label={t('field.description')}
            value={description}
            onChange={setDescription}
            rows={2}
          />
          {query === undefined ? (
            <SelectField
              label={t('editor.connection')}
              value={effectiveConnection}
              onChange={(next) => {
                setConnectionId(next)
                setSpec(null)
              }}
              options={(connections.data ?? []).map((entry) => ({
                id: entry.id,
                label: entry.name,
              }))}
            />
          ) : (
            <p className={table.muted}>
              {t('queries.connectionFixed', {
                name:
                  connections.data?.find((entry) => entry.id === query.connectionId)?.name ?? '',
              })}
            </p>
          )}
          <SelectField
            label={t('queries.cache')}
            value={ttl}
            onChange={setTtl}
            options={[
              ...ttlOptions(ttlLabel, Number(ttl === 'custom' ? 300 : ttl)),
              { id: 'custom', label: t('queries.ttl.custom') },
            ]}
          />
          {ttl === 'custom' && (
            <TextField
              label={t('queries.ttl.seconds')}
              type="number"
              value={customTtl}
              onChange={setCustomTtl}
            />
          )}
          <Section title={t('queries.parameters')}>
            {params.length === 0 && (
              <p className={table.muted}>
                {builder ? t('queries.noParametersBuilder') : t('queries.noParameters')}
              </p>
            )}
            {params.map((definition, index) => (
              <div key={definition.name} className={styles.parameter}>
                <code>:{definition.name}</code>
                <SelectField
                  label={t('variables.column.type')}
                  value={definition.type}
                  onChange={(type) => setDefinition(index, { type, defaultValue: null })}
                  options={paramTypes.map((id) => ({ id, label: t(typeLabels[id]) }))}
                />
                <CheckboxField
                  label={t('queries.param.list')}
                  isSelected={definition.list}
                  onChange={(list) => setDefinition(index, { list, defaultValue: null })}
                />
                <CheckboxField
                  label={t('queries.param.required')}
                  isSelected={definition.required}
                  onChange={(required) => setDefinition(index, { required })}
                />
                <TextField
                  label={t('queries.param.default')}
                  value={
                    definition.defaultValue === null
                      ? ''
                      : Array.isArray(definition.defaultValue)
                        ? definition.defaultValue.join(', ')
                        : String(definition.defaultValue)
                  }
                  onChange={(text) => {
                    const value = testValue(definition, text)
                    setDefinition(index, {
                      defaultValue:
                        value === undefined ? null : (value as QueryParameter['defaultValue']),
                    })
                  }}
                />
                <TextField
                  label={t('queries.param.test')}
                  value={values[definition.name] ?? ''}
                  onChange={(text) => setValues({ ...values, [definition.name]: text })}
                />
              </div>
            ))}
            {[...new Set(usedVariables)].map((variable) => (
              <TextField
                key={variable}
                label={t('queries.variableTest', { name: variable })}
                description={t('queries.variableHint')}
                value={values[variable] ?? ''}
                onChange={(text) => setValues({ ...values, [variable]: text })}
              />
            ))}
          </Section>
          {query !== undefined && (
            <Section title={t('queries.usedBy')}>
              {query.usedBy.length === 0 ? (
                <p className={table.muted}>{t('queries.unused')}</p>
              ) : (
                <>
                  <p className={table.muted}>{t('queries.usedByHint')}</p>
                  <ul className={styles.list}>
                    {query.usedBy.map((page) => (
                      <li key={page.pageId}>{page.title}</li>
                    ))}
                  </ul>
                </>
              )}
              {query.usedBy.length === 0 && (
                <Button
                  variant="danger"
                  onPress={() => remove.mutate()}
                  isDisabled={remove.isPending}
                >
                  {t('queries.delete')}
                </Button>
              )}
            </Section>
          )}
        </aside>
      </div>
    </>
  )
}

/** The query editor (§ Abfrage-Builder, SQL-Editor) for a new or a stored query. */
export function QueryEditorPage() {
  const t = useT()
  const params: { queryId?: string } = useParams({ strict: false })
  const id = params.queryId ?? 'new'
  const detail = useQueryDetail(id === 'new' ? undefined : id)
  if (id === 'new') return <QueryForm key="new" query={undefined} />
  if (detail.isError) return <StateView title={t('notFound.title')} />
  if (detail.data === undefined) return <StateView title={t('block.loading')} mascot={false} />
  return <QueryForm key={`${detail.data.id}:${detail.data.mode}`} query={detail.data} />
}
