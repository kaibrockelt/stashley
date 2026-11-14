// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, Engine, ObjectAccess, QueryAnalysis } from '@stashley/shared'
import { hasOp, isUserContextParam } from '@stashley/shared'
import nodeSqlParser from 'node-sql-parser'
import {
  aggregateFunctions,
  allowedFunctions,
  allowedKeywords,
  deniedFunctions,
} from './functions.ts'
import { lex, SqlGuardError } from './lexer.ts'

const parser = new nodeSqlParser.Parser()

/** What the validation checks a query against. */
export interface GuardContext {
  engine: Engine
  /** The connection's own schema. */
  database: string
  catalog: ReadonlyMap<string, CatalogObject>
  /** Table access of an object; undefined when it is not exposed. */
  access: (object: string) => ObjectAccess | undefined
  /** Names of the instance variables. */
  variables: ReadonlySet<string>
}

export interface GuardResult {
  /** The canonical statement, split at its parameter placeholders. */
  segments: string[]
  params: string[]
  /** `append` adds `LIMIT ?`; `wrap` puts the statement into a derived table first (§10.4). */
  limit: 'append' | 'wrap'
  analysis: QueryAnalysis
}

const systemSchemas = new Set(['mysql', 'information_schema', 'performance_schema', 'sys'])

/** Node types the walker understands; any other type anywhere in the tree is rejected. */
const knownTypes = new Set([
  'select',
  'column_ref',
  'star',
  'number',
  'bool',
  'boolean',
  'null',
  'single_quote_string',
  'double_quote_string',
  'natural_string',
  'hex_string',
  'full_hex_string',
  'bit_string',
  'binary_expr',
  'unary_expr',
  'function',
  'aggr_func',
  'case',
  'when',
  'else',
  'cast',
  'interval',
  'expr_list',
  'origin',
  'datatype',
  'window',
  'collate',
  'ESCAPE',
  'ASC',
  'DESC',
  'extract',
  'default',
  'backticks_quote_string',
  'dual',
])

const binaryOperators = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '<=>',
  'AND',
  'OR',
  'XOR',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  'DIV',
  'MOD',
  'LIKE',
  'NOT LIKE',
  'REGEXP',
  'NOT REGEXP',
  'RLIKE',
  'NOT RLIKE',
  'IN',
  'NOT IN',
  'BETWEEN',
  'NOT BETWEEN',
  'IS',
  'IS NOT',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '->',
  '->>',
])
const unaryOperators = new Set(['NOT', '!', '-', '+', '~'])
const joins = new Set([
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'CROSS JOIN',
  'STRAIGHT_JOIN',
])
const setOperations = new Set([
  'union',
  'union all',
  'union distinct',
  'intersect',
  'intersect all',
  'intersect distinct',
  'except',
  'except all',
  'except distinct',
])
/** Keys of a select node; a key the walker does not know must be empty. */
const selectKeys = new Set([
  'with',
  'type',
  'options',
  'distinct',
  'columns',
  'into',
  'from',
  'where',
  'groupby',
  'having',
  'orderby',
  'limit',
  'locking_read',
  'window',
  'collate',
  '_next',
  'set_op',
  'parentheses_symbol',
])
const fromKeys = new Set(['db', 'table', 'as', 'join', 'on', 'using', 'expr'])

type Node = Record<string, unknown>

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)
}

/** An identifier as the parser hands it over: a string, `{ value }` or `{ expr: { value } }`. */
function ident(value: unknown): string | null {
  if (typeof value === 'string') return value.replace(/``/g, '`')
  if (isNode(value)) {
    if (typeof value.value === 'string') return value.value.replace(/``/g, '`')
    if (isNode(value.expr)) return ident(value.expr)
  }
  return null
}

function unsupported(detail: string): SqlGuardError {
  return new SqlGuardError('unsupported_syntax', { detail })
}

interface ObjectSource {
  kind: 'object'
  alias: string
  object: string
  /** Lower-case name to catalog name; MySQL column names compare case-insensitively. */
  columns: Map<string, string>
  excluded: Set<string>
}

interface DerivedSource {
  kind: 'derived'
  alias: string
  columns: Set<string>
}

type Source = ObjectSource | DerivedSource

interface Scope {
  sources: Source[]
  parent: Scope | undefined
  ctes: Map<string, Set<string>>
  /** Select-list aliases, usable in GROUP BY, HAVING and ORDER BY. */
  aliases: Set<string>
  /** Columns joined with USING; they name one column in every joined source. */
  using: Set<string>
}

function newScope(parent: Scope | undefined, ctes = new Map<string, Set<string>>()): Scope {
  return { sources: [], parent, ctes, aliases: new Set(), using: new Set() }
}

export class Walker {
  private readonly ctx: GuardContext
  readonly visited = new WeakSet<object>()
  private readonly handledWith = new WeakSet<object>()
  readonly objects = new Set<string>()
  readonly columns = new Map<string, { object: string; column: string }>()
  readonly stars = new Set<string>()
  readonly functions = new Set<string>()
  placeholders = 0

  constructor(ctx: GuardContext) {
    this.ctx = ctx
  }

  /** A statement with its UNION/INTERSECT/EXCEPT parts; returns the output column names. */
  chain(head: Node, parent: Scope | undefined): Set<string> {
    const scope = this.withClause(head, parent)
    const parts: Node[] = []
    for (let part: unknown = head; isNode(part); part = part._next) {
      if (part !== head && present(part.with)) throw unsupported('with')
      if (isNode(part._next)) {
        const operation = typeof part.set_op === 'string' ? part.set_op.toLowerCase() : ''
        if (!setOperations.has(operation)) throw unsupported(operation)
      }
      parts.push(part)
    }
    const [, ...rest] = parts
    const first = this.select(head, scope, undefined)
    for (const part of rest) this.select(part, scope, first)
    return first
  }

  /** Common table expressions; each sees the ones before it, a recursive one also itself. */
  private withClause(head: Node, parent: Scope | undefined): Scope | undefined {
    if (!present(head.with)) return parent
    if (!Array.isArray(head.with)) throw unsupported('with')
    this.handledWith.add(head)
    const scope = newScope(parent)
    for (const item of head.with) {
      if (!isNode(item) || !isNode(item.stmt) || !isNode(item.stmt.ast)) throw unsupported('with')
      const name = ident(item.name)
      if (name === null) throw unsupported('with')
      // `WITH x (a, b) AS …` lists its columns as column references.
      const explicit = Array.isArray(item.columns)
        ? item.columns.map((column) => {
            if (isNode(column)) this.visited.add(column)
            const name =
              isNode(column) && column.type === 'column_ref' ? ident(column.column) : null
            if (name === null) throw unsupported('with')
            return name.toLowerCase()
          })
        : undefined
      const body = item.stmt.ast
      if (item.recursive === true) {
        // The anchor runs before the CTE exists; the recursive parts may read it.
        const anchor = this.select(body, scope, undefined)
        scope.ctes.set(name, new Set(explicit ?? anchor))
        for (let part: unknown = body._next; isNode(part); part = part._next) {
          this.select(part, scope, anchor)
        }
      } else {
        const columns = this.chain(body, scope)
        scope.ctes.set(name, new Set(explicit ?? columns))
      }
    }
    return scope
  }

  private cte(scope: Scope | undefined, name: string): Set<string> | undefined {
    for (let current = scope; current !== undefined; current = current.parent) {
      const found = current.ctes.get(name)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** One SELECT without its set operation; `unionAliases` are the first part's columns. */
  private select(
    node: Node,
    parent: Scope | undefined,
    unionAliases: Set<string> | undefined,
  ): Set<string> {
    if (node.type !== 'select') throw new SqlGuardError('not_select')
    for (const [key, value] of Object.entries(node)) {
      if (!selectKeys.has(key) && present(value)) throw unsupported(key)
    }
    if (present(node.with) && !this.handledWith.has(node)) throw unsupported('with')
    if (present(node.options)) throw unsupported('options')
    if (isNode(node.into) && present(node.into.position))
      throw new SqlGuardError('into_not_allowed')
    if (present(node.locking_read)) throw new SqlGuardError('locking_clause')
    const scope = newScope(parent)
    this.from(node.from, scope, parent)
    const output = this.selectList(node.columns, scope)
    this.expr(node.where, scope, false)
    if (present(node.groupby)) {
      const groupBy = node.groupby
      const items = isNode(groupBy) ? groupBy.columns : groupBy
      this.expr(items, scope, true, unionAliases)
      if (isNode(groupBy)) this.expr(groupBy.modifiers, scope, false)
    }
    this.expr(node.having, scope, true, unionAliases)
    if (present(node.orderby)) {
      if (!Array.isArray(node.orderby)) throw unsupported('orderby')
      for (const item of node.orderby) {
        if (!isNode(item)) throw unsupported('orderby')
        this.expr(item.expr, scope, true, unionAliases)
      }
    }
    this.limit(node.limit)
    if (present(node.window)) {
      const window = node.window
      if (!isNode(window) || !Array.isArray(window.expr)) throw unsupported('window')
      for (const named of window.expr) {
        if (!isNode(named)) throw unsupported('window')
        this.windowSpec(named.as_window_specification, scope)
      }
    }
    return output
  }

  private limit(limit: unknown): void {
    if (!present(limit)) return
    if (!isNode(limit) || !Array.isArray(limit.value)) throw unsupported('limit')
    for (const value of limit.value) {
      if (isNode(value) && value.type === 'number') continue
      if (isNode(value) && value.type === 'origin' && value.value === '?') {
        this.placeholders++
        continue
      }
      throw unsupported('limit')
    }
  }

  private from(from: unknown, scope: Scope, parent: Scope | undefined): void {
    if (!present(from)) return
    if (!Array.isArray(from)) throw unsupported('from')
    // Derived tables see the enclosing query and its CTEs, but not their FROM siblings.
    const outer = parent
    for (const item of from) {
      if (!isNode(item)) throw unsupported('from')
      this.visited.add(item)
      if (item.type === 'dual') continue
      for (const [key, value] of Object.entries(item)) {
        if (!fromKeys.has(key) && present(value)) throw unsupported(key)
      }
      if (present(item.join)) {
        const join = typeof item.join === 'string' ? item.join.toUpperCase() : ''
        if (!joins.has(join)) throw unsupported(join)
      }
      const alias = ident(item.as)
      if (isNode(item.expr)) {
        if (!isNode(item.expr.ast) || alias === null) throw unsupported('derived table')
        const columns = this.chain(item.expr.ast, outer)
        this.addSource(scope, { kind: 'derived', alias, columns })
        continue
      }
      const table = ident(item.table)
      if (table === null) throw unsupported('from')
      const db = ident(item.db)
      if (db !== null && db !== this.ctx.database) {
        throw new SqlGuardError(
          systemSchemas.has(db.toLowerCase()) ? 'system_schema' : 'other_schema',
          {
            detail: db,
          },
        )
      }
      const cte = db === null ? this.cte(scope.parent, table) : undefined
      if (cte !== undefined) {
        this.addSource(scope, { kind: 'derived', alias: alias ?? table, columns: cte })
        continue
      }
      this.addSource(scope, this.objectSource(table, alias ?? table))
    }
    for (const item of from as Node[]) {
      this.expr(item.on, scope, false)
      if (present(item.using)) {
        if (!Array.isArray(item.using)) throw unsupported('using')
        for (const entry of item.using) {
          const name = ident(entry)
          if (name === null) throw unsupported('using')
          const lower = name.toLowerCase()
          const matches = scope.sources.filter((source) => this.sourceHas(source, lower))
          if (matches.length === 0) throw new SqlGuardError('unknown_column', { detail: name })
          for (const source of matches) this.record(source, lower, name)
          scope.using.add(lower)
        }
      }
    }
  }

  private addSource(scope: Scope, source: Source): void {
    if (scope.sources.some((existing) => existing.alias === source.alias)) {
      throw unsupported(`alias ${source.alias}`)
    }
    scope.sources.push(source)
  }

  /** An exposed, readable object; unexposed and unknown objects look the same. */
  private objectSource(object: string, alias: string): ObjectSource {
    const catalog = this.ctx.catalog.get(object)
    const access = this.ctx.access(object)
    if (catalog === undefined || access === undefined) {
      throw new SqlGuardError('object_not_exposed', { detail: object })
    }
    if (!access.active || !hasOp(access.ceiling, 'read')) {
      throw new SqlGuardError('object_not_readable', { detail: object })
    }
    this.objects.add(object)
    return {
      kind: 'object',
      alias,
      object,
      columns: new Map(catalog.columns.map((column) => [column.name.toLowerCase(), column.name])),
      excluded: new Set([...access.excluded].map((column) => column.toLowerCase())),
    }
  }

  private sourceHas(source: Source, lower: string): boolean {
    return source.columns.has(lower)
  }

  private record(source: Source, lower: string, name: string): void {
    if (source.kind === 'derived') return
    if (source.excluded.has(lower)) throw new SqlGuardError('excluded_column', { detail: name })
    // Callers check `sourceHas` first.
    const column = source.columns.get(lower) as string
    this.columns.set(`${source.object}\u0000${column}`, { object: source.object, column })
  }

  private selectList(columns: unknown, scope: Scope): Set<string> {
    const output = new Set<string>()
    const items =
      columns === '*' ? [{ expr: { type: 'column_ref', table: null, column: '*' } }] : columns
    if (!Array.isArray(items)) throw unsupported('columns')
    for (const item of items) {
      if (!isNode(item)) throw unsupported('columns')
      const expr = item.expr
      const alias = ident(item.as)
      if (isNode(expr) && expr.type === 'column_ref' && ident(expr.column) === '*') {
        this.visited.add(expr)
        for (const name of this.star(ident(expr.table), scope)) output.add(name)
        continue
      }
      this.expr(expr, scope, false)
      const name = alias ?? (isNode(expr) && expr.type === 'column_ref' ? ident(expr.column) : null)
      if (name !== null) output.add(name.toLowerCase())
      if (alias !== null) scope.aliases.add(alias.toLowerCase())
    }
    return output
  }

  /** `*` or `t.*`: allowed only on objects without excluded columns (D4). */
  private star(table: string | null, scope: Scope): Set<string> {
    const sources =
      table === null
        ? scope.sources
        : [this.alias(scope, table, true) ?? this.fail('unknown_alias', table)]
    const names = new Set<string>()
    for (const source of sources) {
      if (source.kind === 'object') {
        if (source.excluded.size > 0) {
          throw new SqlGuardError('star_on_excluded', { detail: source.object })
        }
        this.stars.add(source.object)
      }
      for (const name of source.columns.keys()) names.add(name)
    }
    return names
  }

  private fail(code: 'unknown_alias', detail: string): never {
    throw new SqlGuardError(code, { detail })
  }

  /** Finds a table alias, innermost scope first; exact names before case-insensitive ones. */
  private alias(scope: Scope, name: string, currentOnly = false): Source | undefined {
    for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
      const exact = current.sources.filter((source) => source.alias === name)
      if (exact.length === 1) return exact[0]
      const folded = current.sources.filter(
        (source) => source.alias.toLowerCase() === name.toLowerCase(),
      )
      if (folded.length > 1) throw new SqlGuardError('ambiguous_column', { detail: name })
      if (folded.length === 1) return folded[0]
      if (currentOnly) return undefined
    }
    return undefined
  }

  private column(node: Node, scope: Scope, aliases: boolean, unionAliases?: Set<string>): void {
    this.visited.add(node)
    // `schema.table.column` is not needed; the FROM clause names every object.
    if (present(node.db) || present(node.schema)) throw unsupported('column')
    const table = ident(node.table)
    const name = ident(node.column)
    if (name === null || name === '*') throw unsupported('column')
    const lower = name.toLowerCase()
    if (table !== null) {
      const source = this.alias(scope, table) ?? this.fail('unknown_alias', table)
      if (!this.sourceHas(source, lower))
        throw new SqlGuardError('unknown_column', { detail: name })
      this.record(source, lower, name)
      return
    }
    // An unqualified name that could mean an excluded column anywhere in reach is rejected,
    // whatever the database's resolution order would pick.
    for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
      for (const source of current.sources) {
        if (source.kind === 'object' && source.excluded.has(lower) && source.columns.has(lower)) {
          throw new SqlGuardError('excluded_column', { detail: name })
        }
      }
    }
    for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
      const matches = current.sources.filter((source) => this.sourceHas(source, lower))
      if (matches.length > 1 && !current.using.has(lower)) {
        throw new SqlGuardError('ambiguous_column', { detail: name })
      }
      if (matches.length > 0) {
        for (const source of matches) this.record(source, lower, name)
        return
      }
      if (aliases && current === scope && scope.aliases.has(lower)) return
    }
    if (aliases && unionAliases?.has(lower) === true) return
    throw new SqlGuardError('unknown_column', { detail: name })
  }

  expr(node: unknown, scope: Scope, aliases: boolean, unionAliases?: Set<string>): void {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const item of node) this.expr(item, scope, aliases, unionAliases)
      return
    }
    if (!isNode(node)) return
    if (isNode(node.escape)) this.expr(node.escape.value, scope, false)
    if (node.type === undefined && isNode(node.ast)) {
      // A subquery; it sees the enclosing scopes (correlated references).
      this.chain(node.ast, scope)
      return
    }
    switch (node.type) {
      case 'column_ref':
        this.column(node, scope, aliases, unionAliases)
        return
      case 'number':
      case 'bool':
      case 'boolean':
      case 'null':
      case 'single_quote_string':
      case 'double_quote_string':
      case 'natural_string':
      case 'hex_string':
      case 'full_hex_string':
      case 'bit_string':
      case 'datatype':
        return
      case 'origin': {
        const value = typeof node.value === 'string' ? node.value : ''
        if (value === '?') this.placeholders++
        else if (!allowedKeywords.has(value.toUpperCase())) throw unsupported(value)
        return
      }
      case 'binary_expr': {
        const operator = typeof node.operator === 'string' ? node.operator.toUpperCase() : ''
        if (!binaryOperators.has(operator)) throw unsupported(operator)
        this.expr(node.left, scope, aliases, unionAliases)
        this.expr(node.right, scope, aliases, unionAliases)
        return
      }
      case 'unary_expr': {
        const operator = typeof node.operator === 'string' ? node.operator.toUpperCase() : ''
        if (!unaryOperators.has(operator)) throw unsupported(operator)
        this.expr(node.expr, scope, aliases, unionAliases)
        return
      }
      case 'function':
        this.function(node, scope, aliases, unionAliases)
        return
      case 'aggr_func':
        this.aggregate(node, scope, aliases, unionAliases)
        return
      case 'case':
        this.expr(node.expr, scope, aliases, unionAliases)
        if (!Array.isArray(node.args)) throw unsupported('case')
        for (const arm of node.args) {
          if (!isNode(arm) || (arm.type !== 'when' && arm.type !== 'else'))
            throw unsupported('case')
          this.expr(arm.cond, scope, aliases, unionAliases)
          this.expr(arm.result, scope, aliases, unionAliases)
        }
        return
      case 'cast':
      case 'interval':
        this.expr(node.expr, scope, aliases, unionAliases)
        return
      case 'expr_list':
        this.expr(node.value, scope, aliases, unionAliases)
        return
      case 'extract':
        if (!isNode(node.args)) throw unsupported('extract')
        this.expr(node.args.source, scope, aliases, unionAliases)
        return
      case 'select':
        this.chain(node, scope)
        return
      case 'var':
      case 'param':
        throw new SqlGuardError('variable_not_allowed')
      default:
        throw unsupported(typeof node.type === 'string' ? node.type : 'expression')
    }
  }

  private function(node: Node, scope: Scope, aliases: boolean, unionAliases?: Set<string>): void {
    const name = isNode(node.name) ? node.name : undefined
    const parts = Array.isArray(name?.name) ? name.name : []
    const label = parts.map((part) => ident(part) ?? '').join('.')
    // A schema-qualified call is a stored function, never a built-in one.
    if (present(name?.schema) || parts.length !== 1) {
      throw new SqlGuardError('function_not_allowed', { detail: label })
    }
    const upper = label.toUpperCase()
    if (deniedFunctions.has(upper)) throw new SqlGuardError('function_denied', { detail: upper })
    if (!allowedFunctions.has(upper)) {
      throw new SqlGuardError('function_not_allowed', { detail: upper })
    }
    this.functions.add(upper)
    const args = node.args
    if (isNode(args) && args.type === 'expr_list')
      this.expr(args.value, scope, aliases, unionAliases)
    else this.expr(args, scope, aliases, unionAliases)
    this.window(node.over, scope)
  }

  private aggregate(node: Node, scope: Scope, aliases: boolean, unionAliases?: Set<string>): void {
    const upper = typeof node.name === 'string' ? node.name.toUpperCase() : ''
    if (!aggregateFunctions.has(upper)) {
      throw new SqlGuardError('function_not_allowed', { detail: upper })
    }
    this.functions.add(upper)
    const args = node.args
    if (isNode(args)) {
      if (!(isNode(args.expr) && args.expr.type === 'star')) {
        this.expr(args.expr, scope, aliases, unionAliases)
      }
      if (present(args.orderby)) {
        if (!Array.isArray(args.orderby)) throw unsupported('orderby')
        for (const item of args.orderby) {
          if (!isNode(item)) throw unsupported('orderby')
          this.expr(item.expr, scope, aliases, unionAliases)
        }
      }
      if (isNode(args.separator)) this.expr(args.separator.value, scope, false)
    }
    this.window(node.over, scope)
  }

  private window(over: unknown, scope: Scope): void {
    if (!present(over)) return
    if (!isNode(over) || over.type !== 'window') throw unsupported('over')
    this.windowSpec(over.as_window_specification, scope)
  }

  private windowSpec(spec: unknown, scope: Scope): void {
    // A named window (`OVER w`) is a plain string.
    if (typeof spec === 'string') return
    if (!isNode(spec) || !isNode(spec.window_specification)) throw unsupported('window')
    const window = spec.window_specification
    if (Array.isArray(window.partitionby)) {
      for (const item of window.partitionby) {
        if (!isNode(item)) throw unsupported('window')
        this.expr(item.expr, scope, false)
      }
    }
    if (Array.isArray(window.orderby)) {
      for (const item of window.orderby) {
        if (!isNode(item)) throw unsupported('window')
        this.expr(item.expr, scope, false)
      }
    }
    this.expr(window.window_frame_clause, scope, false)
  }
}

/**
 * Fail-closed coverage: every column reference and FROM item must have been resolved by the
 * walker, and every node type must be known. What the walker skipped cannot pass.
 */
function audit(node: unknown, walker: Walker): void {
  if (Array.isArray(node)) {
    for (const item of node) audit(item, walker)
    return
  }
  if (!isNode(node)) return
  const type = node.type
  if (typeof type === 'string' && !knownTypes.has(type)) throw unsupported(type)
  if (type === 'column_ref' && !walker.visited.has(node)) throw unsupported('column')
  if (type === undefined && 'table' in node && !walker.visited.has(node)) throw unsupported('from')
  for (const value of Object.values(node)) audit(value, walker)
}

/**
 * Parses with the connection's dialect first. node-sql-parser's MariaDB grammar rejects some
 * plain column names (`status`), so the MySQL grammar is the fallback; the canonical text
 * leaves both grammars the same tokens, and every node is walked either way.
 */
export function parseCanonical(canonical: string, engine: Engine): Node {
  const dialects = engine === 'mariadb' ? ['MariaDB', 'MySQL'] : ['MySQL', 'MariaDB']
  let ast: unknown
  let parsed = false
  for (const database of dialects) {
    try {
      ast = parser.astify(canonical, { database })
      parsed = true
      break
    } catch {
      // Try the next grammar.
    }
  }
  if (!parsed) throw new SqlGuardError('parse_error')
  if (Array.isArray(ast)) {
    if (ast.length !== 1) throw new SqlGuardError('multiple_statements')
    ast = ast[0]
  }
  if (!isNode(ast) || ast.type !== 'select') throw new SqlGuardError('not_select')
  return ast
}

/**
 * Walks a parsed statement and audits the tree; exported so tests can feed malformed trees
 * that the parser does not produce today but a later version might.
 */
export function checkAst(ast: Node, ctx: GuardContext, placeholders: number): Walker {
  const walker = new Walker(ctx)
  walker.chain(ast, undefined)
  audit(ast, walker)
  // The parser must have seen exactly the placeholders the lexer put in.
  if (walker.placeholders !== placeholders) throw new SqlGuardError('parse_error')
  return walker
}

/** Any LIMIT in the top-level statement or its set operation parts. */
function hasTopLevelLimit(head: Node): boolean {
  for (let part: unknown = head; isNode(part); part = part._next) {
    const limit = part.limit
    if (isNode(limit) && Array.isArray(limit.value) && limit.value.length > 0) return true
  }
  return false
}

/**
 * Validates a read-only query (§10.2): lexical checks, exactly one SELECT, and a walk over
 * every node that resolves names per scope against the catalog and the table access.
 */
export function guardSql(sql: string, ctx: GuardContext): GuardResult {
  const lexed = lex(sql)
  const ast = parseCanonical(lexed.canonical, ctx.engine)
  const walker = checkAst(ast, ctx, lexed.params.length)

  const dependencies = new Set<string>()
  let unknownDependencies = false
  for (const object of walker.objects) {
    dependencies.add(object)
    const entry = ctx.catalog.get(object)
    if (entry?.type === 'view') {
      if (entry.dependenciesKnown === false) unknownDependencies = true
      for (const table of entry.baseTables ?? []) dependencies.add(table)
    }
  }
  const parameters = [...new Set(lexed.params)]
  const sorted = (values: Iterable<string>) => [...values].sort()
  return {
    segments: lexed.segments,
    params: lexed.params,
    limit: hasTopLevelLimit(ast) ? 'wrap' : 'append',
    analysis: {
      objects: sorted(walker.objects),
      columns: [...walker.columns.values()].sort((a, b) =>
        `${a.object}.${a.column}`.localeCompare(`${b.object}.${b.column}`),
      ),
      stars: sorted(walker.stars),
      functions: sorted(walker.functions),
      parameters,
      variables: parameters.filter((name) => !isUserContextParam(name) && ctx.variables.has(name)),
      usesUserContext: parameters.some((name) => isUserContextParam(name)),
      dependencies: sorted(dependencies),
      unknownDependencies,
    },
  }
}
