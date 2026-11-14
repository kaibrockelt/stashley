// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, GrantReport, ReadScope } from '@stashley/shared'
import { columnReadable, objectPrivileges } from '../connections/grants.ts'

/**
 * The read user's scope (§9.4): what it may read beyond the exposed objects and columns, and
 * the statements that limit it to them. With those grants the database refuses unexposed
 * objects and excluded columns itself, so they no longer depend on the SQL validation alone.
 */

export interface ExposedObject {
  objectName: string
  objectType: 'table' | 'view'
  /** `read` is in the ceiling; only such objects are granted to the read user. */
  readable: boolean
  /** Columns excluded for everyone. */
  excluded: ReadonlySet<string>
}

export interface ReadScopeInput {
  database: string
  report: GrantReport | undefined
  catalog: readonly CatalogObject[]
  exposed: readonly ExposedObject[]
}

const identifier = (name: string) => `\`${name.replace(/`/g, '``')}\``
/** A string literal as the server reads it with backslash escapes on (the default). */
const literal = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`

/** `user@host` from `CURRENT_USER()` as a quoted account; the host never contains `@`. */
export function quoteAccount(account: string): string {
  const at = account.lastIndexOf('@')
  if (at === -1) return literal(account)
  return `${literal(account.slice(0, at))}@${literal(account.slice(at + 1))}`
}

const covers = (privileges: readonly string[], name: string) =>
  privileges.includes(name) || privileges.includes('ALL PRIVILEGES')

export function readScope(input: ReadScopeInput): ReadScope {
  const { report } = input
  if (report === undefined) {
    return {
      account: null,
      unexposedReadable: [],
      excludedReadable: [],
      statements: [],
      notes: ['no_grant_report'],
    }
  }
  const readable = new Map(
    input.exposed.filter((entry) => entry.readable).map((entry) => [entry.objectName, entry]),
  )
  const unexposedReadable = input.catalog
    .map((object) => object.name)
    .filter((name) => !readable.has(name) && objectPrivileges(report, name).has('SELECT'))
    .sort()
  const excludedReadable = [...readable.values()]
    .map((entry) => ({
      object: entry.objectName,
      columns: [...entry.excluded]
        .filter((column) => columnReadable(report, entry.objectName, column))
        .sort(),
    }))
    .filter((entry) => entry.columns.length > 0)
    .sort((a, b) => a.object.localeCompare(b.object))

  const notes: ReadScope['notes'] = []
  const global = (privilege: string) =>
    report.warnings.some(
      (warning) =>
        warning.code === 'global_privilege' &&
        (warning.privilege === privilege || warning.privilege === 'ALL PRIVILEGES'),
    )
  if (global('SELECT')) notes.push('global_select')
  if (report.roles.length > 0) notes.push('roles')
  const account = report.account ?? null
  if (account === null) notes.push('account_unknown')

  const needed = unexposedReadable.length > 0 || excludedReadable.length > 0
  const statements: string[] = []
  if (account !== null && needed) {
    const to = quoteAccount(account)
    const schema = identifier(input.database)
    const on = (object: string) => `${schema}.${identifier(object)}`

    // Schema-wide privileges reach every object; privileges on every database cannot be
    // narrowed here (`global_select`).
    const schemaWide = report.schemaPrivileges
    if (schemaWide.includes('ALL PRIVILEGES') && !global('ALL PRIVILEGES')) {
      statements.push(`REVOKE ALL PRIVILEGES ON ${schema}.* FROM ${to};`)
    } else {
      const revoke = ['SELECT', 'SHOW VIEW'].filter(
        (privilege) => schemaWide.includes(privilege) && !global(privilege),
      )
      if (revoke.length > 0)
        statements.push(`REVOKE ${revoke.join(', ')} ON ${schema}.* FROM ${to};`)
    }

    // Object privileges that reach an unexposed object or an excluded column.
    const narrowed = new Set([
      ...unexposedReadable,
      ...excludedReadable.map((entry) => entry.object),
    ])
    for (const grant of report.objects) {
      if (!narrowed.has(grant.object)) continue
      if (covers(grant.privileges, 'SELECT')) {
        statements.push(`REVOKE SELECT ON ${on(grant.object)} FROM ${to};`)
        continue
      }
      const excluded = readable.get(grant.object)?.excluded
      const columns = (grant.columns?.SELECT ?? []).filter(
        (column) =>
          excluded === undefined ||
          [...excluded].some((name) => name.toLowerCase() === column.toLowerCase()),
      )
      if (columns.length > 0) {
        statements.push(
          `REVOKE SELECT (${columns.map(identifier).join(', ')}) ON ${on(grant.object)} FROM ${to};`,
        )
      }
    }

    // Exactly the exposed objects, and of objects with exclusions only the other columns.
    const catalog = new Map(input.catalog.map((object) => [object.name, object]))
    for (const entry of [...readable.values()].sort((a, b) =>
      a.objectName.localeCompare(b.objectName),
    )) {
      const object = catalog.get(entry.objectName)
      if (object === undefined) continue
      const extra = entry.objectType === 'view' ? ', SHOW VIEW' : ''
      const excluded = new Set([...entry.excluded].map((column) => column.toLowerCase()))
      if (excluded.size === 0) {
        statements.push(`GRANT SELECT${extra} ON ${on(entry.objectName)} TO ${to};`)
        continue
      }
      const columns = object.columns
        .map((column) => column.name)
        .filter((name) => !excluded.has(name.toLowerCase()))
      if (columns.length === 0) continue
      statements.push(
        `GRANT SELECT (${columns.map(identifier).join(', ')})${extra} ON ${on(entry.objectName)} TO ${to};`,
      )
    }
  }

  return { account, unexposedReadable, excludedReadable, statements, notes }
}
