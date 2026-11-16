// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '../../platform/http/problem.ts'
import type { VariableValue } from '../variables/service.ts'
import { bindForColumn, type ValueOptions } from './sql/table-sql.ts'
import type { TableModel } from './sql/table-model.ts'

/**
 * Base filter values of one request (§ Basisfilter): constants, instance variables and the
 * user context, typed for their columns. Reads and writes use the same values. A missing
 * instance variable fails the request: without its value the filter would restrict nothing.
 */
export function resolveBaseValues(
  model: TableModel,
  /** Null for API tokens, which have no base filter; a user condition then fails closed. */
  user: { id: string; email: string } | null,
  variables: ReadonlyMap<string, VariableValue>,
  options: ValueOptions,
): { values: unknown[]; variables: string[] } {
  const used: string[] = []
  const values = model.baseFilter.map((condition, index) => {
    const value = condition.value
    if (value === undefined) return undefined
    let raw: unknown
    if (value.kind === 'constant') raw = value.value
    else if (value.kind === 'user') {
      if (user === null) throw new AppError('forbidden')
      raw = value.field === 'id' ? user.id : user.email
    } else {
      const variable = variables.get(value.name)
      if (variable === undefined) {
        throw new AppError('query_failed', {
          errors: [{ field: `baseFilter.${index}`, code: 'variable_missing' }],
        })
      }
      used.push(value.name)
      raw = variable.value
    }
    const bind = (item: unknown) => {
      const checked = bindForColumn(condition.expr.kind, item, options)
      if (!checked.ok) {
        throw new AppError('query_failed', {
          errors: [{ field: `baseFilter.${index}`, code: checked.code }],
        })
      }
      return checked.value
    }
    if (condition.operator === 'in') return (Array.isArray(raw) ? raw : [raw]).map(bind)
    return bind(raw)
  })
  return { values, variables: used }
}
