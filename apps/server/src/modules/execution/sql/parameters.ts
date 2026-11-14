// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError, ParamType, QueryParameter } from '@stashley/shared'
import { checkParamList, checkParamValue, isUserContextParam } from '@stashley/shared'
import type { BoundValue } from '../../queries/sql-guard/executable.ts'

/** The current value of an instance variable. */
export interface VariableBinding {
  type: ParamType
  value: string | number | boolean
}

export interface ParameterContext {
  /** Every parameter name the query uses (its analysis). */
  names: readonly string[]
  /** The manager's definitions of the selectable parameters. */
  definitions: readonly QueryParameter[]
  user: { id: string; email: string }
  variables: ReadonlyMap<string, VariableBinding>
  /** Values chosen by the client, by parameter name: page filters, URL parameters, test values. */
  input: Readonly<Record<string, unknown>>
  /** Test runs in the editor may try other values for instance variables. */
  overrideVariables?: boolean
  /** The connection's time zone; date-time values are bound as its wall time (D13). */
  timeZone: string
}

export interface ResolvedParameters {
  values: Map<string, BoundValue>
  /** Instance variables the values came from; a change of one evicts the cache entry. */
  variables: string[]
  usesUserContext: boolean
  /** Canonical form of the values, for cache keys. */
  key: string
}

/** Rejected parameter values, as field errors under `params.<name>`. */
export class ParameterError extends Error {
  readonly errors: FieldError[]

  constructor(errors: FieldError[]) {
    super('Invalid parameters')
    this.name = 'ParameterError'
    this.errors = errors
  }
}

/** A UTC instant as the wall time of a time zone, `YYYY-MM-DD HH:MM:SS[.ffffff]`. */
export function wallTime(instant: string, timeZone: string): string {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone)
  return zoned.toPlainDateTime().toString({ smallestUnit: 'microsecond' }).replace('T', ' ')
}

function bind(type: ParamType, value: string | number | boolean, timeZone: string): BoundValue {
  if (type === 'datetime') return wallTime(value as string, timeZone)
  if (type === 'boolean') return value === true ? 1 : 0
  return value
}

/**
 * Resolves every parameter of a query (§10.4), in this order: the user context, then
 * instance variables, both set by the server; then values the client chose, but only for
 * parameters the manager defined. A client value for a server-set parameter, or for a
 * name the query does not use, is rejected: filters select data, they never restrict it.
 */
export function resolveParameters(ctx: ParameterContext): ResolvedParameters {
  const errors: FieldError[] = []
  const values = new Map<string, BoundValue>()
  const canonical: [string, unknown][] = []
  const variables: string[] = []
  let usesUserContext = false
  const names = new Set(ctx.names)
  const fail = (name: string, code: string) => errors.push({ field: `params.${name}`, code })

  for (const name of Object.keys(ctx.input)) {
    if (!names.has(name)) fail(name, 'not_allowed')
  }

  for (const name of names) {
    const given = Object.hasOwn(ctx.input, name)
    if (isUserContextParam(name)) {
      if (given) fail(name, 'not_allowed')
      usesUserContext = true
      const value = name === 'current_user_id' ? ctx.user.id : ctx.user.email
      values.set(name, value)
      canonical.push([name, value])
      continue
    }
    const variable = ctx.variables.get(name)
    if (variable !== undefined) {
      let value = variable.value
      if (given) {
        if (ctx.overrideVariables !== true) {
          fail(name, 'not_allowed')
          continue
        }
        const checked = checkParamValue(variable.type, ctx.input[name])
        if (!checked.ok) {
          fail(name, checked.code)
          continue
        }
        value = checked.value
      }
      variables.push(name)
      values.set(name, bind(variable.type, value, ctx.timeZone))
      canonical.push([name, value])
      continue
    }
    const definition = ctx.definitions.find((entry) => entry.name === name)
    if (definition === undefined) {
      fail(name, 'undefined')
      continue
    }
    const raw = given ? ctx.input[name] : definition.defaultValue
    const empty = raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)
    if (empty) {
      if (definition.required) {
        fail(name, 'required')
        continue
      }
      values.set(name, definition.list ? [] : null)
      canonical.push([name, null])
      continue
    }
    if (definition.list) {
      const checked = checkParamList(definition.type, raw)
      if (!checked.ok) {
        fail(name, checked.code)
        continue
      }
      values.set(
        name,
        checked.values.map((item) => bind(definition.type, item, ctx.timeZone) as string | number),
      )
      canonical.push([name, checked.values])
      continue
    }
    const checked = checkParamValue(definition.type, raw)
    if (!checked.ok) {
      fail(name, checked.code)
      continue
    }
    values.set(name, bind(definition.type, checked.value, ctx.timeZone))
    canonical.push([name, checked.value])
  }

  if (errors.length > 0) throw new ParameterError(errors)
  canonical.sort(([a], [b]) => (a < b ? -1 : 1))
  return { values, variables, usesUserContext, key: JSON.stringify(canonical) }
}
