// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AfterSave,
  DetailTable,
  BaseFilterCondition,
  DesignCatalog,
  DesignCatalogObject,
  EditOp,
  FieldDefault,
  FormComponent,
  FormField,
  PageDocument,
  TableConfig,
  TableEditing,
} from '@stashley/shared'
import { baseFilterOperators, editOps, parseDateExpression, widgetsFor } from '@stashley/shared'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
import { Button, CheckboxField, SelectField, SwitchField, TextField } from '../../ui/controls.tsx'
import { useCatalog, usePages, useTableObject, useVariables } from '../design/design-api.ts'
import styles from './editor.module.css'

/**
 * Settings of forms and table editing in the block dialog (§ Formulare, § Tabellenseiten): the
 * fields per column, defaults and generated values, foreign key selections, base filters, the
 * record of edit mode, the upsert key and what happens after saving. The server checks every
 * setting when the draft is saved; its issues show in the dialog.
 */

const none = '__none__'

type FieldChoice = 'omit' | 'input' | 'auto'

const widgetLabels: Record<string, MessageId> = {
  text: 'editor.widget.text',
  textarea: 'editor.widget.textarea',
  number: 'editor.widget.number',
  switch: 'editor.widget.switch',
  date: 'editor.widget.date',
  datetime: 'editor.widget.datetime',
  time: 'editor.widget.time',
  year: 'editor.widget.year',
  select: 'editor.widget.select',
  multiselect: 'editor.widget.multiselect',
  reference: 'editor.widget.reference',
}

const dateKinds = new Set(['date', 'datetime', 'timestamp'])

function nextId(used: readonly string[], base: string): string {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[^a-z0-9]+/, '') || 'f'
  let id = clean.slice(0, 36)
  let n = 2
  while (used.includes(id)) id = `${clean.slice(0, 33)}-${n++}`
  return id
}

/** Where a value can come from: the page's filters and URL parameters. */
function inputOptions(document: PageDocument, t: ReturnType<typeof useT>) {
  return [
    ...document.filters.map((filter) => ({
      id: `filter:${filter.id}`,
      label: t('editor.default.filter', { name: filter.label || filter.id }),
    })),
    ...document.parameters.map((parameter) => ({
      id: `url:${parameter.name}`,
      label: t('editor.default.url', { name: parameter.name }),
    })),
  ]
}

function DefaultEditor(props: {
  value: FieldDefault | undefined
  onChange: (value: FieldDefault | undefined) => void
  document: PageDocument
  label: string
}) {
  const t = useT()
  const variables = useVariables()
  const value = props.value
  const kind =
    value === undefined
      ? none
      : value.kind === 'filter'
        ? `filter:${value.filterId}`
        : value.kind === 'url'
          ? `url:${value.name}`
          : value.kind === 'user'
            ? `user:${value.field}`
            : value.kind === 'variable'
              ? `variable:${value.name}`
              : 'constant'
  return (
    <div className={styles.inline}>
      <SelectField
        label={props.label}
        value={kind}
        onChange={(next) => {
          if (next === none) return props.onChange(undefined)
          if (next === 'constant') return props.onChange({ kind: 'constant', value: '' })
          const [source, name = ''] = next.split(/:(.*)/s)
          if (source === 'filter') props.onChange({ kind: 'filter', filterId: name })
          else if (source === 'url') props.onChange({ kind: 'url', name })
          else if (source === 'user')
            props.onChange({ kind: 'user', field: name === 'email' ? 'email' : 'id' })
          else props.onChange({ kind: 'variable', name })
        }}
        options={[
          { id: none, label: t('editor.default.none') },
          { id: 'constant', label: t('editor.default.constant') },
          ...(variables.data ?? []).map((variable) => ({
            id: `variable:${variable.name}`,
            label: t('editor.default.variable', { name: variable.name }),
          })),
          { id: 'user:id', label: t('editor.default.userId') },
          { id: 'user:email', label: t('editor.default.userEmail') },
          ...inputOptions(props.document, t),
        ]}
      />
      {value?.kind === 'constant' && (
        <TextField
          label={t('editor.default.value')}
          value={Array.isArray(value.value) ? value.value.join(',') : String(value.value)}
          onChange={(text) => props.onChange({ kind: 'constant', value: text })}
        />
      )}
    </div>
  )
}

/** One column of the object as a field: not included, an input, or automatic. */
function FieldRow(props: {
  column: DesignCatalogObject['columns'][number]
  field: FormField | undefined
  index: number
  relation: boolean
  target: DesignCatalogObject | undefined
  document: PageDocument
  onChange: (field: FormField | undefined) => void
  used: readonly string[]
}) {
  const t = useT()
  const { column, field } = props
  const choice: FieldChoice =
    field === undefined ? 'omit' : field.kind === 'generated' ? 'auto' : 'input'
  const autoPossible = column.autoIncrement || dateKinds.has(column.kind)
  const widgets = widgetsFor(
    column.kind,
    column.kind === 'string' ? 'varchar' : column.kind,
    props.relation,
  )
  const set = (patch: Partial<FormField>) => {
    if (field !== undefined) props.onChange({ ...field, ...patch } as FormField)
  }
  const choose = (next: FieldChoice) => {
    const id = field?.id ?? nextId(props.used, column.name)
    if (next === 'omit') return props.onChange(undefined)
    if (next === 'auto') {
      return props.onChange({
        kind: 'generated',
        id,
        column: column.name,
        generator: column.autoIncrement
          ? { kind: 'auto_increment' }
          : { kind: 'date', expression: 'now', editable: false },
      })
    }
    props.onChange({ kind: 'input', id, column: column.name, required: false, hidden: false })
  }
  return (
    <div className={styles.fieldRow}>
      <SelectField
        label={column.name + (column.required ? ' *' : '')}
        value={choice}
        onChange={choose}
        options={[
          { id: 'omit', label: t('editor.field.omit') },
          ...(column.autoIncrement
            ? []
            : [{ id: 'input' as const, label: t('editor.field.input') }]),
          ...(autoPossible ? [{ id: 'auto' as const, label: t('editor.field.auto') }] : []),
        ]}
      />
      {field !== undefined && (
        <TextField
          label={t('editor.field.label')}
          value={field.label ?? ''}
          onChange={(label) => set({ label: label === '' ? undefined : label })}
        />
      )}
      {field?.kind === 'input' && widgets.length > 1 && (
        <SelectField
          label={t('editor.field.widget')}
          value={field.widget ?? widgets[0] ?? 'text'}
          onChange={(widget) => set({ widget })}
          options={widgets.map((widget) => ({
            id: widget,
            label: t(widgetLabels[widget] ?? 'editor.widget.text'),
          }))}
        />
      )}
      {field?.kind === 'input' && (
        <>
          <DefaultEditor
            label={t('editor.field.default')}
            value={field.default}
            document={props.document}
            onChange={(value) =>
              props.onChange({
                ...field,
                default: value,
                hidden: value === undefined ? false : field.hidden,
              })
            }
          />
          <div className={styles.checks}>
            <CheckboxField
              label={t('editor.field.required')}
              isSelected={field.required || column.required}
              isDisabled={column.required}
              onChange={(required) => set({ required })}
            />
            <CheckboxField
              label={t('editor.field.hidden')}
              isSelected={field.hidden}
              isDisabled={field.default === undefined}
              onChange={(hidden) => set({ hidden })}
            />
          </div>
          {(field.widget ?? widgets[0]) === 'reference' && props.target !== undefined && (
            <SelectField
              label={t('editor.field.searchColumn')}
              value={field.reference?.searchColumns[0] ?? none}
              onChange={(searchColumn) =>
                set({
                  reference: {
                    target: props.target?.name ?? '',
                    searchColumns: searchColumn === none ? [] : [searchColumn],
                    extras: field.reference?.extras ?? [],
                  },
                })
              }
              options={[
                { id: none, label: t('editor.field.searchLabel') },
                ...props.target.columns.map((entry) => ({ id: entry.name, label: entry.name })),
              ]}
            />
          )}
        </>
      )}
      {field?.kind === 'generated' && field.generator.kind === 'date' && (
        <div className={styles.inline}>
          <TextField
            label={t('editor.field.expression')}
            value={field.generator.expression}
            description={t('editor.field.expressionHint')}
            error={
              parseDateExpression(field.generator.expression) === undefined
                ? t('issue.invalid_expression')
                : undefined
            }
            onChange={(expression) =>
              props.onChange({
                ...field,
                generator: {
                  ...field.generator,
                  kind: 'date',
                  expression,
                  editable: field.generator.kind === 'date' && field.generator.editable,
                },
              })
            }
          />
          <CheckboxField
            label={t('editor.field.editable')}
            isSelected={field.generator.editable}
            onChange={(editable) =>
              props.onChange({
                ...field,
                generator: {
                  kind: 'date',
                  expression: field.generator.kind === 'date' ? field.generator.expression : 'now',
                  editable,
                },
              })
            }
          />
        </div>
      )}
    </div>
  )
}

/** The fields of a form or of table editing, one row per writable column. */
export function FieldListEditor(props: {
  object: DesignCatalogObject
  catalog: DesignCatalog
  fields: readonly FormField[]
  document: PageDocument
  onChange: (fields: FormField[]) => void
}) {
  const t = useT()
  const relations = props.catalog.relations.filter(
    (relation) => relation.sourceObject === props.object.name,
  )
  const columns = props.object.columns.filter((column) => column.writable || column.autoIncrement)
  const used = props.fields.map((field) => field.id)
  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('editor.fields')}</legend>
      <p className={styles.muted}>{t('editor.fields.hint')}</p>
      {columns.map((column, index) => {
        const field = props.fields.find((entry) => entry.column === column.name)
        const relation = relations.find((entry) => entry.sourceColumn === column.name)
        return (
          <FieldRow
            key={column.name}
            column={column}
            field={field}
            index={index}
            relation={relation !== undefined}
            target={props.catalog.objects.find((entry) => entry.name === relation?.targetObject)}
            document={props.document}
            used={used}
            onChange={(next) => {
              // Fields keep the order of the columns.
              const rest = props.fields.filter((entry) => entry.column !== column.name)
              const order = (entry: FormField) =>
                columns.findIndex((item) => item.name === entry.column)
              props.onChange(
                (next === undefined ? rest : [...rest, next]).sort((a, b) => order(a) - order(b)),
              )
            }}
          />
        )
      })}
    </fieldset>
  )
}

/** Fixed conditions users cannot remove (§ Basisfilter), on own columns or one relation away. */
export function BaseFilterEditor(props: {
  object: DesignCatalogObject
  catalog: DesignCatalog
  conditions: readonly BaseFilterCondition[]
  onChange: (conditions: BaseFilterCondition[]) => void
}) {
  const t = useT()
  const variables = useVariables()
  const relations = props.catalog.relations.filter(
    (relation) => relation.sourceObject === props.object.name,
  )
  const columns = [
    ...props.object.columns.map((column) => ({
      id: column.name,
      label: column.name,
      path: [],
      column: column.name,
    })),
    ...relations.flatMap((relation) => {
      const target = props.catalog.objects.find((entry) => entry.name === relation.targetObject)
      return (target?.columns ?? []).map((column) => ({
        id: `${relation.sourceColumn}>${relation.targetObject}.${column.name}`,
        label: `${relation.sourceColumn} → ${relation.targetObject}.${column.name}`,
        path: [{ column: relation.sourceColumn, target: relation.targetObject }],
        column: column.name,
      }))
    }),
  ]
  const idOf = (condition: BaseFilterCondition) =>
    condition.column.path.length === 0
      ? condition.column.column
      : `${condition.column.path[0]?.column}>${condition.column.path[0]?.target}.${condition.column.column}`
  const update = (index: number, condition: BaseFilterCondition) =>
    props.onChange(props.conditions.map((entry, at) => (at === index ? condition : entry)))
  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('editor.baseFilter')}</legend>
      <p className={styles.muted}>{t('editor.baseFilter.hint')}</p>
      {props.conditions.map((condition, index) => {
        const valueless = condition.operator === 'null' || condition.operator === 'not_null'
        const value = condition.value
        const source =
          value === undefined
            ? none
            : value.kind === 'variable'
              ? `variable:${value.name}`
              : value.kind === 'user'
                ? `user:${value.field}`
                : 'constant'
        return (
          <div key={index} className={styles.fieldRow}>
            <SelectField
              label={t('editor.baseFilter.column')}
              value={idOf(condition)}
              onChange={(id) => {
                const column = columns.find((entry) => entry.id === id)
                if (column !== undefined)
                  update(index, {
                    ...condition,
                    column: { path: column.path, column: column.column },
                  })
              }}
              options={columns.map((column) => ({ id: column.id, label: column.label }))}
            />
            <SelectField
              label={t('editor.baseFilter.operator')}
              value={condition.operator}
              onChange={(operator) => {
                const noValue = operator === 'null' || operator === 'not_null'
                const rest: BaseFilterCondition = {
                  column: condition.column,
                  operator: condition.operator,
                }
                update(
                  index,
                  noValue
                    ? { ...rest, operator }
                    : {
                        ...condition,
                        operator,
                        value: condition.value ?? { kind: 'constant', value: '' },
                      },
                )
              }}
              options={baseFilterOperators.map((operator) => ({
                id: operator,
                label: t(`editor.operator.${operator}` as MessageId),
              }))}
            />
            {!valueless && (
              <SelectField
                label={t('editor.baseFilter.value')}
                value={source}
                onChange={(next) => {
                  const [kind, name = ''] = next.split(/:(.*)/s)
                  update(index, {
                    ...condition,
                    value:
                      kind === 'variable'
                        ? { kind: 'variable', name }
                        : kind === 'user'
                          ? { kind: 'user', field: name === 'email' ? 'email' : 'id' }
                          : { kind: 'constant', value: '' },
                  })
                }}
                options={[
                  { id: 'constant', label: t('editor.default.constant') },
                  ...(variables.data ?? []).map((variable) => ({
                    id: `variable:${variable.name}`,
                    label: t('editor.default.variable', { name: variable.name }),
                  })),
                  { id: 'user:id', label: t('editor.default.userId') },
                  { id: 'user:email', label: t('editor.default.userEmail') },
                ]}
              />
            )}
            {value?.kind === 'constant' && (
              <TextField
                label={t('editor.default.value')}
                value={Array.isArray(value.value) ? value.value.join(',') : String(value.value)}
                onChange={(text) => {
                  const number = Number(text)
                  const typed =
                    text !== '' && Number.isFinite(number) && /^-?\d+(\.\d+)?$/.test(text)
                      ? number
                      : text
                  update(index, {
                    ...condition,
                    value: {
                      kind: 'constant',
                      value:
                        condition.operator === 'in'
                          ? text.split(',').map((part) => part.trim())
                          : typed,
                    },
                  })
                }}
              />
            )}
            <Button
              variant="ghost"
              onPress={() => props.onChange(props.conditions.filter((_, at) => at !== index))}
            >
              {t('editor.remove')}
            </Button>
          </div>
        )
      })}
      <Button
        onPress={() =>
          props.onChange([
            ...props.conditions,
            {
              column: { path: [], column: props.object.columns[0]?.name ?? 'id' },
              operator: 'eq',
              value: { kind: 'constant', value: '' },
            },
          ])
        }
      >
        {t('editor.baseFilter.add')}
      </Button>
    </fieldset>
  )
}

/** Form settings besides table and mode: fields, record, upsert key, base filter, after saving. */
export function FormSettings(props: {
  block: FormComponent
  object: DesignCatalogObject
  catalog: DesignCatalog
  document: PageDocument
  onBlock: (block: FormComponent) => void
}) {
  const t = useT()
  const pages = usePages()
  const { block } = props
  const upsertKeys = [
    ...(props.object.columns.some((column) => column.key && !column.autoIncrement)
      ? [props.object.columns.filter((column) => column.key).map((column) => column.name)]
      : []),
    ...(props.object.uniqueKeys ?? []),
  ]
  const after = block.afterSave
  const setAfter = (afterSave: AfterSave) => props.onBlock({ ...block, afterSave })
  return (
    <>
      {block.mode === 'edit' && (
        <SelectField
          label={t('editor.form.record')}
          value={
            block.record === null
              ? none
              : block.record.from.kind === 'filter'
                ? `filter:${block.record.from.filterId}`
                : `url:${block.record.from.name}`
          }
          onChange={(next) => {
            if (next === none) return props.onBlock({ ...block, record: null })
            const [kind, name = ''] = next.split(/:(.*)/s)
            props.onBlock({
              ...block,
              record: {
                from:
                  kind === 'filter' ? { kind: 'filter', filterId: name } : { kind: 'url', name },
              },
            })
          }}
          options={[{ id: none, label: t('editor.choose') }, ...inputOptions(props.document, t)]}
        />
      )}
      {block.mode === 'upsert' && (
        <SelectField
          label={t('editor.form.upsertKey')}
          value={block.upsertKey?.join(',') ?? none}
          onChange={(next) =>
            props.onBlock({ ...block, upsertKey: next === none ? null : next.split(',') })
          }
          options={[
            { id: none, label: t('editor.choose') },
            ...upsertKeys.map((key) => ({ id: key.join(','), label: key.join(' + ') })),
          ]}
        />
      )}
      <FieldListEditor
        object={props.object}
        catalog={props.catalog}
        fields={block.fields}
        document={props.document}
        onChange={(fields) => props.onBlock({ ...block, fields })}
      />
      <BaseFilterEditor
        object={props.object}
        catalog={props.catalog}
        conditions={block.baseFilter}
        onChange={(baseFilter) => props.onBlock({ ...block, baseFilter })}
      />
      <div className={styles.inline}>
        <SelectField
          label={t('editor.form.afterSave')}
          value={after.action}
          onChange={(action) =>
            setAfter(
              action === 'navigate'
                ? { action, pageId: pages.data?.[0]?.id ?? '', parameter: 'id' }
                : { action: action === 'show' ? 'show' : 'clear' },
            )
          }
          options={[
            { id: 'clear', label: t('editor.form.afterSave.clear') },
            { id: 'show', label: t('editor.form.afterSave.show') },
            { id: 'navigate', label: t('editor.form.afterSave.navigate') },
          ]}
        />
        {after.action === 'navigate' && (
          <>
            <SelectField
              label={t('editor.form.afterSave.page')}
              value={after.pageId}
              onChange={(pageId) => setAfter({ ...after, pageId })}
              options={(pages.data ?? []).map((page) => ({ id: page.id, label: page.title }))}
            />
            <TextField
              label={t('editor.form.afterSave.parameter')}
              value={after.parameter}
              onChange={(parameter) => setAfter({ ...after, parameter })}
            />
          </>
        )}
      </div>
      <TextField
        label={t('editor.form.submitLabel')}
        value={block.submitLabel ?? ''}
        onChange={(label) => {
          const rest: FormComponent = { ...block }
          delete rest.submitLabel
          props.onBlock(label === '' ? rest : { ...block, submitLabel: label })
        }}
      />
    </>
  )
}

/** Editing of a table source: operations, inline or dialog, fields, base filter, export. */
export function TableEditingSettings(props: {
  table: TableConfig
  object: DesignCatalogObject
  catalog: DesignCatalog
  document: PageDocument
  onTable: (table: TableConfig) => void
}) {
  const t = useT()
  const editing: TableEditing = props.table.editing ?? {
    ops: [],
    fields: [],
    inline: true,
    dialog: true,
  }
  const offered = editOps.filter(
    (op) => props.object.type === 'table' && props.object.ceiling.includes(op),
  )
  const setEditing = (next: TableEditing) =>
    props.onTable({
      ...props.table,
      editing: next.ops.length === 0 && next.fields.length === 0 ? null : next,
    })
  const opLabel: Record<EditOp, MessageId> = {
    create: 'editor.op.create',
    update: 'editor.op.update',
    delete: 'editor.op.delete',
  }
  return (
    <>
      <BaseFilterEditor
        object={props.object}
        catalog={props.catalog}
        conditions={props.table.baseFilter}
        onChange={(baseFilter) => props.onTable({ ...props.table, baseFilter })}
      />
      <SwitchField
        label={t('editor.table.csvExport')}
        isSelected={props.table.csvExport}
        onChange={(csvExport) => props.onTable({ ...props.table, csvExport })}
      />
      {offered.length > 0 && (
        <fieldset className={styles.fieldset}>
          <legend>{t('editor.table.editing')}</legend>
          <p className={styles.muted}>{t('editor.table.editingHint')}</p>
          <div className={styles.checks}>
            {offered.map((op) => (
              <CheckboxField
                key={op}
                label={t(opLabel[op])}
                isSelected={editing.ops.includes(op)}
                onChange={(selected) =>
                  setEditing({
                    ...editing,
                    ops: editOps.filter((entry) =>
                      entry === op ? selected : editing.ops.includes(entry),
                    ),
                  })
                }
              />
            ))}
          </div>
          {editing.ops.length > 0 && (
            <div className={styles.checks}>
              <CheckboxField
                label={t('editor.table.inline')}
                isSelected={editing.inline}
                onChange={(inline) => setEditing({ ...editing, inline })}
              />
              <CheckboxField
                label={t('editor.table.dialog')}
                isSelected={editing.dialog}
                onChange={(dialog) => setEditing({ ...editing, dialog })}
              />
            </div>
          )}
        </fieldset>
      )}
      {(editing.ops.includes('create') || editing.ops.includes('update')) && (
        <FieldListEditor
          object={props.object}
          catalog={props.catalog}
          fields={editing.fields}
          document={props.document}
          onChange={(fields) => setEditing({ ...editing, fields })}
        />
      )}
    </>
  )
}

/** Adds a column of a related object (one relation step) to a table (§ Verknüpfte Spalten). */
export function LinkedColumnPicker(props: {
  object: DesignCatalogObject
  catalog: DesignCatalog
  table: TableConfig
  onTable: (table: TableConfig) => void
}) {
  const t = useT()
  const relations = props.catalog.relations.filter(
    (relation) => relation.sourceObject === props.object.name,
  )
  if (relations.length === 0) return null
  const options = relations.flatMap((relation) => [
    {
      id: `display:${relation.sourceColumn}>${relation.targetObject}`,
      label: t('editor.linked.display', {
        column: relation.sourceColumn,
        target: relation.targetObject,
      }),
    },
    ...(
      props.catalog.objects.find((entry) => entry.name === relation.targetObject)?.columns ?? []
    ).map((column) => ({
      id: `column:${relation.sourceColumn}>${relation.targetObject}.${column.name}`,
      label: `${relation.sourceColumn} → ${relation.targetObject}.${column.name}`,
    })),
  ])
  return (
    <SelectField
      label={t('editor.linked.add')}
      value={none}
      onChange={(choice) => {
        if (choice === none) return
        const used = props.table.columns.map((column) => column.id)
        const [kind, rest = ''] = choice.split(/:(.*)/s)
        const [step = '', columnName] = rest.split('.')
        const [column = '', target = ''] = step.split('>')
        const path = [{ column, target }]
        const id = nextId(used, kind === 'display' ? target : `${target}-${columnName ?? ''}`)
        props.onTable({
          ...props.table,
          columns: [
            ...props.table.columns,
            kind === 'display'
              ? { kind: 'display', id, path, label: target }
              : {
                  kind: 'column',
                  id,
                  column: { path, column: columnName ?? '' },
                  label: `${target}.${columnName ?? ''}`,
                },
          ],
        })
      }}
      options={[{ id: none, label: t('editor.linked.choose') }, ...options]}
    />
  )
}

/**
 * Adds a related table to the detail view of a table page: an object whose relation points to
 * the page's table, read for the shown record (§13.1). Its rights come from the page grants.
 */
export function DetailTableAdder(props: {
  document: PageDocument
  onAdd: (table: DetailTable) => void
}) {
  const t = useT()
  const main = props.document.table
  const mainId = main?.source.kind === 'table' ? main.source.tableAccessId : undefined
  const { object, connectionId } = useTableObject(mainId)
  const catalog = useCatalog(connectionId)
  if (object === undefined || catalog.data === undefined) return null
  const relations = catalog.data.relations.filter(
    (relation) =>
      relation.targetObject === object.name && relation.targetColumn === object.keyColumn,
  )
  if (relations.length === 0) return <p className={styles.muted}>{t('editor.detail.none')}</p>
  const used = [
    ...(main === null ? [] : [main.id]),
    ...(props.document.detail?.tables.map((entry) => entry.id) ?? []),
  ]
  return (
    <SelectField
      label={t('editor.detail.add')}
      value={none}
      onChange={(choice) => {
        const relation = relations.find(
          (entry) => `${entry.sourceObject}.${entry.sourceColumn}` === choice,
        )
        const related = catalog.data?.objects.find((entry) => entry.name === relation?.sourceObject)
        if (relation === undefined || related === undefined) return
        props.onAdd({
          id: nextId(used, related.name),
          type: 'table',
          title: related.name,
          restrictions: [],
          source: { kind: 'table', tableAccessId: related.tableAccessId, cacheTtlSeconds: 0 },
          bindings: [],
          table: {
            columns: related.columns
              .filter((column) => column.name !== relation.sourceColumn)
              .slice(0, 8)
              .map((column, index) => ({
                kind: 'column' as const,
                id: `c${index + 1}`,
                column: { path: [], column: column.name },
                label: column.name,
              })),
            sort: null,
            searchColumns: [],
            baseFilter: [],
            bindings: [],
            pageSize: 20,
            editing: null,
            csvExport: true,
          },
          link: { column: relation.sourceColumn },
        })
      }}
      options={[
        { id: none, label: t('editor.linked.choose') },
        ...relations.map((relation) => ({
          id: `${relation.sourceObject}.${relation.sourceColumn}`,
          label: t('editor.detail.option', {
            table: relation.sourceObject,
            column: relation.sourceColumn,
          }),
        })),
      ]}
    />
  )
}
