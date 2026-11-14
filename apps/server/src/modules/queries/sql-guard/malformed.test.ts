// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { corpusContext } from './corpus.ts'
import { SqlGuardError } from './lexer.ts'
import { checkAst, guardSql, parseCanonical } from './validate.ts'

/**
 * Trees the parser does not produce today, but a later version might. The walker must
 * reject every shape it does not understand instead of skipping it (fail-closed).
 */

const ctx = corpusContext('mysql')
type Node = Record<string, unknown>

const sel = (over: Node = {}): Node => ({
  with: null,
  type: 'select',
  options: null,
  distinct: null,
  columns: [{ expr: { type: 'number', value: 1 }, as: null }],
  into: { position: null },
  from: null,
  where: null,
  groupby: null,
  having: null,
  orderby: null,
  limit: null,
  locking_read: null,
  window: null,
  collate: null,
  ...over,
})
const col = (column: unknown, table: unknown = null): Node => ({
  type: 'column_ref',
  table,
  column,
  collate: null,
})
const from = (table: unknown, as: unknown = null): Node => ({ db: null, table, as })
const num = (value: number): Node => ({ type: 'number', value })
const fn = (name: string, args: unknown, over: unknown = null): Node => ({
  type: 'function',
  name: { name: [{ type: 'default', value: name }] },
  args,
  over,
})
const person = { from: [from('person')] }

function run(ast: Node, placeholders = 0): string {
  try {
    checkAst(ast, ctx, placeholders)
    return 'accepted'
  } catch (error) {
    if (error instanceof SqlGuardError) return error.code
    throw error
  }
}

const cases: [string, Node, string][] = [
  [
    'identifiers wrapped in expr',
    sel({
      ...person,
      columns: [{ expr: col({ expr: { type: 'default', value: 'nachname' } }), as: null }],
    }),
    'accepted',
  ],
  ['a table name that is no identifier', sel({ from: [from(5)] }), 'unsupported_syntax'],
  ['a WITH on a later set part', sel({ _next: sel({ with: [] }), set_op: 'union' }), 'accepted'],
  [
    'a non-empty WITH on a later set part',
    sel({
      _next: sel({ with: [{ name: { value: 'x' }, stmt: { ast: sel() } }] }),
      set_op: 'union',
    }),
    'unsupported_syntax',
  ],
  ['an unknown set operation', sel({ _next: sel(), set_op: 'minus' }), 'unsupported_syntax'],
  ['a set operation without name', sel({ _next: sel(), set_op: 5 }), 'unsupported_syntax'],
  ['a WITH that is no list', sel({ with: {} }), 'unsupported_syntax'],
  ['a CTE without statement', sel({ with: [{ name: { value: 'x' } }] }), 'unsupported_syntax'],
  ['a CTE without name', sel({ with: [{ name: 5, stmt: { ast: sel() } }] }), 'unsupported_syntax'],
  [
    'a CTE column list with literals',
    sel({ with: [{ name: { value: 'x' }, stmt: { ast: sel() }, columns: [num(1)] }] }),
    'unsupported_syntax',
  ],
  [
    'a CTE column list with strings',
    sel({ with: [{ name: { value: 'x' }, stmt: { ast: sel() }, columns: ['a'] }] }),
    'unsupported_syntax',
  ],
  [
    'a WITH inside a recursive anchor',
    sel({
      with: [
        {
          name: { value: 'r' },
          recursive: true,
          columns: null,
          stmt: { ast: sel({ with: [{ name: { value: 'y' }, stmt: { ast: sel() } }] }) },
        },
      ],
    }),
    'unsupported_syntax',
  ],
  [
    'a derived table that is no SELECT',
    sel({ from: [{ expr: { ast: { type: 'update' } }, as: 'x' }] }),
    'not_select',
  ],
  ['an unknown select key', sel({ straight: 1 }), 'unsupported_syntax'],
  ['an INTO target', sel({ into: { position: 'column', keyword: 'var' } }), 'into_not_allowed'],
  ['a locking clause', sel({ locking_read: 'FOR UPDATE' }), 'locking_clause'],
  ['GROUP BY as a plain list', sel({ ...person, groupby: [col('land')] }), 'accepted'],
  ['ORDER BY that is no list', sel({ orderby: {} }), 'unsupported_syntax'],
  ['an ORDER BY item that is no node', sel({ orderby: [5] }), 'unsupported_syntax'],
  ['a WINDOW clause without list', sel({ window: { expr: 5 } }), 'unsupported_syntax'],
  ['a WINDOW entry that is no node', sel({ window: { expr: [5] } }), 'unsupported_syntax'],
  ['a LIMIT that is no node', sel({ limit: 5 }), 'unsupported_syntax'],
  [
    'LIMIT ALL',
    sel({ limit: { value: [{ type: 'origin', value: 'ALL' }] } }),
    'unsupported_syntax',
  ],
  [
    'a LIMIT with a column',
    sel({ ...person, limit: { value: [col('id')] } }),
    'unsupported_syntax',
  ],
  ['FROM that is no list', sel({ from: {} }), 'unsupported_syntax'],
  ['a FROM item that is no node', sel({ from: [5] }), 'unsupported_syntax'],
  [
    'an index hint',
    sel({ from: [{ ...from('person'), index_hint: 'USE INDEX' }] }),
    'unsupported_syntax',
  ],
  [
    'a join without kind',
    sel({ from: [from('person'), { ...from('event'), join: 5 }] }),
    'unsupported_syntax',
  ],
  [
    'a natural join',
    sel({ from: [from('person'), { ...from('event'), join: 'NATURAL JOIN' }] }),
    'unsupported_syntax',
  ],
  [
    'a derived table without alias',
    sel({ from: [{ expr: { ast: sel() }, as: null }] }),
    'unsupported_syntax',
  ],
  [
    'a table function',
    sel({ from: [{ expr: { type: 'function' }, as: 'x' }] }),
    'unsupported_syntax',
  ],
  [
    'USING that is no list',
    sel({ from: [from('person'), { ...from('anmeldung'), join: 'INNER JOIN', using: {} }] }),
    'unsupported_syntax',
  ],
  [
    'a USING entry without name',
    sel({ from: [from('person'), { ...from('anmeldung'), join: 'INNER JOIN', using: [5] }] }),
    'unsupported_syntax',
  ],
  ['a star select list as text', sel({ columns: '*', from: [from('event')] }), 'accepted'],
  ['a select list that is no list', sel({ columns: 5 }), 'unsupported_syntax'],
  ['a select item that is no node', sel({ columns: [5] }), 'unsupported_syntax'],
  ['a star in WHERE', sel({ ...person, where: col('*') }), 'unsupported_syntax'],
  ['a column without name', sel({ ...person, where: col(5) }), 'unsupported_syntax'],
  [
    'a schema-qualified column',
    sel({ ...person, where: { ...col('nachname', 'person'), db: 'wanderverein' } }),
    'unsupported_syntax',
  ],
  ['a bare number in WHERE', sel({ where: 5 }), 'accepted'],
  [
    'a SELECT node inside an expression',
    sel({ where: { type: 'binary_expr', operator: '=', left: num(1), right: sel() } }),
    'accepted',
  ],
  ['a variable node', sel({ where: { type: 'var', name: 'x' } }), 'variable_not_allowed'],
  ['a named parameter node', sel({ where: { type: 'param', value: 'x' } }), 'variable_not_allowed'],
  ['a keyword that is no text', sel({ where: { type: 'origin', value: 5 } }), 'unsupported_syntax'],
  [
    'an unknown keyword',
    sel({ where: { type: 'origin', value: 'SOMETHING' } }),
    'unsupported_syntax',
  ],
  [
    'an operator that is no text',
    sel({ where: { type: 'binary_expr', operator: 5 } }),
    'unsupported_syntax',
  ],
  [
    'an unknown operator',
    sel({ where: { type: 'binary_expr', operator: 'MEMBER OF' } }),
    'unsupported_syntax',
  ],
  [
    'a unary operator that is no text',
    sel({ where: { type: 'unary_expr', operator: 5 } }),
    'unsupported_syntax',
  ],
  [
    'an unknown unary operator',
    sel({ where: { type: 'unary_expr', operator: 'EXISTS' } }),
    'unsupported_syntax',
  ],
  ['CASE without arms', sel({ where: { type: 'case', args: 5 } }), 'unsupported_syntax'],
  [
    'a CASE arm of another type',
    sel({ where: { type: 'case', args: [num(1)] } }),
    'unsupported_syntax',
  ],
  ['EXTRACT without arguments', sel({ where: { type: 'extract', args: 5 } }), 'unsupported_syntax'],
  ['a node type that is no text', sel({ where: { type: 5 } }), 'unsupported_syntax'],
  [
    'a function name that is no node',
    sel({ where: { type: 'function', name: 'ABS' } }),
    'function_not_allowed',
  ],
  [
    'a function name part that is no identifier',
    sel({ where: { type: 'function', name: { name: [5] } } }),
    'function_not_allowed',
  ],
  ['function arguments as one node', sel({ where: fn('ABS', num(1)) }), 'accepted'],
  [
    'an aggregate without name',
    sel({ where: { type: 'aggr_func', name: 5 } }),
    'function_not_allowed',
  ],
  [
    'an unknown aggregate',
    sel({ where: { type: 'aggr_func', name: 'MEDIAN' } }),
    'function_not_allowed',
  ],
  [
    'an aggregate without arguments',
    sel({ where: { type: 'aggr_func', name: 'COUNT' } }),
    'accepted',
  ],
  [
    'an aggregate ORDER BY that is no list',
    sel({
      where: { type: 'aggr_func', name: 'GROUP_CONCAT', args: { expr: num(1), orderby: {} } },
    }),
    'unsupported_syntax',
  ],
  [
    'an aggregate ORDER BY item that is no node',
    sel({
      where: { type: 'aggr_func', name: 'GROUP_CONCAT', args: { expr: num(1), orderby: [5] } },
    }),
    'unsupported_syntax',
  ],
  [
    'OVER of another type',
    sel({ where: fn('ROW_NUMBER', null, { type: 'frame' }) }),
    'unsupported_syntax',
  ],
  [
    'a window specification that is no node',
    sel({ where: fn('ROW_NUMBER', null, { type: 'window', as_window_specification: 5 }) }),
    'unsupported_syntax',
  ],
  [
    'a PARTITION BY item that is no node',
    sel({
      where: fn('ROW_NUMBER', null, {
        type: 'window',
        as_window_specification: { window_specification: { partitionby: [5] } },
      }),
    }),
    'unsupported_syntax',
  ],
  [
    'a window ORDER BY item that is no node',
    sel({
      where: fn('ROW_NUMBER', null, {
        type: 'window',
        as_window_specification: { window_specification: { orderby: [5] } },
      }),
    }),
    'unsupported_syntax',
  ],
  [
    'an unknown node type in a skipped key',
    sel({ collate: { type: 'mystery' } }),
    'unsupported_syntax',
  ],
  ['a column in a skipped key', sel({ ...person, collate: col('telefon') }), 'unsupported_syntax'],
  ['a FROM item in a skipped key', sel({ collate: from('person') }), 'unsupported_syntax'],
]

describe('the SQL walker on malformed trees', () => {
  it.each(cases)('handles %s', (_label, ast, expected) => {
    expect(run(ast)).toBe(expected)
  })

  it('requires the placeholders the lexer counted', () => {
    expect(run(sel(), 1)).toBe('parse_error')
  })

  it('accepts only one SELECT from the parser', () => {
    expect(() => parseCanonical('SELECT 1; SELECT 2', 'mysql')).toThrow(/multiple_statements/)
    expect(() => parseCanonical('SHOW TABLES', 'mariadb')).toThrow(/not_select/)
    expect(() => parseCanonical('SELEC 1', 'mariadb')).toThrow(/parse_error/)
  })

  it('counts views without known base tables as their own dependency', () => {
    expect(guardSql('SELECT x FROM v_ohne', ctx).analysis.dependencies).toEqual(['v_ohne'])
  })
})
