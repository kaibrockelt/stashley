// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  BaseFilterCondition,
  CatalogColumn,
  CatalogObject,
  FieldDefault,
  FieldGenerator,
  FieldSpec,
  FieldWidget,
  FormField,
  LockStrategy,
  OpMask,
  ParameterBinding,
  PageDocument,
  ReferenceOptions,
} from '@stashley/shared'
import {
  checkField,
  columnRequired,
  editableKind,
  fieldSpec,
  hasOp,
  noOps,
  opBits,
  parseDateExpression,
  serverDefault,
  widgetsFor,
} from '@stashley/shared'
import {
  buildTableModel,
  ModelError,
  type ModelRelation,
  type TableModel,
} from '../execution/sql/table-model.ts'
import type { CompiledQuerySource } from './compile.ts'
import type { ConnectionFacts, ObjectFacts } from './facts.ts'

/**
 * The write model of a form or an editable table (§11): which fields a payload may contain
 * per operation, which values the server sets, how concurrent edits are detected and which
 * key an upsert uses. Built when a page is compiled; problems become issues (§8.6).
 */

/** A foreign key field's options: records of the target, or rows of a stored query. */
export interface CompiledReference {
  target: string
  /** The target column the foreign key refers to. */
  targetColumn: string
  /** Value `value`, label `label`, extras by their index (`x0`, `x1`, …). */
  model: TableModel
  /** Model column IDs searched for options; exact matches are taken directly. */
  searchColumns: string[]
  extras: { id: string; label: string }[]
  query?: {
    ref: { queryId: string; version?: number | undefined }
    valueColumn: string
    labelColumn: string
    bindings: readonly ParameterBinding[]
    /** Resolved when the page is compiled. */
    source?: CompiledQuerySource
  }
}

export interface WriteField {
  id: string
  column: string
  label: string | undefined
  help: string | undefined
  kind: 'input' | 'generated'
  widget: FieldWidget | null
  spec: FieldSpec
  /** Input fields: set by the server and never sent (hidden constant, variable, user). */
  serverOnly: boolean
  hidden: boolean
  default: FieldDefault | undefined
  generator: FieldGenerator | undefined
  reference: CompiledReference | undefined
}

export interface WriteModel {
  object: string
  keyColumn: string
  keyKind: CatalogColumn['kind']
  keyAutoIncrement: boolean
  fields: WriteField[]
  /** What a payload may contain per operation (the shared row schema). */
  payload: { create: FieldSpec[]; update: FieldSpec[] }
  lock: LockStrategy
  upsertKey: string[] | null
  /** Reads the record with the base filter: the fields' readable columns by field ID. */
  row: TableModel
  baseFilter: readonly BaseFilterCondition[]
  /**
   * Columns new rows take from equality conditions of the base filter, with the condition's
   * index in `row.baseFilter`; the server sets them when the payload leaves them out.
   */
  filled: readonly { column: string; index: number }[]
}

export type WriteMode = 'create' | 'edit' | 'upsert' | 'table'

export interface WriteInput {
  path: string
  /** Where the fields live in the document, e.g. `rows.0.blocks.1.fields`. */
  fieldsPath: string
  fields: readonly FormField[]
  mode: WriteMode
  /** Operations the component is configured for (create, update). */
  ops: { create: boolean; update: boolean }
  upsertKey: string[] | null
  baseFilter: readonly BaseFilterCondition[]
  document: PageDocument
}

type Issue = (
  path: string,
  code: string,
  params?: Record<string, string | number>,
  warning?: boolean,
) => void

const dateKinds = new Set(['date', 'datetime', 'timestamp'])
const lower = (name: string) => name.toLowerCase()

function relationOf(
  relations: readonly ModelRelation[],
  object: string,
  column: string,
  target: string | undefined,
): ModelRelation[] {
  return relations.filter(
    (relation) =>
      relation.sourceObject === object &&
      lower(relation.sourceColumn) === lower(column) &&
      (target === undefined || relation.targetObject === target),
  )
}

/** The option model of a foreign key field over its target (§ Auswahllisten). */
function referenceModel(
  connection: ConnectionFacts,
  relation: ModelRelation,
  options: ReferenceOptions,
  at: string,
  issue: Issue,
): CompiledReference | undefined {
  const target = connection.access(relation.targetObject)
  const catalog = connection.catalog.get(relation.targetObject)
  if (
    target === undefined ||
    catalog === undefined ||
    !target.active ||
    !hasOp(target.ceiling, 'read')
  ) {
    issue(`${at}.target`, 'object_not_readable')
    return undefined
  }
  const searchColumns = options.searchColumns.length > 0 ? options.searchColumns : []
  const config = {
    columns: [
      { kind: 'column' as const, id: 'value', column: { path: [], column: relation.targetColumn } },
      {
        kind: 'display' as const,
        id: 'label',
        path: [],
        ...(options.template !== undefined && { template: options.template }),
      },
      ...searchColumns.map((column, index) => ({
        kind: 'column' as const,
        id: `s${index}`,
        column: { path: [], column },
      })),
      ...options.extras.map((column, index) => ({
        kind: 'column' as const,
        id: `x${index}`,
        column,
      })),
    ],
    sort: { columnId: 'label', direction: 'asc' as const },
    // The display value is always searched; configured columns are searched too and decide
    // exact matches, e.g. a start number typed at a station.
    searchColumns: ['label', ...searchColumns.map((_, index) => `s${index}`)],
    // Narrows table lists for everyone (§ Auswahllisten); query lists narrow themselves.
    baseFilter: options.query === undefined ? [...options.baseFilter] : [],
    bindings: [],
    pageSize: 50,
    editing: null,
    csvExport: false,
  }
  if (options.query !== undefined && options.baseFilter.length > 0) {
    issue(`${at}.baseFilter`, 'not_allowed')
    return undefined
  }
  // Relations into views use the view's key column; a target without one cannot list options.
  if (target.keyColumn === null) {
    issue(`${at}.target`, 'object_not_readable')
    return undefined
  }
  try {
    const model = buildTableModel(relation.targetObject, config, connection, at)
    return {
      target: relation.targetObject,
      targetColumn: relation.targetColumn,
      model,
      searchColumns:
        searchColumns.length > 0 ? searchColumns.map((_, index) => `s${index}`) : ['label'],
      extras: options.extras.map((column, index) => ({
        id: `x${index}`,
        label: [...column.path.map((step) => step.target), column.column].join('.'),
      })),
      ...(options.query !== undefined && {
        query: {
          ref: options.query.source,
          valueColumn: options.query.valueColumn,
          labelColumn: options.query.labelColumn,
          bindings: options.query.bindings,
        },
      }),
    }
  } catch (error) {
    if (!(error instanceof ModelError)) throw error
    // Columns of the synthesized configuration map back to the options' settings.
    const prefix = `${at}.columns.`
    for (const problem of error.errors) {
      // Base filter problems already name their condition.
      if (problem.field.startsWith(`${at}.baseFilter.`)) {
        issue(problem.field, problem.code)
        continue
      }
      const index = problem.field.startsWith(prefix)
        ? Number.parseInt(problem.field.slice(prefix.length), 10)
        : Number.NaN
      const mapped = Number.isNaN(index)
        ? `${at}.target`
        : index === 0
          ? `${at}.target`
          : index === 1
            ? `${at}.template`
            : index - 2 < searchColumns.length
              ? `${at}.searchColumns.${index - 2}`
              : `${at}.extras.${index - 2 - searchColumns.length}`
      issue(mapped, problem.code)
    }
    return undefined
  }
}

/** Whether a default's value can be checked now and fits the field. */
function checkDefault(
  spec: FieldSpec,
  value: FieldDefault,
  document: PageDocument,
): string | undefined {
  switch (value.kind) {
    case 'constant': {
      const checked = checkField({ ...spec, required: false, nullable: true }, value.value)
      return checked.ok ? undefined : checked.code
    }
    case 'user':
      return spec.kind === 'string' ? undefined : 'default_unsuitable'
    case 'filter':
      return document.filters.some((filter) => filter.id === value.filterId)
        ? undefined
        : 'unknown_input'
    case 'url':
      return document.parameters.some((parameter) => parameter.name === value.name)
        ? undefined
        : 'unknown_input'
    case 'variable':
      // Instance variables are read when saving; a missing one fails the write (fail closed).
      return undefined
  }
}

export interface BuiltWriteModel {
  model: WriteModel | undefined
  /** Operations the database grants rule out (`grant_missing`), to clear from `dbGrants`. */
  withheld: OpMask
  /** Foreign key option queries to resolve, by field index. */
  queries: { index: number; reference: CompiledReference }[]
}

/**
 * Builds and checks the write model. Errors leave the model undefined, so the component is
 * not delivered; warnings (missing grants) withhold the affected operations.
 */
export function buildWriteModel(
  connection: ConnectionFacts,
  object: ObjectFacts,
  input: WriteInput,
  issue: Issue,
): BuiltWriteModel {
  const catalog: CatalogObject | undefined = connection.catalog.get(object.objectName)
  const empty: BuiltWriteModel = { model: undefined, withheld: noOps, queries: [] }
  if (catalog === undefined || object.objectType !== 'table' || object.keyColumn === null) {
    issue(`${input.path}.source`, 'view_read_only')
    return empty
  }
  const errorsBefore = { count: 0 }
  const fail: Issue = (path, code, params, warning) => {
    if (warning !== true) errorsBefore.count++
    issue(path, code, params, warning)
  }
  const excluded = new Set([...object.excluded].map(lower))
  const keyColumn = object.keyColumn
  const key = catalog.columns.find((column) => column.name === keyColumn)
  if (key === undefined) {
    fail(`${input.path}.source`, 'unknown_column')
    return empty
  }
  let withheld = noOps
  const fields: WriteField[] = []
  const queries: BuiltWriteModel['queries'] = []
  // Columns the configuration names; a field with its own problem does not count as missing.
  const covered = new Set(input.fields.map((field) => lower(field.column)))

  input.fields.forEach((field, index) => {
    const at = `${input.fieldsPath}.${index}`
    const column = catalog.columns.find((entry) => lower(entry.name) === lower(field.column))
    if (column === undefined) return fail(`${at}.column`, 'unknown_column')
    if (excluded.has(lower(column.name))) return fail(`${at}.column`, 'excluded_column')
    const spec = fieldSpec(column, { required: field.kind === 'input' && field.required })
    const relations = relationOf(
      connection.relations,
      object.objectName,
      column.name,
      field.kind === 'input' ? field.reference?.target : undefined,
    )

    if (field.kind === 'generated') {
      const generator = field.generator
      if (generator.kind === 'auto_increment') {
        if (!column.autoIncrement) return fail(`${at}.generator`, 'generator_unsuitable')
      } else if (
        !dateKinds.has(column.kind) ||
        parseDateExpression(generator.expression) === undefined
      ) {
        return fail(`${at}.generator`, 'generator_unsuitable')
      }
      fields.push({
        id: field.id,
        column: column.name,
        label: field.label,
        help: field.help,
        kind: 'generated',
        widget:
          generator.kind === 'date'
            ? (widgetsFor(column.kind, column.columnType, false)[0] ?? null)
            : null,
        spec,
        serverOnly: generator.kind === 'auto_increment' || !generator.editable,
        hidden: false,
        default: undefined,
        generator,
        reference: undefined,
      })
      return
    }

    if (column.autoIncrement) return fail(`${at}.column`, 'auto_increment')
    if (column.generated || !editableKind(column.kind))
      return fail(`${at}.column`, 'field_not_writable')
    if (
      lower(column.name) === lower(keyColumn) &&
      input.mode !== 'create' &&
      input.mode !== 'upsert'
    ) {
      return fail(`${at}.column`, 'key_not_writable')
    }
    const allowed = widgetsFor(column.kind, column.columnType, relations.length > 0)
    const widget = field.widget ?? allowed[0] ?? null
    if (widget === null || !allowed.includes(widget))
      return fail(`${at}.widget`, 'widget_unsuitable')
    let reference: CompiledReference | undefined
    if (widget === 'reference') {
      if (relations.length !== 1) {
        return fail(
          `${at}.reference.target`,
          relations.length === 0 ? 'unknown_relation' : 'relation_ambiguous',
        )
      }
      const relation = relations[0] as ModelRelation
      reference = referenceModel(
        connection,
        relation,
        field.reference ?? {
          target: relation.targetObject,
          searchColumns: [],
          extras: [],
          baseFilter: [],
        },
        `${at}.reference`,
        fail,
      )
      if (reference === undefined) return
      if (reference.query !== undefined) queries.push({ index: fields.length, reference })
    } else if (field.reference !== undefined) {
      return fail(`${at}.reference`, 'not_allowed')
    }
    if (field.default !== undefined) {
      const problem = checkDefault(spec, field.default, input.document)
      if (problem !== undefined) return fail(`${at}.default`, problem)
    }
    const serverOnly = field.hidden && field.default !== undefined && serverDefault(field.default)
    fields.push({
      id: field.id,
      column: column.name,
      label: field.label,
      help: field.help,
      kind: 'input',
      widget,
      spec,
      serverOnly,
      hidden: field.hidden,
      default: field.default,
      generator: undefined,
      reference,
    })
  })

  // The server writes the lock column where it has to (§11 lock strategy).
  const lock = object.lock
  if (lock.kind !== 'values') covered.add(lower(lock.column))
  // Equality conditions of the base filter on the row's own columns fill new rows, so a form
  // on the current event needs no event field (E9). Their values come from the server.
  const filled: { column: string; index: number }[] = []
  if (input.ops.create) {
    input.baseFilter.forEach((condition, index) => {
      if (condition.operator !== 'eq' || condition.value === undefined) return
      if (condition.column.path.length > 0) return
      const column = catalog.columns.find(
        (entry) => lower(entry.name) === lower(condition.column.column),
      )
      if (
        column === undefined ||
        column.generated ||
        column.autoIncrement ||
        excluded.has(lower(column.name)) ||
        filled.some((entry) => entry.column === column.name)
      ) {
        return
      }
      filled.push({ column: column.name, index })
      covered.add(lower(column.name))
    })
  }
  // A form that can create must cover every required column (§ Pflichtfelder).
  if (input.ops.create) {
    for (const column of catalog.columns) {
      if (
        columnRequired(column) &&
        !excluded.has(lower(column.name)) &&
        !covered.has(lower(column.name))
      ) {
        fail(input.fieldsPath, 'required_field_missing', { column: column.name })
      }
    }
    // A key the server cannot produce must come from the form; otherwise the new row could
    // not be read back (e.g. a `DEFAULT uuid()` key).
    if (!key.autoIncrement && !columnRequired(key) && !covered.has(lower(key.name))) {
      fail(input.fieldsPath, 'key_missing', { column: key.name })
    }
  }

  // Upserts find their row by the primary key or a unique key without nullable columns, and
  // never by an auto-increment column (E8). Every key column must come with the payload.
  let upsertKey: string[] | null = null
  if (input.mode === 'upsert') {
    const wanted = input.upsertKey
    if (wanted === null) {
      fail(`${input.path}.upsertKey`, 'upsert_key_missing')
    } else {
      const names = wanted.map(lower)
      const same = (keyColumns: string[]) =>
        keyColumns.length === names.length &&
        keyColumns.every((name) => names.includes(lower(name)))
      const isPrimary = same(catalog.primaryKey)
      const isUnique = catalog.uniqueKeys.some(same)
      const columns = names.map((name) =>
        catalog.columns.find((column) => lower(column.name) === name),
      )
      const suitable =
        (isPrimary || isUnique) &&
        columns.every(
          (column) =>
            column !== undefined && !column.nullable && !column.autoIncrement && !column.generated,
        )
      if (!suitable) fail(`${input.path}.upsertKey`, 'upsert_key_invalid')
      else {
        upsertKey = columns.map((column) => (column as CatalogColumn).name)
        for (const name of upsertKey) {
          if (!fields.some((field) => field.column === name && field.kind === 'input')) {
            fail(`${input.path}.upsertKey`, 'upsert_key_not_in_form', { column: name })
          }
        }
      }
    }
  }

  // What a payload may contain. Updates never re-apply defaults or generators; an editable
  // generated date is then an ordinary input, and the key never changes.
  const create = fields.filter(
    (field) => !field.serverOnly && (field.kind === 'input' || field.generator?.kind === 'date'),
  )
  const update = fields.filter(
    (field) =>
      lower(field.column) !== lower(keyColumn) &&
      ((field.kind === 'input' && !field.serverOnly) ||
        (field.generator?.kind === 'date' && field.generator.editable)),
  )

  // Missing column grants of the write user withhold an operation instead of failing it at
  // the database (E6): a field, a server value or the lock column it would write.
  const granted = (op: 'create' | 'update', column: string) => {
    const columns = object.writable[op]
    return columns === null || columns.has(lower(column))
  }
  const lockColumn = catalog.columns.find(
    (column) => lock.kind !== 'values' && lower(column.name) === lower(lock.column),
  )
  const written = {
    create: [
      ...fields
        .filter((field) => field.generator?.kind !== 'auto_increment')
        .map((field) => field.column),
      ...(lockColumn !== undefined && lockColumn.defaultValue === null ? [lockColumn.name] : []),
      ...filled.map((entry) => entry.column),
    ],
    update: [
      ...update.map((field) => field.column),
      ...(lock.kind === 'version' || (lock.kind === 'timestamp' && lock.setByServer)
        ? [lock.column]
        : []),
    ],
  }
  for (const op of ['create', 'update'] as const) {
    if (!input.ops[op]) continue
    const missing = [...new Set(written[op])].filter((column) => !granted(op, column))
    if (missing.length > 0) {
      withheld |= opBits[op]
      issue(`${input.path}.source`, 'grant_missing', { op, columns: missing.join(', ') }, true)
    }
  }

  // The record with its base filter, read by the write user's checks and by edit mode.
  let row: TableModel | undefined
  try {
    row = buildTableModel(
      object.objectName,
      {
        columns: fields
          .filter((field) => field.spec.kind !== 'unsupported')
          .map((field) => ({
            kind: 'column' as const,
            id: field.id,
            column: { path: [], column: field.column },
          })),
        sort: null,
        searchColumns: [],
        baseFilter: [...input.baseFilter],
        bindings: [],
        pageSize: 1,
        editing: null,
        csvExport: false,
      },
      connection,
      input.path,
    )
  } catch (error) {
    if (!(error instanceof ModelError)) throw error
    for (const problem of error.errors) {
      fail(problem.field === 'source' ? `${input.path}.source` : problem.field, problem.code)
    }
  }
  if (errorsBefore.count > 0 || row === undefined)
    return { model: undefined, withheld, queries: [] }

  // On create, fields the server can fill itself may be left out: a default it sets (constant,
  // variable, user) or a generated date. Defaults from page filters come with the payload.
  const optional = (field: WriteField) =>
    (field.default !== undefined && serverDefault(field.default)) ||
    field.generator !== undefined ||
    filled.some((entry) => entry.column === field.column)
      ? { ...field.spec, required: false }
      : field.spec
  return {
    model: {
      object: object.objectName,
      keyColumn,
      keyKind: key.kind,
      keyAutoIncrement: key.autoIncrement,
      fields,
      payload: {
        create: input.ops.create ? create.map(optional) : [],
        update: input.ops.update ? update.map((field) => field.spec) : [],
      },
      lock,
      upsertKey,
      row,
      baseFilter: input.baseFilter,
      filled,
    },
    withheld,
    queries,
  }
}
