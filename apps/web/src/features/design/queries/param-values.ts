// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ParamType, QueryParameter } from '@stashley/shared'

/** Named parameters in SQL text, outside strings, quoted names and comments, in order. */
export function parameterNames(sqlText: string): string[] {
  const stripped = sqlText
    .replace(/'(?:[^'\\]|\\.|'')*'/gs, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/gs, '""')
    .replace(/`(?:[^`]|``)*`/gs, '``')
    .replace(/\/\*.*?\*\//gs, ' ')
    .replace(/(--\s|#).*$/gm, ' ')
  const names: string[] = []
  for (const match of stripped.matchAll(/(?<![:\w]):([a-z_][a-z0-9_]{0,62})\b/g)) {
    const name = match[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/** Keeps the definitions of names still used and adds new ones as optional text parameters. */
export function syncDefinitions(
  definitions: readonly QueryParameter[],
  names: readonly string[],
): QueryParameter[] {
  return names.map(
    (name) =>
      definitions.find((definition) => definition.name === name) ?? {
        name,
        type: 'string',
        list: false,
        required: false,
        defaultValue: null,
      },
  )
}

function one(type: ParamType, text: string): unknown {
  const value = text.trim()
  switch (type) {
    case 'integer':
      return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value
    case 'decimal':
      return value.replace(',', '.')
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value
    case 'datetime': {
      const time = Date.parse(value)
      return Number.isNaN(time) ? value : new Date(time).toISOString()
    }
    default:
      return value
  }
}

/** A typed test value from the editor's input; lists are comma separated. Empty is unset. */
export function testValue(definition: QueryParameter, text: string): unknown {
  if (text.trim() === '') return undefined
  if (definition.list) return text.split(',').map((part) => one(definition.type, part))
  return one(definition.type, text)
}
