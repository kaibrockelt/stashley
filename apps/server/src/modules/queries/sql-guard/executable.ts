// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The executable form of a query version (§10.4), stored with it: the canonical statement
 * split at its placeholders, the parameter names in placeholder order, and how the
 * server-side limit is added.
 */
export interface Executable {
  segments: string[]
  params: string[]
  limit: 'append' | 'wrap'
}

/** A bound parameter value; lists expand to one placeholder per entry. */
export type BoundValue = string | number | boolean | null | (string | number | boolean)[]

export interface Statement {
  sql: string
  values: unknown[]
}

/**
 * Builds the statement for one run with `limit` rows. If the query has no LIMIT of its
 * own, `LIMIT ?` is appended (after a line break, so a trailing comment cannot swallow it);
 * otherwise it is wrapped as a derived table so its own LIMIT and order stay intact.
 */
export function buildStatement(
  executable: Executable,
  values: ReadonlyMap<string, BoundValue>,
  limit: number,
): Statement {
  if (executable.segments.length !== executable.params.length + 1) {
    throw new Error('Executable form is inconsistent')
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid limit')
  let sql = ''
  const bound: unknown[] = []
  executable.segments.forEach((segment, index) => {
    sql += segment
    const name = executable.params[index]
    if (name === undefined) return
    if (!values.has(name)) throw new Error(`Unbound parameter ${name}`)
    const value = values.get(name) as BoundValue
    if (Array.isArray(value)) {
      // An empty list matches nothing: `IN (NULL)` is never true.
      if (value.length === 0) {
        sql += 'NULL'
      } else {
        sql += value.map(() => '?').join(', ')
        bound.push(...value)
      }
    } else {
      sql += '?'
      bound.push(value)
    }
  })
  const statement =
    executable.limit === 'append'
      ? `${sql}\nLIMIT ?`
      : `SELECT * FROM (\n${sql}\n) AS stashley_q LIMIT ?`
  return { sql: statement, values: [...bound, limit] }
}
