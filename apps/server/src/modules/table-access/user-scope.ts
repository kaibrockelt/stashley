// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, GrantReport, TableOp, UserScope } from '@stashley/shared'
import { columnPrivileged, columnReadable, objectPrivileges } from '../connections/grants.ts'

/**
 * The scope of the read and the write user (§9.4): what each may do beyond the table access,
 * and the statements that limit it to it. With those grants the database refuses unexposed
 * objects, excluded columns and writes above a ceiling itself, so they no longer depend on
 * Stashley's own checks alone.
 *
 * - Read user: `SELECT` on exposed objects with `read`, `SHOW VIEW` on views.
 * - Write user: `SELECT` on exposed objects with any operation, because writes check rows
 *   before and after, also through the joins of a base filter; `INSERT`, `UPDATE` and `DELETE`
 *   on tables as far as their ceiling allows.
 *
 * Excluded columns are left out of `SELECT` in both cases, and out of the write user's `INSERT`
 * and `UPDATE` (E6), which then name every other column that is not generated. Objects without
 * exclusions keep privileges on the whole object, so new columns need no new statements, and
 * nothing is limited per component: one write user serves every page.
 */

export interface ExposedObject {
  objectName: string
  objectType: 'table' | 'view'
  ops: readonly TableOp[]
  /** Columns excluded for everyone. */
  excluded: ReadonlySet<string>
}

export interface UserScopeInput {
  purpose: 'read' | 'write'
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

const writePrivileges: Record<'create' | 'update' | 'delete', string> = {
  create: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
}
const writeOps = ['create', 'update', 'delete'] as const

/**
 * What an object should get: `SELECT` on all columns, some or none; view and write rights, with
 * `INSERT` and `UPDATE` on all columns or the listed ones.
 */
interface Wanted {
  select: 'all' | string[] | null
  showView: boolean
  write: readonly ('create' | 'update' | 'delete')[]
  writeColumns: 'all' | string[]
}

const columnOps = new Set(['INSERT', 'UPDATE'])

function wantedFor(
  purpose: UserScopeInput['purpose'],
  entry: ExposedObject | undefined,
  object: CatalogObject,
): Wanted {
  if (entry === undefined) return nothing
  const write =
    purpose === 'write' && entry.objectType === 'table'
      ? writeOps.filter((op) => entry.ops.includes(op))
      : []
  const reads = entry.ops.includes('read') || write.length > 0
  if (!reads) return nothing
  const excluded = new Set([...entry.excluded].map((column) => column.toLowerCase()))
  const included = object.columns.filter((column) => !excluded.has(column.name.toLowerCase()))
  const select = excluded.size === 0 ? ('all' as const) : included.map((column) => column.name)
  const writeColumns =
    excluded.size === 0
      ? ('all' as const)
      : included.filter((column) => !column.generated).map((column) => column.name)
  return {
    select: Array.isArray(select) && select.length === 0 ? null : select,
    showView: purpose === 'read' && entry.objectType === 'view',
    // Without a column to write, `INSERT` and `UPDATE` are left out.
    write:
      writeColumns.length === 0 ? write.filter((op) => writePrivileges[op] === 'DELETE') : write,
    writeColumns,
  }
}

const nothing: Wanted = { select: null, showView: false, write: [], writeColumns: 'all' }

export function userScope(input: UserScopeInput): UserScope {
  const { report, purpose } = input
  const empty = {
    purpose,
    unexposedReadable: [],
    excludedReadable: [],
    excludedWritable: [],
    writableBeyondCeiling: [],
    statements: [],
  }
  if (report === undefined) return { ...empty, account: null, notes: ['no_grant_report'] }

  const exposed = new Map(input.exposed.map((entry) => [entry.objectName, entry]))
  const wanted = new Map(
    input.catalog.map((object) => [
      object.name,
      wantedFor(purpose, exposed.get(object.name), object),
    ]),
  )
  // Objects the read user cannot see are missing from the catalog; grants on them still show
  // in the report, so they count as well.
  const names = [
    ...new Set([
      ...input.catalog.map((object) => object.name),
      ...report.objects.map((grant) => grant.object),
    ]),
  ].sort()
  const target = (name: string) => wanted.get(name) ?? nothing
  const unexposedReadable = names.filter(
    (name) => target(name).select === null && objectPrivileges(report, name).has('SELECT'),
  )
  const excludedReadable = input.exposed
    .filter((entry) => wanted.has(entry.objectName) && target(entry.objectName).select !== null)
    .map((entry) => ({
      object: entry.objectName,
      columns: [...entry.excluded]
        .filter((column) => columnReadable(report, entry.objectName, column))
        .sort(),
    }))
    .filter((entry) => entry.columns.length > 0)
    .sort((a, b) => a.object.localeCompare(b.object))
  const excludedWritable =
    purpose === 'read'
      ? []
      : input.exposed
          .filter((entry) => wanted.has(entry.objectName) && entry.objectType === 'table')
          .map((entry) => ({
            object: entry.objectName,
            columns: [...entry.excluded]
              .filter((column) =>
                (['INSERT', 'UPDATE'] as const).some((privilege) =>
                  columnPrivileged(report, entry.objectName, column, privilege),
                ),
              )
              .sort(),
          }))
          .filter((entry) => entry.columns.length > 0)
          .sort((a, b) => a.object.localeCompare(b.object))
  const writableBeyondCeiling =
    purpose === 'read'
      ? []
      : names
          .map((name) => {
            const privileges = objectPrivileges(report, name)
            const allowed = target(name).write
            const ops = writeOps.filter(
              (op) => privileges.has(writePrivileges[op]) && !allowed.includes(op),
            )
            return { object: name, ops: [...ops] as TableOp[] }
          })
          .filter((entry) => entry.ops.length > 0)

  const global = (privilege: string) =>
    report.warnings.some(
      (warning) =>
        warning.code === 'global_privilege' &&
        (warning.privilege === privilege || warning.privilege === 'ALL PRIVILEGES'),
    )
  const notes: UserScope['notes'] = []
  if (global('SELECT')) notes.push('global_select')
  if (purpose === 'write' && ['INSERT', 'UPDATE', 'DELETE'].some(global)) notes.push('global_write')
  if (report.roles.length > 0) notes.push('roles')
  const account = report.account ?? null
  if (account === null) notes.push('account_unknown')

  const narrowed = new Set([
    ...unexposedReadable,
    ...excludedReadable.map((entry) => entry.object),
    ...excludedWritable.map((entry) => entry.object),
    ...writableBeyondCeiling.map((entry) => entry.object),
  ])
  const statements: string[] = []
  if (account !== null && narrowed.size > 0) {
    const to = quoteAccount(account)
    const schema = identifier(input.database)
    const on = (object: string) => `${schema}.${identifier(object)}`
    const relevant =
      purpose === 'read' ? ['SELECT', 'SHOW VIEW'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

    // Schema-wide privileges reach every object. Privileges on every database cannot be
    // narrowed here (`global_select`, `global_write`).
    const schemaWide = report.schemaPrivileges
    if (schemaWide.includes('ALL PRIVILEGES') && !global('ALL PRIVILEGES')) {
      statements.push(`REVOKE ALL PRIVILEGES ON ${schema}.* FROM ${to};`)
    } else {
      const revoke = relevant.filter(
        (privilege) => schemaWide.includes(privilege) && !global(privilege),
      )
      if (revoke.length > 0) {
        statements.push(`REVOKE ${revoke.join(', ')} ON ${schema}.* FROM ${to};`)
      }
    }

    // Object privileges that reach further than the object should.
    for (const grant of report.objects) {
      if (!narrowed.has(grant.object)) continue
      const wants = target(grant.object)
      const wantsPrivilege = (privilege: string) =>
        wants.write.some((op) => writePrivileges[op] === privilege)
      // Whether the privilege may stay on the whole object.
      const keep = (privilege: string) =>
        privilege === 'SELECT'
          ? wants.select === 'all'
          : privilege === 'SHOW VIEW'
            ? wants.showView
            : wantsPrivilege(privilege) &&
              (!columnOps.has(privilege) || wants.writeColumns === 'all')
      if (grant.privileges.includes('ALL PRIVILEGES')) {
        statements.push(`REVOKE ALL PRIVILEGES ON ${on(grant.object)} FROM ${to};`)
      } else {
        const revoke = relevant.filter(
          (privilege) => grant.privileges.includes(privilege) && !keep(privilege),
        )
        if (revoke.length > 0) {
          statements.push(`REVOKE ${revoke.join(', ')} ON ${on(grant.object)} FROM ${to};`)
        }
      }
      const excluded = new Set(
        [...(exposed.get(grant.object)?.excluded ?? [])].map((column) => column.toLowerCase()),
      )
      const writable = new Set(
        wants.writeColumns === 'all' ? [] : wants.writeColumns.map((name) => name.toLowerCase()),
      )
      for (const [privilege, columns] of Object.entries(grant.columns ?? {})) {
        if (!relevant.includes(privilege)) continue
        const revoke =
          privilege === 'SELECT'
            ? columns.filter(
                (column) => wants.select === null || excluded.has(column.toLowerCase()),
              )
            : !wantsPrivilege(privilege)
              ? columns
              : wants.writeColumns === 'all'
                ? []
                : columns.filter((column) => !writable.has(column.toLowerCase()))
        if (revoke.length > 0) {
          statements.push(
            `REVOKE ${privilege} (${revoke.map(identifier).join(', ')}) ON ${on(grant.object)} FROM ${to};`,
          )
        }
      }
    }

    // Exactly what the table access allows.
    for (const object of [...input.catalog].sort((a, b) => a.name.localeCompare(b.name))) {
      const wants = target(object.name)
      if (wants.select === null && wants.write.length === 0) continue
      const parts: string[] = []
      if (wants.select === 'all') parts.push('SELECT')
      else if (wants.select !== null) {
        parts.push(`SELECT (${wants.select.map(identifier).join(', ')})`)
      }
      if (wants.showView) parts.push('SHOW VIEW')
      for (const op of wants.write) {
        const privilege = writePrivileges[op]
        parts.push(
          columnOps.has(privilege) && wants.writeColumns !== 'all'
            ? `${privilege} (${wants.writeColumns.map(identifier).join(', ')})`
            : privilege,
        )
      }
      statements.push(`GRANT ${parts.join(', ')} ON ${on(object.name)} TO ${to};`)
    }
  }

  return {
    purpose,
    account,
    unexposedReadable,
    excludedReadable,
    excludedWritable,
    writableBeyondCeiling,
    statements,
    notes,
  }
}
