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
  | { kind: 'roles'; roles: RoleName[]; grantee: RoleName | undefined; adminOption: boolean }
  | { kind: 'revoke'; privileges: { name: string }[]; schema: string }
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
  if (isWord(tokens[0], 'SET')) return { kind: 'ignored' }
  if (isWord(tokens[0], 'REVOKE')) {
    // MySQL partial revokes: `REVOKE DELETE ON `db`.* FROM …` restricts a global privilege.
    const on = tokens.findIndex((token) => isWord(token, 'ON'))
    const from = tokens.findIndex((token) => isWord(token, 'FROM'))
    const level = on === -1 || from < on ? undefined : parseLevel(tokens.slice(on + 1, from))
    if (level?.kind !== 'schema') return { kind: 'ignored' }
    return {
      kind: 'revoke',
      privileges: parsePrivileges(tokens.slice(1, on)),
      schema: level.schema,
    }
  }
  if (!isWord(tokens[0], 'GRANT')) return { kind: 'unparsed', raw: clean }
  const on = tokens.findIndex((token) => isWord(token, 'ON'))
  const to = tokens.findIndex((token) => isWord(token, 'TO'))
  if (to === -1) return { kind: 'unparsed', raw: clean }
  if (on === -1 || on > to) {
    const [grantee] = parseRoles(tokens.slice(to + 1))
    return {
      kind: 'roles',
      roles: parseRoles(tokens.slice(1, to)),
      grantee,
      adminOption: hasOption(line, 'ADMIN'),
    }
  }
  if (isWord(tokens[1], 'PROXY')) return { kind: 'proxy' }
  const level = parseLevel(tokens.slice(on + 1, to))
  if (level === undefined) return { kind: 'unparsed', raw: clean }
  return {
    kind: 'privileges',
    privileges: parsePrivileges(tokens.slice(1, on)),
    level,
    grantOption: hasOption(line, 'GRANT'),
  }
}

/**
 * Looks for `WITH GRANT OPTION` or `WITH ADMIN OPTION` in the unredacted line. MariaDB writes
 * them after the authentication clause (`… IDENTIFIED BY PASSWORD '*…' WITH GRANT OPTION`),
 * which the redaction removes. Quoted strings are single tokens, so a password cannot fake it.
 */
function hasOption(line: string, kind: 'GRANT' | 'ADMIN'): boolean {
  const tokens = tokenize(line.trim())
  const to = tokens.findIndex((token) => isWord(token, 'TO'))
  return tokens
    .slice(to + 1)
    .some(
      (token, index, rest) =>
        isWord(token, 'WITH') && isWord(rest[index + 1], kind) && isWord(rest[index + 2], 'OPTION'),
    )
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

/** SHOW VIEW is checked per exposed view (`view_dependencies_unknown`), not for the schema. */
const required: Record<CredentialPurpose, string[]> = {
  read: ['SELECT'],
  write: ['SELECT', 'INSERT', 'UPDATE'],
  schema: ['CREATE', 'INSERT'],
}

const allowed: Record<CredentialPurpose, Set<string>> = {
  read: new Set(['SELECT', 'SHOW VIEW']),
  write: new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW VIEW']),
  schema: new Set(['CREATE', 'INSERT', 'SELECT', 'SHOW VIEW']),
}

const routinePrivileges = new Set(['EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE'])

/** The privileges Stashley can use, which `ALL PRIVILEGES` stands for in its checks. */
const allPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW VIEW', 'CREATE']

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

/**
 * Builds the grant report of one database user for the target schema (§9.4). Required,
 * missing and granted privileges come from `lines`, the grants in effect for Stashley's own
 * sessions. Warnings also cover `roleLines`: privileges of granted roles that a session
 * would have to activate with `SET ROLE`, which Stashley never does.
 */
export function buildGrantReport(input: {
  purpose: CredentialPurpose
  database: string
  lines: string[]
  roleLines?: string[]
  /** Granted roles that are not active when the user signs in. */
  inactiveRoles?: string[]
  /** Granted roles whose privileges could not be read. */
  unreadableRoles?: string[]
  roles?: string[]
}): GrantReport {
  const global = new Set<string>()
  const schema = new Set<string>()
  const objects = new Map<string, { privileges: Set<string>; columns: Map<string, Set<string>> }>()
  const warnings = new Map<string, GrantWarning>()
  const warn = (warning: GrantWarning) =>
    warnings.set(`${warning.code}|${warning.privilege ?? ''}|${warning.scope}`, warning)
  const roles = new Set(input.roles ?? [])
  const lines = [
    ...input.lines.map((line) => ({ line, effective: true })),
    ...(input.roleLines ?? []).map((line) => ({ line, effective: false })),
  ]
  const addPrivilege = (
    level: Extract<Level, { kind: 'schema' | 'table' }>,
    name: string,
    columns: string[] | undefined,
  ) => {
    if (level.kind === 'schema') {
      schema.add(name)
      return
    }
    const entry = objects.get(level.table) ?? {
      privileges: new Set<string>(),
      columns: new Map<string, Set<string>>(),
    }
    objects.set(level.table, entry)
    if (columns === undefined) {
      entry.privileges.add(name)
      return
    }
    const granted = entry.columns.get(name) ?? new Set<string>()
    for (const column of columns) granted.add(column)
    entry.columns.set(name, granted)
  }

  // Partial revokes on the target schema, which only restrict global privileges.
  const revoked = new Set<string>()

  for (const { line, effective } of lines) {
    const grant = parseGrantLine(line)
    if (grant.kind === 'proxy') warn({ code: 'proxy', scope: 'PROXY' })
    if (grant.kind === 'unparsed') warn({ code: 'unparsed', scope: grant.raw.slice(0, 200) })
    if (grant.kind === 'revoke' && effective && grant.schema === input.database) {
      for (const privilege of grant.privileges) revoked.add(privilege.name)
    }
    if (grant.kind === 'roles') {
      for (const role of grant.roles) {
        const key = role.host === undefined ? role.name : `${role.name}@${role.host}`
        roles.add(key)
        // The account may grant this role to others.
        if (grant.adminOption) warn({ code: 'grant_option', scope: key })
      }
    }
    if (grant.kind !== 'privileges') continue
    const scope = scopeOf(grant.level)
    if (grant.grantOption) warn({ code: 'grant_option', scope })
    for (const privilege of grant.privileges) {
      const name = privilege.name
      const level = grant.level
      if (level.kind === 'global') {
        if (name === 'USAGE') continue
        if (effective) global.add(name)
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
      // Privileges of inactive roles only produce warnings.
      if (effective) addPrivilege(level, name, privilege.columns)
      if (routinePrivileges.has(name)) warn({ code: 'routine_privilege', privilege: name, scope })
      else if (!allowed[input.purpose].has(name)) {
        warn({ code: 'excess_privilege', privilege: name, scope })
      }
    }
  }

  for (const role of input.inactiveRoles ?? []) warn({ code: 'inactive_role', scope: role })
  for (const role of input.unreadableRoles ?? []) warn({ code: 'role_unreadable', scope: role })

  // A partial revoke takes a global privilege away on the target schema. `ALL PRIVILEGES` is
  // spelled out first, so one revoked privilege does not take the others with it.
  if (revoked.size > 0) {
    if (global.delete('ALL PRIVILEGES')) for (const name of allPrivileges) global.add(name)
    for (const name of revoked) global.delete(name)
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

/**
 * Whether a report grants a privilege on one column of an object: through a privilege on every
 * database, the schema or the object, or a column privilege that names it. Column names
 * compare case-insensitively, like MySQL.
 */
export function columnPrivileged(
  report: GrantReport,
  object: string,
  column: string,
  privilege: 'SELECT' | 'INSERT' | 'UPDATE',
): boolean {
  const columns = privilegedColumns(report, object, privilege)
  if (columns === null) return true
  const lower = column.toLowerCase()
  return columns.some((name) => name.toLowerCase() === lower)
}

/** Whether a report lets the user select one column of an object. */
export function columnReadable(report: GrantReport, object: string, column: string): boolean {
  return columnPrivileged(report, object, column, 'SELECT')
}

/**
 * The columns of an object a privilege covers: null when it covers every column (granted on
 * every database, the schema or the object), otherwise the columns of its column privileges,
 * possibly none.
 */
export function privilegedColumns(
  report: GrantReport,
  object: string,
  privilege: 'SELECT' | 'INSERT' | 'UPDATE',
): string[] | null {
  const covers = (privileges: readonly string[]) =>
    privileges.includes(privilege) || privileges.includes('ALL PRIVILEGES')
  if (covers(report.schemaPrivileges)) return null
  const entry = report.objects.find((grant) => grant.object === object)
  if (entry === undefined) return []
  if (covers(entry.privileges)) return null
  return [...(entry.columns?.[privilege] ?? [])]
}

function quoteRole(role: RoleName): string {
  const quote = (value: string) => `\`${value.replace(/`/g, '``')}\``
  return role.host === undefined ? quote(role.name) : `${quote(role.name)}@${quote(role.host)}`
}

async function showGrants(session: TargetSession, statement: string): Promise<string[]> {
  const rows = await session.query<Record<string, string>>(statement)
  return rows.map((row) => String(Object.values(row)[0] ?? ''))
}

const roleKey = (role: RoleName) =>
  role.host === undefined ? role.name : `${role.name}@${role.host}`

/** Roles granted to the account itself; role-to-role grants (no host) are left out. */
export function grantedRoles(lines: string[]): RoleName[] {
  const roles = new Map<string, RoleName>()
  for (const line of lines) {
    const grant = parseGrantLine(line)
    if (grant.kind !== 'roles' || grant.grantee?.host === undefined) continue
    for (const role of grant.roles) roles.set(roleKey(role), role)
  }
  return [...roles.values()]
}

/** Roles active in this session: MariaDB returns one name, MySQL a quoted list or `NONE`. */
export function parseCurrentRoles(engine: TargetSession['engine'], value: string | null): string[] {
  if (value === null || value === '' || value === 'NONE') return []
  if (engine === 'mariadb') return [value]
  return parseRoles(tokenize(value)).map(roleKey)
}

/**
 * Reads the privileges of granted roles that are not active at sign-in. MySQL activates
 * them all at once; MariaDB allows one role at a time, whose grants include its own roles.
 */
async function readInactiveRoles(
  session: TargetSession,
  inactive: RoleName[],
  active: string[],
): Promise<{ lines: string[]; unreadable: string[] }> {
  const lines: string[] = []
  const unreadable: string[] = []
  try {
    if (session.engine === 'mysql') {
      try {
        await session.query('SET ROLE ALL')
        lines.push(...(await showGrants(session, 'SHOW GRANTS')))
      } catch {
        unreadable.push(...inactive.map(roleKey))
      }
      return { lines, unreadable }
    }
    for (const role of inactive) {
      try {
        await session.query(`SET ROLE ${quoteRole({ name: role.name })}`)
        lines.push(...(await showGrants(session, 'SHOW GRANTS FOR CURRENT_ROLE')))
      } catch {
        unreadable.push(roleKey(role))
      }
    }
    return { lines, unreadable }
  } finally {
    // Back to the roles of sign-in, in case the session is used further.
    const restore =
      session.engine === 'mysql'
        ? 'SET ROLE DEFAULT'
        : `SET ROLE ${active[0] === undefined ? 'NONE' : quoteRole({ name: active[0] })}`
    await session.query(restore).catch(() => undefined)
  }
}

/**
 * Reads the grants of the connected user (§9.4). `SHOW GRANTS` lists what Stashley's own
 * sessions get: the user's privileges, its roles active at sign-in (with their roles) and,
 * on MariaDB, `PUBLIC`. Every other granted role is read too, for warnings only, because
 * Stashley never runs `SET ROLE`. Call it on a connection that is closed afterwards.
 */
export async function inspectGrants(
  session: TargetSession,
  purpose: CredentialPurpose,
  database: string,
): Promise<GrantReport> {
  const lines = await showGrants(session, 'SHOW GRANTS')
  const [current] = await session.query<{ role: string | null; account: string | null }>(
    'SELECT CURRENT_ROLE() AS role, CURRENT_USER() AS account',
  )
  const account = current?.account ?? undefined
  const active = parseCurrentRoles(session.engine, current?.role ?? null)
  const inactive = grantedRoles(lines).filter((role) => !active.includes(roleKey(role)))
  const report =
    inactive.length === 0
      ? buildGrantReport({ purpose, database, lines })
      : await readInactiveRoles(session, inactive, active).then((extra) =>
          buildGrantReport({
            purpose,
            database,
            lines,
            roleLines: extra.lines,
            inactiveRoles: inactive.map(roleKey),
            unreadableRoles: extra.unreadable,
          }),
        )
  return account === undefined ? report : { ...report, account }
}
