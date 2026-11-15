// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ParamType,
  Query,
  QueryParameter,
  QueryResult,
  SqlProblemCode,
} from '@stashley/shared'
import { paramTypes } from '@stashley/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { lazy, Suspense, useMemo, useState } from 'react'
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

interface Validation {
  sql: string
  analysis: Query['current']['analysis']
  limit: 'append' | 'wrap'
  notes: string[]
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
  const [name, setName] = useState(query?.name ?? '')
  const [description, setDescription] = useState(query?.description ?? '')
  const [connectionId, setConnectionId] = useState(query?.connectionId ?? '')
  const [ttl, setTtl] = useState(String(query?.cacheTtlSeconds ?? 300))
  const [customTtl, setCustomTtl] = useState('')
  const [sqlText, setSqlText] = useState(query?.current.sql ?? '')
  const [definitions, setDefinitions] = useState<QueryParameter[]>(query?.current.parameters ?? [])
  const [values, setValues] = useState<Record<string, string>>({})
  const [focus, setFocus] = useState<{ offset: number; nonce: number }>()
  const effectiveConnection = connectionId === '' ? (connections.data?.[0]?.id ?? '') : connectionId
  const catalog = useCatalog(effectiveConnection === '' ? undefined : effectiveConnection)
  const engine = connections.data?.find((entry) => entry.id === effectiveConnection)?.engine ?? null
  const builder = query?.mode === 'builder'

  const schema = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const object of catalog.data?.objects ?? [])
      map[object.name] = object.columns.map((column) => column.name)
    return map
  }, [catalog.data])
  const variableNames = (variables.data ?? []).map((variable) => variable.name)
  const names = parameterNames(sqlText).filter(
    (entry) => !variableNames.includes(entry) && !entry.startsWith('current_user_'),
  )
  const params = syncDefinitions(definitions, names)
  const setDefinition = (index: number, patch: Partial<QueryParameter>) =>
    setDefinitions(params.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  const ttlSeconds =
    ttl === 'custom' ? Math.max(0, Math.min(30 * 86400, Number(customTtl) || 0)) : Number(ttl)

  const validate = useMutation({
    mutationFn: () =>
      api<Validation>('POST', '/internal/design/queries/validate', {
        connectionId: effectiveConnection,
        sql: sqlText,
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
      for (const variable of variableNames) {
        const value = values[variable]
        if (value !== undefined && value !== '') typed[variable] = value
      }
      return api<QueryResult & { durationMs: number }>('POST', '/internal/design/queries/run', {
        connectionId: effectiveConnection,
        sql: sqlText,
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
            sql: sqlText,
          })
        : api<Query>('PATCH', `/internal/design/queries/${query.id}`, {
            ...common,
            ...(!builder && { sql: sqlText }),
          })
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
  const convert = useMutation({
    mutationFn: () =>
      api<Query>('PATCH', `/internal/design/queries/${query?.id ?? ''}`, {
        sql: query?.current.sql ?? sqlText,
      }),
    onSuccess: async (saved) => {
      client.setQueryData(designKeys.query(saved.id), saved)
      await client.invalidateQueries({ queryKey: designKeys.queries })
    },
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/design/queries/${query?.id ?? ''}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: designKeys.queries })
      void navigate({ to: '/design/queries' })
    },
  })

  const problem = sqlProblem(validate.error ?? run.error ?? save.error, sqlText)
  const fieldErrors = [validate.error, run.error, save.error].flatMap((error) =>
    error instanceof ApiError
      ? error.errors.filter((entry) => entry.field !== 'sql' && entry.field !== 'name')
      : [],
  )
  const generalError = [save.error, run.error, validate.error, remove.error, convert.error]
    .map((error) => errors.message(error))
    .find((text) => text !== undefined)
  const result = run.data

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
          {builder && (
            <Notice tone="info">
              {t('queries.builderReadOnly')}{' '}
              <Button onPress={() => convert.mutate()} isDisabled={convert.isPending}>
                {t('queries.convert')}
              </Button>
            </Notice>
          )}
          <Suspense fallback={<p className={table.muted}>{t('block.loading')}</p>}>
            <SqlEditor
              value={sqlText}
              onChange={setSqlText}
              schema={schema}
              dialect={engine}
              label={t('queries.sql')}
              placeholderText={t('queries.sqlPlaceholder')}
              focus={focus}
              readOnly={builder}
            />
          </Suspense>
          {problem !== undefined && (
            <Notice tone="error">
              {problem.message}
              {problem.at !== undefined && problem.offset !== undefined && (
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
            <Button
              onPress={() => validate.mutate()}
              isDisabled={validate.isPending || sqlText.trim() === ''}
            >
              {t('queries.validate')}
            </Button>
            <Button
              onPress={() => run.mutate()}
              isDisabled={run.isPending || sqlText.trim() === ''}
            >
              {t('queries.run')}
            </Button>
            <Button
              variant="primary"
              onPress={() => save.mutate()}
              isDisabled={save.isPending || name.trim() === '' || sqlText.trim() === ''}
            >
              {t('action.save')}
            </Button>
          </Actions>
          {result !== undefined && (
            <Section
              title={t('queries.result', { count: result.rows.length, ms: result.durationMs })}
            >
              {result.truncated && <p className={table.muted}>{t('queries.resultTruncated')}</p>}
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
              onChange={setConnectionId}
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
            {params.length === 0 && <p className={table.muted}>{t('queries.noParameters')}</p>}
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
            {parameterNames(sqlText)
              .filter((entry) => variableNames.includes(entry))
              .map((variable) => (
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

/** The SQL editor (§ SQL-Editor) for a new or a stored query. */
export function QueryEditorPage() {
  const t = useT()
  const params: { queryId?: string } = useParams({ strict: false })
  const id = params.queryId ?? 'new'
  const detail = useQueryDetail(id === 'new' ? undefined : id)
  if (id === 'new') return <QueryForm key="new" query={undefined} />
  if (detail.isError) return <StateView title={t('notFound.title')} />
  if (detail.data === undefined) return <StateView title={t('block.loading')} mascot={false} />
  return (
    <QueryForm
      key={`${detail.data.id}:${detail.data.latestVersion}:${detail.data.mode}`}
      query={detail.data}
    />
  )
}
