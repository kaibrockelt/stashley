// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CredentialPurpose, GrantReport, GrantWarning, ObjectGrant } from '@stashley/shared'
import type { TargetSession } from '../../target/pools.ts'

type Level =
  | { kind: 'global' }
  | { kind: 'schema'; schema: string }
  | { kind: 'table'; schema: string; table: string }
  | { kind: 'routine'; schema: string; name: string }

export interface RoleName {
  name: string
  host?: string
}

export type ParsedGrant =
  | {
      kind: 'privileges'
      privileges: { name: string; columns?: string[] }[]
      level: Level
      grantOption: boolean
    }
  | { kind: 'roles'; roles: RoleName[] }
  | { kind: 'proxy' }
  | { kind: 'ignored' }
  | { kind: 'unparsed'; raw: string }

type Token = { type: 'ident' | 'word' | 'string' | 'punct'; value: string }

function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < line.length) {
    const char = line[i] ?? ''
    if (/\s/.test(char)) {
      i += 1
    } else if (char === '`' || char === "'" || char === '"') {
      let value = ''
      i += 1
      while (i < line.length) {
        const next = line[i] ?? ''
        if (next === char) {
          if (line[i + 1] === char) {
            value += char
            i += 2
            continue
          }
          i += 1
          break
        }
        if (next === '\\' && char !== '`') {
          value += line[i + 1] ?? ''
          i += 2
          continue
        }
        value += next
        i += 1
      }
      tokens.push({ type: char === '`' ? 'ident' : 'string', value })
    } else if (/[A-Za-z0-9_$%*\\-]/.test(char)) {
      let value = ''
      while (i < line.length && /[A-Za-z0-9_$%*\\-]/.test(line[i] ?? '')) value += line[i++]
      tokens.push({ type: 'word', value })
    } else {
      tokens.push({ type: 'punct', value: char })
      i += 1
    }
  }
  return tokens
}

const isWord = (token: Token | undefined, word: string) =>
  token?.type === 'word' && token.value.toUpperCase() === word

/** Removes password hashes and authentication clauses before a line is stored or shown. */
export function redactGrantLine(line: string): string {
  return line.replace(/\s+(IDENTIFIED|REQUIRE|WITH\s+MAX_|PASSWORD\s+EXPIRE)\b.*$/is, '')
}

function parseRoles(tokens: Token[]): RoleName[] {
  const roles: RoleName[] = []
  let current: RoleName | undefined
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    if (token.type === 'punct' && token.value === ',') {
      if (current !== undefined) roles.push(current)
      current = undefined
    } else if (token.type === 'punct' && token.value === '@' && current !== undefined) {
      const host = tokens[i + 1]
      if (host !== undefined) current.host = host.value
      i += 1
    } else if (current === undefined) {
      current = { name: token.value }
    }
  }
  if (current !== undefined) roles.push(current)
  return roles
}

function parseLevel(tokens: Token[]): Level | undefined {
  let rest = tokens
  let routine = false
  while (
    rest[0]?.type === 'word' &&
    /^(TABLE|PROCEDURE|FUNCTION|PACKAGE|BODY)$/i.test(rest[0].value)
  ) {
    if (!isWord(rest[0], 'TABLE')) routine = true
    rest = rest.slice(1)
  }
  const [first, dot, second] = rest
  if (first === undefined || dot?.value !== '.' || second === undefined || rest.length !== 3) {
    return undefined
  }
  const schemaAll = first.type !== 'ident' && first.value === '*'
  const objectAll = second.type !== 'ident' && second.value === '*'
  if (schemaAll && objectAll) return { kind: 'global' }
  if (schemaAll) return undefined
  if (routine) return { kind: 'routine', schema: first.value, name: second.value }
  if (objectAll) return { kind: 'schema', schema: first.value }
  return { kind: 'table', schema: first.value, table: second.value }
}

function parsePrivileges(tokens: Token[]): { name: string; columns?: string[] }[] {
  const privileges: { name: string; columns?: string[] }[] = []
  let words: string[] = []
  let columns: string[] | undefined
  let depth = 0
  const flush = () => {
    if (words.length === 0) return
    let name = words.join(' ').toUpperCase()
    if (name === 'ALL') name = 'ALL PRIVILEGES'
    privileges.push(columns === undefined ? { name } : { name, columns })
    words = []
    columns = undefined
  }
  for (const token of tokens) {
    if (token.type === 'punct' && token.value === '(') {
      depth += 1
      columns = []
    } else if (token.type === 'punct' && token.value === ')') {
      depth -= 1
    } else if (token.type === 'punct' && token.value === ',') {
      if (depth === 0) flush()
    } else if (depth > 0) {
      columns?.push(token.value)
    } else {
      words.push(token.value)
    }
  }
  flush()
  return privileges
}

/** Parses one line of `SHOW GRANTS` output (MariaDB or MySQL). */
export function parseGrantLine(line: string): ParsedGrant {
  const clean = redactGrantLine(line.trim())
  const tokens = tokenize(clean)
  if (isWord(tokens[0], 'REVOKE') || isWord(tokens[0], 'SET')) return { kind: 'ignored' }
  if (!isWord(tokens[0], 'GRANT')) return { kind: 'unparsed', raw: clean }
  const on = tokens.findIndex((token) => isWord(token, 'ON'))
  const to = tokens.findIndex((token) => isWord(token, 'TO'))
  if (to === -1) return { kind: 'unparsed', raw: clean }
  if (on === -1 || on > to) return { kind: 'roles', roles: parseRoles(tokens.slice(1, to)) }
  if (isWord(tokens[1], 'PROXY')) return { kind: 'proxy' }
  const level = parseLevel(tokens.slice(on + 1, to))
  if (level === undefined) return { kind: 'unparsed', raw: clean }
  const after = tokens.slice(to + 1).map((token) => token.value.toUpperCase())
  const grantOption = after.join(' ').includes('WITH GRANT OPTION')
  return {
    kind: 'privileges',
    privileges: parsePrivileges(tokens.slice(1, on)),
    level,
    grantOption,
  }
}

/** Matches a schema name of a grant; `%` and `_` are wildcards unless escaped. */
function schemaMatches(pattern: string, schema: string): { matches: boolean; wildcard: boolean } {
  if (!/(?<!\\)[%_]/.test(pattern)) {
    return { matches: pattern.replace(/\\([%_])/g, '$1') === schema, wildcard: false }
  }
  const source = pattern.replace(/\\([%_])|([%_])|([^%_\\])/g, (_m, escaped, wild, plain) => {
    if (escaped !== undefined) return escaped as string
    if (wild === '%') return '.*'
    if (wild === '_') return '.'
    return (plain as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  const matches = new RegExp(`^${source}$`, 's').test(schema)
  // `_` alone is a common literal in names; only `%` reaches clearly beyond one schema.
  return { matches, wildcard: /(?<!\\)%/.test(pattern) }
}

const required: Record<CredentialPurpose, string[]> = {
  read: ['SELECT', 'SHOW VIEW'],
  write: ['SELECT', 'INSERT', 'UPDATE'],
  schema: ['CREATE', 'INSERT'],
}

const allowed: Record<CredentialPurpose, Set<string>> = {
  read: new Set(['SELECT', 'SHOW VIEW']),
  write: new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW VIEW']),
  schema: new Set(['CREATE', 'INSERT', 'SELECT', 'SHOW VIEW']),
}

const routinePrivileges = new Set(['EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE'])

function scopeOf(level: Level): string {
  switch (level.kind) {
    case 'global':
      return '*.*'
    case 'schema':
      return `${level.schema}.*`
    case 'table':
      return `${level.schema}.${level.table}`
    case 'routine':
      return `${level.schema}.${level.name}`
  }
}

/** Builds the grant report of one database user for the target schema (§9.4). */
export function buildGrantReport(input: {
  purpose: CredentialPurpose
  database: string
  lines: string[]
  roles?: string[]
}): GrantReport {
  const global = new Set<string>()
  const schema = new Set<string>()
  const objects = new Map<string, { privileges: Set<string>; columns: Map<string, Set<string>> }>()
  const warnings = new Map<string, GrantWarning>()
  const warn = (warning: GrantWarning) =>
    warnings.set(`${warning.code}|${warning.privilege ?? ''}|${warning.scope}`, warning)
  const roles = new Set(input.roles ?? [])

  for (const line of input.lines) {
    const grant = parseGrantLine(line)
    if (grant.kind === 'proxy') warn({ code: 'proxy', scope: 'PROXY' })
    if (grant.kind === 'unparsed') warn({ code: 'unparsed', scope: grant.raw.slice(0, 200) })
    if (grant.kind === 'roles') {
      for (const role of grant.roles)
        roles.add(role.host === undefined ? role.name : `${role.name}@${role.host}`)
    }
    if (grant.kind !== 'privileges') continue
    const scope = scopeOf(grant.level)
    if (grant.grantOption) warn({ code: 'grant_option', scope })
    for (const privilege of grant.privileges) {
      const name = privilege.name
      const level = grant.level
      if (level.kind === 'global') {
        if (name === 'USAGE') continue
        global.add(name)
        warn({ code: 'global_privilege', privilege: name, scope })
        continue
      }
      if (name === 'USAGE') continue
      if (level.kind === 'routine') {
        warn({ code: 'routine_privilege', privilege: name, scope })
        continue
      }
      const match = schemaMatches(level.schema, input.database)
      if (!match.matches || (level.kind === 'schema' && match.wildcard)) {
        warn({ code: 'other_schema', privilege: name, scope })
      }
      if (!match.matches) continue
      if (level.kind === 'schema') {
        schema.add(name)
      } else {
        const entry = objects.get(level.table) ?? {
          privileges: new Set<string>(),
          columns: new Map<string, Set<string>>(),
        }
        objects.set(level.table, entry)
        if (privilege.columns === undefined) entry.privileges.add(name)
        else {
          const columns = entry.columns.get(name) ?? new Set<string>()
          for (const column of privilege.columns) columns.add(column)
          entry.columns.set(name, columns)
        }
      }
      if (routinePrivileges.has(name)) warn({ code: 'routine_privilege', privilege: name, scope })
      else if (!allowed[input.purpose].has(name)) {
        warn({ code: 'excess_privilege', privilege: name, scope })
      }
    }
  }

  const has = (privilege: string) => {
    const test = (set: Set<string>) => set.has(privilege) || set.has('ALL PRIVILEGES')
    if (test(global) || test(schema)) return true
    for (const entry of objects.values()) {
      if (test(entry.privileges) || entry.columns.has(privilege)) return true
    }
    return false
  }

  const objectGrants: ObjectGrant[] = [...objects.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([object, entry]) => ({
      object,
      privileges: [...entry.privileges].sort(),
      ...(entry.columns.size > 0 && {
        columns: Object.fromEntries(
          [...entry.columns.entries()].map(([name, columns]) => [name, [...columns].sort()]),
        ),
      }),
    }))

  return {
    purpose: input.purpose,
    required: required[input.purpose],
    missing: required[input.purpose].filter((privilege) => !has(privilege)),
    warnings: [...warnings.values()],
    schemaPrivileges: [...new Set([...global, ...schema])].sort(),
    objects: objectGrants,
    roles: [...roles].sort(),
  }
}

/** Privileges a report grants on one object, with `ALL PRIVILEGES` expanded. */
export function objectPrivileges(report: GrantReport, object: string): Set<string> {
  const result = new Set(report.schemaPrivileges)
  const entry = report.objects.find((grant) => grant.object === object)
  for (const privilege of entry?.privileges ?? []) result.add(privilege)
  for (const privilege of Object.keys(entry?.columns ?? {})) result.add(privilege)
  if (result.has('ALL PRIVILEGES')) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW VIEW'])
      result.add(privilege)
  }
  return result
}

function quoteRole(role: RoleName): string {
  const quote = (value: string) => `\`${value.replace(/`/g, '``')}\``
  return role.host === undefined ? quote(role.name) : `${quote(role.name)}@${quote(role.host)}`
}

async function showGrants(session: TargetSession, statement: string): Promise<string[]> {
  const rows = await session.query<Record<string, string>>(statement)
  return rows.map((row) => String(Object.values(row)[0] ?? ''))
}

/**
 * Reads the grants of the connected user, including granted roles: MySQL through
 * `SHOW GRANTS … USING`, MariaDB by reading each role's grants (roles of roles included).
 */
export async function inspectGrants(
  session: TargetSession,
  purpose: CredentialPurpose,
  database: string,
): Promise<GrantReport> {
  const own = await showGrants(session, 'SHOW GRANTS FOR CURRENT_USER()')
  const granted = own.flatMap((line) => {
    const grant = parseGrantLine(line)
    return grant.kind === 'roles' ? grant.roles : []
  })
  const lines = [...own]
  if (granted.length > 0 && session.engine === 'mysql') {
    const using = granted.map(quoteRole).join(', ')
    lines.push(...(await showGrants(session, `SHOW GRANTS FOR CURRENT_USER() USING ${using}`)))
  } else if (granted.length > 0) {
    const seen = new Set<string>()
    const queue = [...granted]
    while (queue.length > 0 && seen.size < 50) {
      const role = queue.shift()
      if (role === undefined || seen.has(role.name)) continue
      seen.add(role.name)
      const roleLines = await showGrants(session, `SHOW GRANTS FOR ${quoteRole(role)}`).catch(
        () => [] as string[],
      )
      lines.push(...roleLines)
      for (const line of roleLines) {
        const grant = parseGrantLine(line)
        if (grant.kind === 'roles') queue.push(...grant.roles)
      }
    }
  }
  return buildGrantReport({ purpose, database, lines })
}
