// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/** Types of query parameters and instance variables (architecture §10.4). */
export const paramTypes = ['string', 'integer', 'decimal', 'date', 'datetime', 'boolean'] as const
export type ParamType = (typeof paramTypes)[number]

/** Names of parameters the server always sets from the signed-in user. */
export const userContextParams = ['current_user_id', 'current_user_email'] as const
export type UserContextParam = (typeof userContextParams)[number]

export function isUserContextParam(name: string): name is UserContextParam {
  return (userContextParams as readonly string[]).includes(name)
}

/** Parameter and variable names: lower snake case, like `current_event_id`. */
export const paramNamePattern = /^[a-z_][a-z0-9_]{0,62}$/

export type ParamCheck =
  { ok: true; value: string | number | boolean } | { ok: false; code: string }

const maxStringLength = 1000
const integerPattern = /^-?(0|[1-9]\d{0,18})$/
const decimalPattern = /^-?(0|[1-9]\d{0,37})(\.\d{1,30})?$/
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

function validDate(text: string): boolean {
  const match = datePattern.exec(text)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= days
}

/**
 * Checks one value against its type and returns its canonical JSON form: integers beyond
 * the safe range and decimals stay strings, dates are `YYYY-MM-DD`, date-times are UTC
 * instants (`…Z`).
 */
export function checkParamValue(type: ParamType, value: unknown): ParamCheck {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return { ok: false, code: 'invalid' }
      if (value.length > maxStringLength) return { ok: false, code: 'too_long' }
      return { ok: true, value }
    case 'integer': {
      if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, code: 'invalid' }
      }
      if (typeof value !== 'string' || !integerPattern.test(value)) {
        return { ok: false, code: 'invalid' }
      }
      const parsed = Number(value)
      return { ok: true, value: Number.isSafeInteger(parsed) ? parsed : value }
    }
    case 'decimal': {
      const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
      if (typeof text !== 'string' || !decimalPattern.test(text)) {
        return { ok: false, code: 'invalid' }
      }
      return { ok: true, value: text }
    }
    case 'date':
      return typeof value === 'string' && validDate(value)
        ? { ok: true, value }
        : { ok: false, code: 'invalid' }
    case 'datetime': {
      if (typeof value !== 'string' || !instantPattern.test(value)) {
        return { ok: false, code: 'invalid' }
      }
      const time = Date.parse(value)
      if (!Number.isFinite(time) || !validDate(value.slice(0, 10))) {
        return { ok: false, code: 'invalid' }
      }
      return { ok: true, value: new Date(time).toISOString() }
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, code: 'invalid' }
  }
}

/** Lists of values, e.g. for `IN (:ids)`; at most this many entries. */
export const maxListLength = 1000

export type ParamListCheck =
  { ok: true; values: (string | number | boolean)[] } | { ok: false; code: string }

export function checkParamList(type: ParamType, value: unknown): ParamListCheck {
  if (!Array.isArray(value)) return { ok: false, code: 'invalid' }
  if (value.length > maxListLength) return { ok: false, code: 'too_big' }
  const values: (string | number | boolean)[] = []
  for (const item of value) {
    const checked = checkParamValue(type, item)
    if (!checked.ok) return checked
    values.push(checked.value)
  }
  return { ok: true, values }
}
