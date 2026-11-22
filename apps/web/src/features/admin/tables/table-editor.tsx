// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  FieldError,
  NewColumnTypeName,
  NewTableColumn,
  NewTableDefinition,
  NewTableOutcome,
} from '@stashley/shared'
import { checkNewTable, newColumnTypes, normalizeName, uniqueNames } from '@stashley/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Button,
  CheckboxField,
  CopyField,
  Dialog,
  Form,
  Notice,
  SelectField,
  TextField,
} from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import styles from '../connections/connections.module.css'
import { ScrollArea } from '../../../ui/scroll-area.tsx'

const typeLabels: Record<NewColumnTypeName, MessageId> = {
  int: 'tables.type.int',
  bigint: 'tables.type.bigint',
  decimal: 'tables.type.decimal',
  boolean: 'tables.type.boolean',
  date: 'tables.type.date',
  datetime: 'tables.type.datetime',
  varchar: 'tables.type.varchar',
  text: 'tables.type.text',
}

const problemLabels: Record<string, MessageId> = {
  invalid_name: 'tables.problem.invalidName',
  taken: 'tables.problem.taken',
  duplicate: 'tables.problem.duplicate',
  not_indexable: 'tables.problem.notIndexable',
  too_long_for_key: 'tables.problem.tooLongForKey',
  row_too_large: 'tables.problem.rowTooLarge',
  out_of_range: 'tables.problem.outOfRange',
  not_supported: 'tables.problem.notSupported',
  too_long: 'tables.problem.tooLong',
  unknown_column: 'tables.problem.unknownColumn',
  default_not_allowed: 'tables.problem.defaultNotAllowed',
  required: 'tables.problem.required',
  invalid: 'tables.problem.invalid',
  no_schema_user: 'tables.problem.noSchemaUser',
}

/** A column with the size fields its type needs, and none it does not. */
function withType(column: NewTableColumn, type: NewColumnTypeName): NewTableColumn {
  const {
    length: _length,
    precision: _precision,
    scale: _scale,
    caseSensitive: _caseSensitive,
    ...rest
  } = column
  void _length
  void _precision
  void _scale
  void _caseSensitive
  return {
    ...rest,
    type,
    // Only text compares by case; a column that stays text keeps the choice.
    ...((type === 'varchar' || type === 'text') &&
      column.caseSensitive === true && { caseSensitive: true }),
    ...(type === 'varchar' && { length: column.length ?? 255 }),
    ...(type === 'decimal' && { precision: column.precision ?? 10, scale: column.scale ?? 2 }),
    default: type === 'text' ? null : column.default,
  }
}

const number = (text: string) => (/^\d{1,5}$/.test(text) ? Number(text) : 0)

/**
 * Edits the definition of a new table (E28): name, primary key and columns with type, size,
 * required, unique and default. Problems show at their fields as the shared checks find them;
 * the server checks the same again.
 */
export function TableDefinitionEditor(props: {
  definition: NewTableDefinition
  onChange: (definition: NewTableDefinition) => void
  /** CSV column names when the table is filled from a file. */
  sources?: string[] | undefined
  /** A server error whose field paths start with `prefix`. */
  error?: unknown
  prefix?: string
}) {
  const t = useT()
  const { definition } = props
  const local = checkNewTable(definition, {
    taken: [],
    sourceCount: props.sources?.length,
  })
  const server =
    props.error instanceof ApiError
      ? props.error.errors
          .filter((entry) => entry.field.startsWith(props.prefix ?? ''))
          .map((entry) => ({ ...entry, field: entry.field.slice((props.prefix ?? '').length) }))
      : []
  // An empty name is not a mistake yet; creating stays disabled until it is filled.
  const problems: FieldError[] = [
    ...local.filter((entry) => !(entry.field === 'name' && definition.name === '')),
    ...server,
  ]
  const problem = (field: string) => {
    const found = problems.find((entry) => entry.field === field)
    return found === undefined
      ? undefined
      : t(problemLabels[found.code] ?? 'tables.problem.invalid', {
          max: String(found.params?.max ?? ''),
        })
  }
  const columnProblem = (index: number) =>
    ['name', 'source', 'type', 'length', 'precision', 'scale', 'default']
      .map((field) => problem(`columns.${index}.${field}`))
      .find((message) => message !== undefined)
  const set = (patch: Partial<NewTableDefinition>) => props.onChange({ ...definition, ...patch })
  const setColumn = (index: number, column: NewTableColumn) =>
    set({ columns: definition.columns.map((entry, at) => (at === index ? column : entry)) })
  const key = definition.primaryKey
  const keyChoice = key.kind === 'added' ? '__added' : key.column

  return (
    <div className={styles.block}>
      <div className={styles.grid}>
        <TextField
          label={t('tables.name')}
          value={definition.name}
          onChange={(name) => set({ name })}
          error={problem('name')}
          description={t('tables.name.hint')}
        />
        <SelectField
          label={t('tables.primaryKey')}
          value={keyChoice}
          onChange={(value) =>
            set({
              primaryKey:
                value === '__added'
                  ? { kind: 'added', name: key.kind === 'added' ? key.name : 'id' }
                  : { kind: 'column', column: value },
            })
          }
          error={problem('primaryKey.column') ?? problem('primaryKey.name')}
          description={t('tables.primaryKey.hint')}
          options={[
            { id: '__added', label: t('tables.primaryKey.added') },
            ...definition.columns
              .filter((column) => column.type !== 'text')
              .map((column) => ({ id: column.name, label: column.name })),
          ]}
        />
        {key.kind === 'added' && (
          <TextField
            label={t('tables.primaryKey.name')}
            value={key.name}
            onChange={(name) => set({ primaryKey: { kind: 'added', name } })}
            error={problem('primaryKey.name')}
          />
        )}
      </div>
      {problem('columns') !== undefined && <p className={styles.danger}>{problem('columns')}</p>}
      <ScrollArea>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('tables.column')}</th>
              {props.sources !== undefined && <th>{t('imports.csvColumn')}</th>}
              <th>{t('tables.type')}</th>
              <th>{t('tables.size')}</th>
              <th>{t('tables.required')}</th>
              <th>{t('tables.unique')}</th>
              <th>{t('tables.caseSensitive')}</th>
              <th>{t('tables.default')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {definition.columns.map((column, index) => {
              const isKey = key.kind === 'column' && key.column === column.name
              const message = columnProblem(index)
              return (
                <tr key={index}>
                  <td>
                    <TextField
                      label={t('tables.column.of', { index: index + 1 })}
                      isLabelHidden
                      value={column.name}
                      onChange={(name) => setColumn(index, { ...column, name })}
                      error={message}
                    />
                  </td>
                  {props.sources !== undefined && (
                    <td>
                      <SelectField
                        label={t('tables.source.of', { column: column.name })}
                        isLabelHidden
                        value={column.source === null ? '' : String(column.source)}
                        onChange={(value) =>
                          setColumn(index, {
                            ...column,
                            source: value === '' ? null : Number(value),
                          })
                        }
                        options={[
                          { id: '', label: t('tables.source.none') },
                          ...props.sources.map((name, source) => ({
                            id: String(source),
                            label: name,
                          })),
                        ]}
                      />
                    </td>
                  )}
                  <td>
                    <SelectField
                      label={t('tables.type.of', { column: column.name })}
                      isLabelHidden
                      value={column.type}
                      onChange={(type) => setColumn(index, withType(column, type))}
                      options={newColumnTypes.map((id) => ({ id, label: t(typeLabels[id]) }))}
                    />
                  </td>
                  <td>
                    {column.type === 'varchar' && (
                      <TextField
                        label={t('tables.length.of', { column: column.name })}
                        isLabelHidden
                        inputMode="numeric"
                        value={String(column.length ?? '')}
                        onChange={(text) => setColumn(index, { ...column, length: number(text) })}
                      />
                    )}
                    {column.type === 'decimal' && (
                      <div className={styles.checks}>
                        <TextField
                          label={t('tables.precision.of', { column: column.name })}
                          isLabelHidden
                          inputMode="numeric"
                          value={String(column.precision ?? '')}
                          onChange={(text) =>
                            setColumn(index, { ...column, precision: number(text) })
                          }
                        />
                        <TextField
                          label={t('tables.scale.of', { column: column.name })}
                          isLabelHidden
                          inputMode="numeric"
                          value={String(column.scale ?? '')}
                          onChange={(text) => setColumn(index, { ...column, scale: number(text) })}
                        />
                      </div>
                    )}
                  </td>
                  <td>
                    <CheckboxField
                      isLabelHidden
                      label={t('tables.required.of', { column: column.name })}
                      isSelected={column.required || isKey}
                      isDisabled={isKey}
                      onChange={(required) => setColumn(index, { ...column, required })}
                    />
                  </td>
                  <td>
                    <CheckboxField
                      isLabelHidden
                      label={t('tables.unique.of', { column: column.name })}
                      isSelected={column.unique || isKey}
                      isDisabled={isKey || column.type === 'text'}
                      onChange={(unique) => setColumn(index, { ...column, unique })}
                    />
                  </td>
                  <td>
                    {(column.type === 'varchar' || column.type === 'text') && (
                      <CheckboxField
                        isLabelHidden
                        label={t('tables.caseSensitive.of', { column: column.name })}
                        isSelected={column.caseSensitive === true}
                        onChange={(caseSensitive) => setColumn(index, { ...column, caseSensitive })}
                      />
                    )}
                  </td>
                  <td>
                    {column.type !== 'text' && !isKey && (
                      <>
                        <TextField
                          label={t('tables.default.of', { column: column.name })}
                          isLabelHidden
                          value={column.default?.kind === 'value' ? column.default.value : ''}
                          onChange={(value) =>
                            setColumn(index, {
                              ...column,
                              default: value === '' ? null : { kind: 'value', value },
                            })
                          }
                        />
                        {column.type === 'datetime' && (
                          <CheckboxField
                            label={t('tables.default.now')}
                            isSelected={column.default?.kind === 'now'}
                            onChange={(now) =>
                              setColumn(index, { ...column, default: now ? { kind: 'now' } : null })
                            }
                          />
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {props.sources === undefined && definition.columns.length > 1 && (
                      <Button
                        variant="ghost"
                        onPress={() =>
                          set({ columns: definition.columns.filter((_, at) => at !== index) })
                        }
                      >
                        {t('tables.column.remove')}
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollArea>
      <p className={styles.muted}>{t('tables.hint')}</p>
      <p className={styles.muted}>{t('tables.caseSensitive.hint')}</p>
      {props.sources === undefined && (
        <Actions>
          <Button
            onPress={() => {
              const [name = 'spalte'] = uniqueNames(
                [normalizeName(t('tables.column.newName'))],
                definition.columns.map((column) => column.name),
              )
              set({
                columns: [
                  ...definition.columns,
                  {
                    name,
                    source: null,
                    type: 'varchar',
                    length: 255,
                    required: false,
                    unique: false,
                    default: null,
                  },
                ],
              })
            }}
          >
            {t('tables.column.add')}
          </Button>
        </Actions>
      )}
    </div>
  )
}

/** What creating a table left: the statement, and the grants the read user still needs. */
export function NewTableOutcomeView(props: { outcome: NewTableOutcome }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const [state, setState] = useState(props.outcome)
  const check = useMutation({
    mutationFn: () =>
      api<Pick<NewTableOutcome, 'readable' | 'statements'>>(
        'POST',
        `/internal/admin/tables/${state.tableAccessId ?? ''}/check`,
      ),
    onSuccess: async (result) => {
      setState((current) => ({ ...current, ...result }))
      await client.invalidateQueries({ queryKey: ['admin'] })
    },
  })
  return (
    <div className={styles.block}>
      {state.readable ? (
        <Notice tone="success">{t('tables.outcome.readable')}</Notice>
      ) : (
        <>
          <Notice tone="info">{t('tables.outcome.pending')}</Notice>
          {state.statements.map((entry, index) => (
            <CopyField key={index} label={t('tables.outcome.statement')} value={entry.statement} />
          ))}
          {check.error !== null && <Notice tone="error">{errors.message(check.error)}</Notice>}
          {state.tableAccessId !== null && (
            <Actions>
              <Button onPress={() => check.mutate()} isDisabled={check.isPending}>
                {t('tables.outcome.check')}
              </Button>
            </Actions>
          )}
        </>
      )}
      <details>
        <summary>{t('tables.outcome.ddl')}</summary>
        <pre className={table.mono}>{state.ddl}</pre>
      </details>
    </div>
  )
}

/** The table designer (E28): a new, empty table on a connection with a schema user. */
export function NewTableDialog(props: { connectionId: string; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const [definition, setDefinition] = useState<NewTableDefinition>({
    connectionId: props.connectionId,
    name: '',
    primaryKey: { kind: 'added', name: 'id' },
    columns: [
      {
        name: 'name',
        source: null,
        type: 'varchar',
        length: 255,
        required: true,
        unique: false,
        default: null,
      },
    ],
  })
  const create = useMutation({
    mutationFn: () => api<NewTableOutcome>('POST', '/internal/admin/tables', definition),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'connection', props.connectionId] })
    },
  })
  const valid = checkNewTable(definition, { taken: [] }).length === 0
  return (
    <Dialog title={t('tables.new')} isOpen isWide onOpenChange={(open) => !open && props.onClose()}>
      {create.data !== undefined ? (
        <>
          <NewTableOutcomeView outcome={create.data} />
          <Actions>
            <Button variant="primary" onPress={props.onClose}>
              {t('action.done')}
            </Button>
          </Actions>
        </>
      ) : (
        <Form onSubmit={() => create.mutate()}>
          {create.error !== null && errors.message(create.error) !== undefined && (
            <Notice tone="error">{errors.message(create.error)}</Notice>
          )}
          <p className={styles.muted}>{t('tables.new.intro')}</p>
          <TableDefinitionEditor
            definition={definition}
            onChange={setDefinition}
            error={create.error}
          />
          <Notice tone="info">{t('tables.new.irreversible')}</Notice>
          <Actions>
            <Button onPress={props.onClose}>{t('action.cancel')}</Button>
            <Button type="submit" variant="primary" isDisabled={!valid || create.isPending}>
              {t('tables.create')}
            </Button>
          </Actions>
        </Form>
      )}
    </Dialog>
  )
}
