// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ImportCellError,
  ImportColumnMapping,
  ImportJob,
  ImportMapping,
  ImportMode,
  ImportParseOptions,
  ImportPreview,
  ImportStatus,
  ImportTarget,
  NewTableDefinition,
  Connection,
} from '@stashley/shared'
import { importDelimiters, importEncodings } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { api, downloadGet, uploadFile } from '../../../api/client.ts'
import { useUser } from '../../../api/session.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useFormatDateTime } from '../../../i18n/format.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Badge,
  Button,
  Notice,
  PageHeader,
  Section,
  SelectField,
  SwitchField,
  TextField,
} from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import styles from '../../admin/connections/connections.module.css'
import { NewTableOutcomeView, TableDefinitionEditor } from '../../admin/tables/table-editor.tsx'
import { ScrollArea } from '../../../ui/scroll-area.tsx'

const jobsKey = ['design', 'imports'] as const
const newTableChoice = '__new'
const jobKey = (id: string) => ['design', 'imports', id] as const

const statusLabels: Record<ImportStatus, MessageId> = {
  uploaded: 'imports.status.uploaded',
  checking: 'imports.status.checking',
  checked: 'imports.status.checked',
  importing: 'imports.status.importing',
  completed: 'imports.status.completed',
  failed: 'imports.status.failed',
  cancelled: 'imports.status.cancelled',
}

const statusTones: Record<ImportStatus, 'neutral' | 'accent' | 'warning' | 'danger' | 'success'> = {
  uploaded: 'neutral',
  checking: 'accent',
  checked: 'accent',
  importing: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
}

const delimiterLabels: Record<(typeof importDelimiters)[number], MessageId> = {
  ',': 'imports.delimiter.comma',
  ';': 'imports.delimiter.semicolon',
  '\t': 'imports.delimiter.tab',
}

const cellCodes: Record<string, MessageId> = {
  invalid: 'imports.cell.invalid',
  required: 'imports.cell.required',
  too_long: 'imports.cell.tooLong',
  out_of_range: 'imports.cell.outOfRange',
  not_in_list: 'imports.cell.notInList',
  duplicate_in_file: 'imports.cell.duplicateInFile',
  unique_violation: 'imports.cell.unique',
  foreign_key_violation: 'imports.cell.reference',
  ambiguous_reference: 'imports.cell.ambiguous',
}

function useCellText() {
  const t = useT()
  return (error: ImportCellError) =>
    t(cellCodes[error.code] ?? 'imports.cell.other', { code: error.code })
}

const words = (text: string) =>
  text
    .split(',')
    .map((word) => word.trim())
    .filter((word, index, all) => word !== '' && all.indexOf(word) === index)

export function ImportsPage() {
  const t = useT()
  const errors = useErrorText()
  const formatDate = useFormatDateTime()
  const navigate = useNavigate()
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const jobs = useQuery({
    queryKey: jobsKey,
    queryFn: () => api<{ data: ImportJob[] }>('GET', '/internal/imports'),
  })
  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile<ImportJob>(
        `/internal/imports?fileName=${encodeURIComponent(file.name)}`,
        file,
        'text/csv',
      ),
    onSuccess: async (job) => {
      await client.invalidateQueries({ queryKey: jobsKey })
      await navigate({ to: '/design/imports/$importId', params: { importId: job.id } })
    },
  })
  return (
    <>
      <PageHeader
        title={t('imports.title')}
        actions={
          <>
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file !== undefined) upload.mutate(file)
                event.target.value = ''
              }}
            />
            <Button
              variant="primary"
              onPress={() => input.current?.click()}
              isDisabled={upload.isPending}
            >
              {upload.isPending ? t('imports.uploading') : t('imports.upload')}
            </Button>
          </>
        }
      />
      <p className={styles.muted}>{t('imports.intro')}</p>
      {upload.error !== null && <Notice tone="error">{errors.message(upload.error)}</Notice>}
      <ScrollArea>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('imports.file')}</th>
              <th>{t('imports.status')}</th>
              <th>{t('imports.uploaded')}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data?.data.map((job) => (
              <tr key={job.id}>
                <td>
                  <Link to="/design/imports/$importId" params={{ importId: job.id }}>
                    {job.fileName}
                  </Link>
                </td>
                <td>
                  <Badge tone={statusTones[job.status]}>{t(statusLabels[job.status])}</Badge>
                </td>
                <td className={table.muted}>{formatDate(new Date(job.createdAt).toISOString())}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.data?.data.length === 0 && <p className={table.empty}>{t('imports.empty')}</p>}
      </ScrollArea>
    </>
  )
}

function OptionsForm(props: {
  options: ImportParseOptions
  onChange: (options: ImportParseOptions) => void
}) {
  const t = useT()
  const { options } = props
  const set = (patch: Partial<ImportParseOptions>) => props.onChange({ ...options, ...patch })
  return (
    <div className={styles.grid}>
      <SelectField
        label={t('imports.encoding')}
        value={options.encoding}
        onChange={(encoding) => set({ encoding })}
        options={importEncodings.map((id) => ({
          id,
          label: id === 'utf-8' ? 'UTF-8' : 'Windows-1252',
        }))}
      />
      <SelectField
        label={t('imports.delimiter')}
        value={options.delimiter}
        onChange={(delimiter) => set({ delimiter })}
        options={importDelimiters.map((id) => ({ id, label: t(delimiterLabels[id]) }))}
      />
      <SwitchField
        label={t('imports.header')}
        isSelected={options.header}
        onChange={(header) => set({ header })}
      />
      <SelectField
        label={t('imports.decimal')}
        value={options.decimalSeparator}
        onChange={(decimalSeparator) => set({ decimalSeparator })}
        options={[
          { id: ',', label: t('imports.decimal.comma') },
          { id: '.', label: t('imports.decimal.point') },
        ]}
      />
      <SelectField
        label={t('imports.thousands')}
        value={options.thousandsSeparator === '' ? 'none' : options.thousandsSeparator}
        onChange={(value) =>
          set({
            thousandsSeparator: value === 'none' ? '' : value,
          })
        }
        options={[
          { id: 'none', label: t('imports.thousands.none') },
          { id: '.', label: '1.234' },
          { id: ',', label: '1,234' },
          { id: ' ', label: '1 234' },
          { id: "'", label: "1'234" },
        ]}
      />
      <TextField
        label={t('imports.dateFormat')}
        value={options.dateFormat}
        onChange={(dateFormat) => set({ dateFormat })}
        description={t('imports.dateFormat.hint')}
      />
      <TextField
        label={t('imports.dateTimeFormat')}
        value={options.dateTimeFormat}
        onChange={(dateTimeFormat) => set({ dateTimeFormat })}
        description={t('imports.dateTimeFormat.hint')}
      />
      <TextField
        label={t('imports.true')}
        value={options.trueValues.join(', ')}
        onChange={(text) => set({ trueValues: words(text) })}
      />
      <TextField
        label={t('imports.false')}
        value={options.falseValues.join(', ')}
        onChange={(text) => set({ falseValues: words(text) })}
      />
      <TextField
        label={t('imports.emptyValues')}
        value={options.emptyValues.filter((value) => value !== '').join(', ')}
        onChange={(text) => set({ emptyValues: ['', ...words(text)] })}
        description={t('imports.empty.hint')}
      />
    </div>
  )
}

type MappingRow = { target: string; reference: string }

function referenceValue(entry: ImportColumnMapping): string {
  if (entry.reference === undefined) return 'value'
  return entry.reference.via === 'display' ? 'display' : `unique:${entry.reference.column}`
}

export function ImportPage() {
  const params: { importId?: string } = useParams({ strict: false })
  const importId = params.importId ?? ''
  const job = useQuery({
    queryKey: jobKey(importId),
    queryFn: () => api<ImportJob>('GET', `/internal/imports/${importId}`),
    refetchInterval: (query) =>
      query.state.data?.status === 'checking' || query.state.data?.status === 'importing'
        ? 1000
        : false,
  })
  if (job.data === undefined) return null
  // The saved settings start the form; later loads only update status and results.
  return <ImportEditor key={job.data.id} job={job.data} />
}

function ImportEditor(props: { job: ImportJob }) {
  const t = useT()
  const errors = useErrorText()
  const cellText = useCellText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const importId = props.job.id
  const saved = props.job.mapping
  const targets = useQuery({
    queryKey: ['design', 'imports', 'targets'],
    queryFn: () => api<{ data: ImportTarget[] }>('GET', '/internal/imports/targets'),
  })
  const preview = useQuery({
    queryKey: [...jobKey(importId), 'preview'],
    queryFn: () => api<ImportPreview>('GET', `/internal/imports/${importId}/preview`),
    enabled: props.job.status !== 'completed',
  })
  const [options, setOptions] = useState<ImportParseOptions>(props.job.options)
  const [tableAccessId, setTableAccessId] = useState(saved?.tableAccessId ?? '')
  const [mode, setMode] = useState<ImportMode>(saved?.mode ?? 'insert')
  const [upsertKey, setUpsertKey] = useState((saved?.upsertKey ?? []).join(','))
  const newTable = props.job.newTable
  const isAdmin = useUser().systemRole === 'admin'
  const [skipFailed, setSkipFailed] = useState(saved?.skipFailed ?? newTable?.skipFailed ?? false)
  // A table to create from the file (E28), admins only.
  const [definition, setDefinition] = useState<NewTableDefinition | null>(
    newTable?.definition ?? null,
  )
  const [suggesting, setSuggesting] = useState<unknown>(null)
  const connections = useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: () => api<{ data: Connection[] }>('GET', '/internal/admin/connections'),
    enabled: isAdmin,
  })
  const schemaConnections = (connections.data?.data ?? []).filter((connection) =>
    connection.credentials.some((credential) => credential.purpose === 'schema'),
  )
  const created = newTable !== null && newTable.createdAt !== null
  const [mapping, setMapping] = useState<Record<number, MappingRow>>(
    Object.fromEntries(
      (saved?.columns ?? []).map((entry) => [
        entry.source,
        { target: entry.target, reference: referenceValue(entry) },
      ]),
    ),
  )

  const target = targets.data?.data.find((entry) => entry.tableAccessId === tableAccessId)
  const [choosingNew, setChoosingNew] = useState(newTable !== null)
  const newMode = choosingNew || definition !== null
  const suggest = async (connectionId: string) => {
    setSuggesting(null)
    try {
      setDefinition(
        await api<NewTableDefinition>(
          'GET',
          `/internal/imports/${importId}/new-table?connectionId=${connectionId}`,
        ),
      )
    } catch (failure) {
      setSuggesting(failure)
    }
  }
  const choose = async (id: string) => {
    if (id === newTableChoice) {
      setTableAccessId('')
      const [first] = schemaConnections
      if (first !== undefined) await suggest(first.id)
      else setDefinition(null)
      setChoosingNew(true)
      return
    }
    setChoosingNew(false)
    setDefinition(null)
    setTableAccessId(id)
    const chosen = await api<ImportTarget & { suggestedMapping: ImportColumnMapping[] }>(
      'GET',
      `/internal/imports/${importId}/targets/${id}`,
    )
    setMode(chosen.modes[0] ?? 'insert')
    setUpsertKey(chosen.upsertKeys[0]?.join(',') ?? '')
    setMapping(
      Object.fromEntries(
        chosen.suggestedMapping.map((entry) => [
          entry.source,
          { target: entry.target, reference: 'value' },
        ]),
      ),
    )
  }

  const settings = (): {
    options: ImportParseOptions
    mapping: ImportMapping | null
    newTable: { definition: NewTableDefinition; skipFailed: boolean } | null
  } => ({
    options: options,
    newTable: newMode && definition !== null ? { definition, skipFailed } : null,
    mapping:
      newMode || tableAccessId === ''
        ? null
        : {
            tableAccessId,
            mode,
            upsertKey: mode === 'upsert' && upsertKey !== '' ? upsertKey.split(',') : null,
            skipFailed,
            columns: Object.entries(mapping)
              .filter(([, row]) => row.target !== '')
              .map(([source, row]) => ({
                source: Number(source),
                target: row.target,
                ...(row.reference === 'display' && { reference: { via: 'display' as const } }),
                ...(row.reference.startsWith('unique:') && {
                  reference: {
                    via: 'unique' as const,
                    column: row.reference.slice('unique:'.length),
                  },
                }),
              })),
          },
  })
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: jobKey(importId) })
  }
  const data = props.job
  const save = useMutation({
    mutationFn: () => api<ImportJob>('PUT', `/internal/imports/${importId}`, settings()),
    onSuccess: refresh,
  })
  const step = useMutation({
    mutationFn: async (action: 'dry-run' | 'run' | 'cancel') => {
      if (action !== 'cancel') await api('PUT', `/internal/imports/${importId}`, settings())
      return api<ImportJob>('POST', `/internal/imports/${importId}/${action}`)
    },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/imports/${importId}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: jobsKey })
      await navigate({ to: '/design/imports' })
    },
  })

  /** Why the last dry run or import stopped, in words; a created table is said, too. */
  const failureText = (failure: NonNullable<ImportJob['failure']>) => {
    const first = failure.errors?.[0]
    const line = first?.params?.line
    let text: string
    if (failure.code === 'cancelled') text = t('imports.failed.cancelled')
    else if (failure.code === 'interrupted') text = t('imports.failed.interrupted')
    else if (failure.code === 'import_stopped' && first !== undefined) {
      text = t('imports.failed.stopped', {
        line: String(line ?? '–'),
        reason: cellText({ line: Number(line ?? 0), column: first.field, code: first.code }),
      })
    } else {
      const reason = errors.code(first?.code ?? failure.code)
      text = t(failure.phase === 'dry_run' ? 'imports.failed.dryRun' : 'imports.failed.other', {
        reason,
      })
    }
    if (failure.phase !== 'dry_run' && newTable !== null && newTable.createdAt !== null) {
      text = `${text} ${t('imports.failed.tableCreated', { name: newTable.definition.name })}`
    }
    return text
  }
  const running = data.status === 'checking' || data.status === 'importing'
  const done = data.status === 'completed'
  const error = save.error ?? step.error ?? remove.error
  const columns = preview.data?.columns ?? []
  const errorAt = (line: number, column: string) =>
    preview.data?.errors.find((entry) => entry.line === line && entry.column === column)
  const headerLines = options.header ? 1 : 0
  const mappedTo = (source: number) => mapping[source]?.target ?? ''
  const dryRun = data.dryRun
  const canImport =
    data.status === 'checked' && dryRun !== null && (dryRun.counts.failed === 0 || skipFailed)

  return (
    <>
      <PageHeader
        title={data.fileName}
        actions={<Badge tone={statusTones[data.status]}>{t(statusLabels[data.status])}</Badge>}
      />
      {error !== null && errors.message(error) !== undefined && (
        <Notice tone="error">{errors.message(error)}</Notice>
      )}
      {data.failure !== null && <Notice tone="error">{failureText(data.failure)}</Notice>}
      {done && newTable?.outcome !== null && newTable?.outcome !== undefined && (
        <Section title={t('imports.newTable.outcome')}>
          <NewTableOutcomeView outcome={newTable.outcome} />
        </Section>
      )}
      {done && data.result !== null && (
        <Notice tone="success">
          {t('imports.done', {
            created: data.result.created,
            updated: data.result.updated,
            unchanged: data.result.unchanged,
            skipped: data.result.skipped,
          })}
        </Notice>
      )}
      {!done && (
        <>
          <Section title={t('imports.step.format')}>
            <OptionsForm options={options} onChange={setOptions} />
          </Section>
          <Section title={t('imports.step.target')}>
            <div className={styles.grid}>
              <SelectField
                label={t('imports.table')}
                value={newMode ? newTableChoice : tableAccessId}
                onChange={(id) => void choose(id)}
                options={[
                  { id: '', label: t('imports.table.choose') },
                  ...(targets.data?.data ?? []).map((entry) => ({
                    id: entry.tableAccessId,
                    label: entry.objectName,
                  })),
                  ...(isAdmin ? [{ id: newTableChoice, label: t('imports.table.new') }] : []),
                ]}
              />
              {newMode && (
                <SelectField
                  label={t('imports.connection')}
                  value={definition?.connectionId ?? ''}
                  onChange={(id) => void suggest(id)}
                  description={t('imports.connection.hint')}
                  options={[
                    { id: '', label: t('imports.connection.choose') },
                    ...schemaConnections.map((connection) => ({
                      id: connection.id,
                      label: connection.name,
                    })),
                  ]}
                />
              )}
              {target !== undefined && (
                <SelectField
                  label={t('imports.mode')}
                  value={mode}
                  onChange={setMode}
                  options={target.modes.map((id) => ({
                    id,
                    label: t(id === 'insert' ? 'imports.mode.insert' : 'imports.mode.upsert'),
                  }))}
                />
              )}
              {target !== undefined && mode === 'upsert' && (
                <SelectField
                  label={t('imports.upsertKey')}
                  value={upsertKey}
                  onChange={setUpsertKey}
                  error={errors.field(save.error ?? step.error, 'mapping.upsertKey')}
                  options={target.upsertKeys.map((key) => ({
                    id: key.join(','),
                    label: key.join(', '),
                  }))}
                />
              )}
              <SwitchField
                label={t('imports.skipFailed')}
                description={t('imports.skipFailed.hint')}
                isSelected={skipFailed}
                onChange={setSkipFailed}
              />
            </div>
          </Section>
          {newMode && (
            <Section title={t('imports.step.newTable')}>
              {schemaConnections.length === 0 && (
                <Notice tone="info">{t('imports.newTable.noSchemaUser')}</Notice>
              )}
              {suggesting !== null && <Notice tone="error">{errors.message(suggesting)}</Notice>}
              {created && <Notice tone="info">{t('imports.newTable.created')}</Notice>}
              {definition !== null && (
                <TableDefinitionEditor
                  definition={definition}
                  onChange={(next) => {
                    if (!created) setDefinition(next)
                  }}
                  sources={columns}
                  error={save.error ?? step.error}
                  prefix="newTable.definition."
                />
              )}
              <Actions>
                <Button
                  onPress={() => save.mutate()}
                  isDisabled={save.isPending || running || definition === null}
                >
                  {t('imports.check')}
                </Button>
              </Actions>
            </Section>
          )}
          {target !== undefined && !newMode && (
            <Section title={t('imports.step.mapping')}>
              <ScrollArea>
                <table className={table.table}>
                  <thead>
                    <tr>
                      <th>{t('imports.csvColumn')}</th>
                      <th>{t('imports.tableColumn')}</th>
                      <th>{t('imports.resolve')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((name, source) => {
                      const column = target.columns.find((entry) => entry.name === mappedTo(source))
                      return (
                        <tr key={source}>
                          <td>{name}</td>
                          <td>
                            <SelectField
                              label={t('imports.tableColumn.of', { column: name })}
                              isLabelHidden
                              value={mappedTo(source)}
                              onChange={(value) =>
                                setMapping((current) => ({
                                  ...current,
                                  [source]: { target: value, reference: 'value' },
                                }))
                              }
                              options={[
                                { id: '', label: t('imports.skip') },
                                ...target.columns
                                  .filter((entry) => entry.insertable)
                                  .map((entry) => ({
                                    id: entry.name,
                                    label: entry.required ? `${entry.name} *` : entry.name,
                                  })),
                              ]}
                            />
                          </td>
                          <td>
                            {column?.reference !== undefined && (
                              <SelectField
                                label={t('imports.resolve.of', { column: column.name })}
                                isLabelHidden
                                value={mapping[source]?.reference ?? 'value'}
                                onChange={(reference) =>
                                  setMapping((current) => ({
                                    ...current,
                                    [source]: { target: column.name, reference },
                                  }))
                                }
                                options={[
                                  { id: 'value', label: t('imports.resolve.value') },
                                  ...column.reference.uniqueColumns.map((unique) => ({
                                    id: `unique:${unique}`,
                                    label: t('imports.resolve.unique', {
                                      object: column.reference?.object ?? '',
                                      column: unique,
                                    }),
                                  })),
                                  { id: 'display', label: t('imports.resolve.display') },
                                ]}
                              />
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </ScrollArea>
              {(save.error ?? step.error) !== null &&
                errors.field(save.error ?? step.error, 'mapping.columns') !== undefined && (
                  <p className={styles.danger}>{t('imports.requiredMissing')}</p>
                )}
              <Actions>
                <Button onPress={() => save.mutate()} isDisabled={save.isPending || running}>
                  {t('imports.check')}
                </Button>
              </Actions>
            </Section>
          )}
          <Section title={t('imports.step.preview')}>
            <ScrollArea>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th>{t('imports.line')}</th>
                    {columns.map((name, index) => (
                      <th key={index}>
                        {name}
                        {mappedTo(index) !== '' && (
                          <span className={table.muted}> → {mappedTo(index)}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(preview.data?.rows ?? []).slice(0, 20).map((row, index) => {
                    const line = index + 1 + headerLines
                    return (
                      <tr key={index}>
                        <td className={table.muted}>{line}</td>
                        {columns.map((_, source) => {
                          const problem = errorAt(line, mappedTo(source))
                          return (
                            <td
                              key={source}
                              className={problem === undefined ? undefined : styles.danger}
                              title={problem === undefined ? undefined : cellText(problem)}
                            >
                              {row[source] ?? ''}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollArea>
          </Section>
          <Section title={t('imports.step.run')}>
            {running && data.progress !== null && (
              <Notice tone="info">
                {t(
                  data.progress.phase === 'checking'
                    ? 'imports.progress.check'
                    : 'imports.progress.import',
                  {
                    rows: data.progress.rows,
                  },
                )}
              </Notice>
            )}
            {dryRun !== null && (
              <>
                <p>
                  {t('imports.dryRun.counts', {
                    rows: dryRun.counts.rows,
                    created: dryRun.counts.created,
                    updated: dryRun.counts.updated,
                    unchanged: dryRun.counts.unchanged,
                    failed: dryRun.counts.failed,
                  })}
                </p>
                {dryRun.errors.length > 0 && (
                  <ul>
                    {dryRun.errors.slice(0, 10).map((entry, index) => (
                      <li key={index}>
                        {t('imports.error.line', { line: entry.line, column: entry.column })}{' '}
                        {cellText(entry)}
                      </li>
                    ))}
                  </ul>
                )}
                {dryRun.counts.failed > 0 && (
                  <Button
                    variant="ghost"
                    onPress={() =>
                      void downloadGet(`/internal/imports/${importId}/errors`, 'import-errors.csv')
                    }
                  >
                    {t('imports.errors.download')}
                  </Button>
                )}
                {dryRun.counts.failed > 0 && !skipFailed && (
                  <Notice tone="info">{t('imports.dryRun.failedHint')}</Notice>
                )}
              </>
            )}
            <Actions>
              {running ? (
                <Button onPress={() => step.mutate('cancel')}>{t('imports.cancel')}</Button>
              ) : (
                <>
                  <Button
                    onPress={() => step.mutate('dry-run')}
                    isDisabled={step.isPending || (tableAccessId === '' && definition === null)}
                  >
                    {t('imports.dryRun')}
                  </Button>
                  <Button
                    variant="primary"
                    onPress={() => step.mutate('run')}
                    isDisabled={step.isPending || !canImport}
                  >
                    {t('imports.run')}
                  </Button>
                </>
              )}
            </Actions>
          </Section>
        </>
      )}
      <Actions>
        <Button
          variant="ghost"
          onPress={() => remove.mutate()}
          isDisabled={running || remove.isPending}
        >
          {t('imports.remove')}
        </Button>
      </Actions>
    </>
  )
}
