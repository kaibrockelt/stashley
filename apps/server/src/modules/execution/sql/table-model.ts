// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import type {
  BaseFilterCondition,
  CatalogObject,
  ColumnRef,
  FieldError,
  ObjectAccess,
  ParameterBinding,
  TableConfig,
  ValueKind,
} from '@stashley/shared'
import { hasOp } from '@stashley/shared'
import { checkTemplate, placeholders } from '../../table-access/templates.ts'

/**
 * The model of a table source (§10.6): which columns, lookup columns and display values it
 * reads, over which joins, with which base filter. Built when a page is compiled, from the
 * current catalog and table access; reads turn it into SQL (`table-sql.ts`).
 */

/** A relation the model may follow: from `sourceObject.sourceColumn` to the target. */
export interface ModelRelation {
  sourceObject: string
  sourceColumn: string
  targetObject: string
  targetColumn: string
}

/** Table access of an object, with the effective display template (already checked). */
export interface ModelAccess extends ObjectAccess {
  keyColumn: string | null
  effectiveTemplate: string
}

export interface ModelContext {
  catalog: ReadonlyMap<string, CatalogObject>
  relations: readonly ModelRelation[]
  access: (object: string) => ModelAccess | undefined
}

/** `LEFT JOIN object AS alias ON alias.column = parent.parentColumn`. */
export interface JoinStep {
  alias: string
  parent: string
  parentColumn: string
  object: string
  column: string
}

/** A column of one of the model's aliases. */
export interface ColumnExpr {
  alias: string
  column: string
  kind: ValueKind
}

export type OutputExpr =
  ({ type: 'column' } & ColumnExpr) | { type: 'template'; parts: (string | ColumnExpr)[] }

export interface ModelColumn {
  id: string
  label: string | undefined
  kind: ValueKind
  expr: OutputExpr
}

export interface ModelCondition {
  expr: ColumnExpr
  operator: BaseFilterCondition['operator']
  value: BaseFilterCondition['value']
}

export interface ModelBinding {
  from: ParameterBinding['from']
  expr: ColumnExpr
  operator: 'eq' | 'in' | 'contains' | 'range'
}

export interface TableModel {
  object: string
  key: ColumnExpr
  joins: JoinStep[]
  columns: ModelColumn[]
  baseFilter: ModelCondition[]
  bindings: ModelBinding[]
  searchColumns: string[]
  sort: { columnId: string; direction: 'asc' | 'desc' } | null
  pageSize: number
  /** Every object read, for cache dependencies and MCP reachability. */
  objects: string[]
  /** Every column read, including join keys and filters. */
  columnsUsed: { object: string; column: string }[]
  /** Changes whenever the generated SQL would. */
  fingerprint: string
}

export class ModelError extends Error {
  readonly errors: FieldError[]

  constructor(errors: FieldError[]) {
    super('Invalid table source')
    this.name = 'ModelError'
    this.errors = errors
  }
}

/** Kinds a table never selects (§9.5); they show a placeholder. */
const unreadable = new Set<ValueKind>(['unsupported'])

class Builder {
  readonly errors: FieldError[] = []
  readonly joins: JoinStep[] = []
  private readonly aliases = new Map<string, string>()
  readonly objects = new Set<string>()
  readonly used = new Map<string, { object: string; column: string }>()
  private readonly ctx: ModelContext

  constructor(ctx: ModelContext, base: string) {
    this.ctx = ctx
    this.aliases.set('', 't0')
    this.objects.add(base)
  }

  fail(field: string, code: string): void {
    this.errors.push({ field, code })
  }

  /** The readable table access of an object, or an error. */
  private readable(field: string, object: string): ModelAccess | undefined {
    const access = this.ctx.access(object)
    if (
      access === undefined ||
      !access.active ||
      !hasOp(access.ceiling, 'read') ||
      !this.ctx.catalog.has(object)
    ) {
      this.fail(field, 'object_not_readable')
      return undefined
    }
    return access
  }

  /** A column that may be read: it exists, is supported and is not excluded. */
  column(field: string, alias: string, object: string, name: string): ColumnExpr | undefined {
    const access = this.readable(field, object)
    const column = this.ctx.catalog.get(object)?.columns.find((entry) => entry.name === name)
    if (access === undefined) return undefined
    if (column === undefined) {
      this.fail(field, 'unknown_column')
      return undefined
    }
    if (access.excluded.has(name)) {
      this.fail(field, 'excluded_column')
      return undefined
    }
    if (unreadable.has(column.kind)) {
      this.fail(field, 'unsupported_column')
      return undefined
    }
    this.used.set(`${object}\u0000${name}`, { object, column: name })
    return { alias, column: name, kind: column.kind }
  }

  /**
   * Follows relation steps from the base object (up to three, §10.6). Joins with the same
   * prefix are shared, so their aliases are deterministic.
   */
  path(
    field: string,
    base: string,
    steps: readonly { column: string; target: string }[],
  ): { alias: string; object: string } | undefined {
    let object = base
    let alias = 't0'
    let key = ''
    for (const [index, step] of steps.entries()) {
      const relation = this.ctx.relations.find(
        (entry) =>
          entry.sourceObject === object &&
          entry.sourceColumn === step.column &&
          entry.targetObject === step.target,
      )
      if (relation === undefined) {
        this.fail(`${field}.${index}`, 'unknown_relation')
        return undefined
      }
      // Both join keys are read; an excluded key column cannot carry a lookup.
      if (this.column(`${field}.${index}`, alias, object, relation.sourceColumn) === undefined) {
        return undefined
      }
      key += `/${step.column}>${step.target}`
      let next = this.aliases.get(key)
      if (next === undefined) {
        next = `t${this.aliases.size}`
        this.aliases.set(key, next)
        if (
          this.column(`${field}.${index}`, next, step.target, relation.targetColumn) === undefined
        ) {
          return undefined
        }
        this.joins.push({
          alias: next,
          parent: alias,
          parentColumn: relation.sourceColumn,
          object: step.target,
          column: relation.targetColumn,
        })
      }
      this.objects.add(step.target)
      object = step.target
      alias = next
    }
    return { alias, object }
  }

  ref(field: string, base: string, ref: ColumnRef): ColumnExpr | undefined {
    const end = this.path(`${field}.path`, base, ref.path)
    if (end === undefined) return undefined
    return this.column(`${field}.column`, end.alias, end.object, ref.column)
  }

  /**
   * A display value: the template of the record at the end of `path`, compiled to its parts.
   * Templates are checked again here, so a column excluded later is never shown (§8.3).
   */
  display(
    field: string,
    base: string,
    path: readonly { column: string; target: string }[],
    override: string | undefined,
  ): (string | ColumnExpr)[] | undefined {
    const end = this.path(`${field}.path`, base, path)
    if (end === undefined) return undefined
    // The path checked that the object exists and is readable.
    const access = this.ctx.access(end.object) as ModelAccess
    const object = this.ctx.catalog.get(end.object) as CatalogObject
    let template = access.effectiveTemplate
    if (override !== undefined) {
      const problem = checkTemplate(override, {
        object,
        objects: this.ctx.catalog,
        relations: this.ctx.relations.filter((relation) => relation.sourceObject === end.object),
        excluded: access.excluded,
        target: (name) => {
          const target = this.ctx.access(name)
          return target !== undefined && target.active && hasOp(target.ceiling, 'read')
            ? { excluded: target.excluded }
            : undefined
        },
      })
      if (problem !== undefined) {
        this.fail(`${field}.template`, `template_${problem}`)
        return undefined
      }
      template = override
    }
    if (template === '') {
      this.fail(`${field}.template`, 'template_invalid')
      return undefined
    }
    const parts: (string | ColumnExpr)[] = []
    let rest = template
    for (const placeholder of placeholders(template)) {
      const text =
        placeholder.relation === undefined
          ? `{${placeholder.column}}`
          : `{${placeholder.relation}.${placeholder.column}}`
      const at = rest.indexOf(text)
      if (at > 0) parts.push(rest.slice(0, at))
      rest = rest.slice(at + text.length)
      if (placeholder.relation === undefined) {
        const expr = this.column(`${field}.template`, end.alias, end.object, placeholder.column)
        if (expr === undefined) return undefined
        parts.push(expr)
        continue
      }
      // `{relation.column}` names the relation by its source column or its target.
      const relations = this.ctx.relations.filter((entry) => entry.sourceObject === end.object)
      const bySource = relations.filter((entry) => entry.sourceColumn === placeholder.relation)
      const byTarget = relations.filter((entry) => entry.targetObject === placeholder.relation)
      const relation =
        bySource.length === 1 ? bySource[0] : byTarget.length === 1 ? byTarget[0] : undefined
      if (relation === undefined) {
        this.fail(`${field}.template`, 'template_unknown_relation')
        return undefined
      }
      const step = this.path(`${field}.template`, base, [
        ...path,
        { column: relation.sourceColumn, target: relation.targetObject },
      ])
      if (step === undefined) return undefined
      const expr = this.column(`${field}.template`, step.alias, step.object, placeholder.column)
      if (expr === undefined) return undefined
      parts.push(expr)
    }
    if (rest !== '') parts.push(rest)
    return parts
  }
}

/**
 * Builds the model of a table source. Errors are field errors on the component (paths
 * relative to `field`); an invalid model is never executed.
 */
export function buildTableModel(
  object: string,
  config: TableConfig,
  ctx: ModelContext,
  field = 'table',
): TableModel {
  const builder = new Builder(ctx, object)
  const access = ctx.access(object)
  const catalog = ctx.catalog.get(object)
  if (
    access === undefined ||
    catalog === undefined ||
    !access.active ||
    !hasOp(access.ceiling, 'read') ||
    access.keyColumn === null
  ) {
    throw new ModelError([{ field: 'source', code: 'object_not_readable' }])
  }
  const key = builder.column('source', 't0', object, access.keyColumn)
  if (key === undefined) throw new ModelError(builder.errors)

  const columns: ModelColumn[] = []
  const ids = new Set<string>()
  config.columns.forEach((entry, index) => {
    const at = `${field}.columns.${index}`
    if (ids.has(entry.id)) builder.fail(`${at}.id`, 'duplicate')
    ids.add(entry.id)
    if (entry.kind === 'column') {
      const expr = builder.ref(at, object, entry.column)
      if (expr !== undefined) {
        columns.push({
          id: entry.id,
          label: entry.label,
          kind: expr.kind,
          expr: { type: 'column', ...expr },
        })
      }
      return
    }
    const parts = builder.display(at, object, entry.path, entry.template)
    if (parts !== undefined) {
      columns.push({
        id: entry.id,
        label: entry.label,
        kind: 'string',
        expr: { type: 'template', parts },
      })
    }
  })

  const baseFilter: ModelCondition[] = []
  config.baseFilter.forEach((condition, index) => {
    const at = `${field}.baseFilter.${index}`
    const expr = builder.ref(at, object, condition.column)
    const valueless = condition.operator === 'null' || condition.operator === 'not_null'
    if (valueless !== (condition.value === undefined)) builder.fail(`${at}.value`, 'invalid')
    if (expr !== undefined)
      baseFilter.push({ expr, operator: condition.operator, value: condition.value })
  })

  const bindings: ModelBinding[] = []
  config.bindings.forEach((binding, index) => {
    const at = `${field}.bindings.${index}`
    const expr = builder.ref(at, object, binding.column)
    if (expr !== undefined) bindings.push({ from: binding.from, expr, operator: binding.operator })
  })

  config.searchColumns.forEach((id, index) => {
    if (!ids.has(id)) builder.fail(`${field}.searchColumns.${index}`, 'unknown_column')
  })
  if (config.sort !== null && !ids.has(config.sort.columnId)) {
    builder.fail(`${field}.sort.columnId`, 'unknown_column')
  }
  if (builder.errors.length > 0) throw new ModelError(builder.errors)

  const model = {
    object,
    key,
    joins: builder.joins,
    columns,
    baseFilter,
    bindings,
    searchColumns: config.searchColumns,
    sort: config.sort,
    pageSize: config.pageSize,
    objects: [...builder.objects].sort(),
    columnsUsed: [...builder.used.values()],
  }
  return {
    ...model,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(model))
      .digest('base64url')
      .slice(0, 22),
  }
}
