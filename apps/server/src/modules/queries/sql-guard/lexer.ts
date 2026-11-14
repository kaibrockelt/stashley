// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { paramNamePattern, type SqlProblemCode } from '@stashley/shared'

/** A rejected query; `detail` names the object, column or function, never row data. */
export class SqlGuardError extends Error {
  readonly code: SqlProblemCode
  readonly position: number | undefined
  readonly detail: string | undefined

  constructor(code: SqlProblemCode, options: { position?: number; detail?: string } = {}) {
    super(`SQL rejected: ${code}`)
    this.name = 'SqlGuardError'
    this.code = code
    this.position = options.position
    this.detail = options.detail
  }
}

export const maxSqlLength = 100_000

export interface LexResult {
  /**
   * The statement as the database will run it: comments removed, every string literal
   * rewritten in one unambiguous form, and named parameters replaced by `?`.
   */
  canonical: string
  /** `canonical` split at the parameter placeholders: segments.length = params.length + 1. */
  segments: string[]
  /** Parameter names in order of occurrence; repeated names repeat. */
  params: string[]
}

/** MySQL's whitespace; other characters (also non-ASCII spaces) are part of identifiers. */
const whitespace = new Set([' ', '\t', '\n', '\r', '\f', '\v'])
/** Identifier characters as MySQL reads unquoted names: ASCII word characters, `$`, non-ASCII. */
const wordChar = /[A-Za-z0-9_$\u0080-￿]/
/** Numbers the parser and the database read alike. Anything else starting with a digit is not. */
const numberPattern = /^(\d+|\d+\.\d*|\d+(\.\d*)?[eE][+-]?\d+|0x[0-9A-Fa-f]+|0b[01]+)$/

interface Token {
  kind: 'word' | 'other'
  text: string
  position: number
}

/**
 * Decodes the body of a quoted string the way MySQL does with backslash escapes enabled:
 * doubled quotes and backslash sequences, read in one pass from left to right.
 */
function decodeString(body: string, quote: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i)
    if (char === quote) {
      // Inside the body a quote only occurs doubled.
      out += quote
      i++
      continue
    }
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body.charAt(i + 1)
    i++
    switch (next) {
      case '0':
        out += '\0'
        break
      case 'b':
        out += '\b'
        break
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\r'
        break
      case 't':
        out += '\t'
        break
      case 'Z':
        out += '\x1a'
        break
      // `\%` and `\_` keep their backslash, so LIKE patterns still see the escape.
      case '%':
      case '_':
        out += `\\${next}`
        break
      default:
        out += next
    }
  }
  return out
}

/** One canonical form: single quotes, quotes and backslashes doubled, NUL and ^Z escaped. */
function encodeString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replaceAll('\0', '\\0')
    .replaceAll('\x1a', '\\Z')
  return `'${escaped}'`
}

/**
 * Reads the end of a quoted string or identifier starting at `start` (the opening quote).
 * Strings honour backslash escapes and doubled quotes; backtick identifiers only doubling.
 */
function readQuoted(sql: string, start: number, quote: string): number {
  const escapes = quote !== '`'
  let i = start + 1
  for (;;) {
    if (i >= sql.length) throw new SqlGuardError('unterminated', { position: start })
    const char = sql[i]
    if (escapes && char === '\\') {
      i += 2
      continue
    }
    if (char === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
}

/**
 * Lexical checks (§10.2 step 1) on the raw text, with MySQL's rules for strings, backticks
 * and every comment style. The read session runs without `ANSI_QUOTES` and without
 * `NO_BACKSLASH_ESCAPES` (§9.2), so these are the rules the database applies too. The
 * canonical text leaves the parser nothing to read differently from the database.
 */
export function lex(sql: string): LexResult {
  if (sql.length > maxSqlLength) throw new SqlGuardError('too_long')
  const segments: string[] = []
  const params: string[] = []
  const tokens: Token[] = []
  let current = ''
  let i = 0
  let ended = false

  const emit = (text: string, kind: Token['kind'], position: number) => {
    if (ended) throw new SqlGuardError('multiple_statements', { position })
    current += text
    tokens.push({ kind, text, position })
  }

  while (i < sql.length) {
    const char = sql.charAt(i)
    const next = sql.charAt(i + 1)
    if (whitespace.has(char)) {
      current += char
      i++
      continue
    }
    if (char === '#' || (char === '-' && next === '-')) {
      if (char === '-') {
        const after = sql[i + 2]
        // MySQL starts a comment only if a space or control character follows `--`.
        if (after !== undefined && !(after <= ' ' || after === '\x7f')) {
          throw new SqlGuardError('ambiguous_comment', { position: i })
        }
      }
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      current += ' '
      continue
    }
    if (char === '/' && next === '*') {
      const marker = sql[i + 2]
      if (marker === '!' || (marker === 'M' && sql[i + 3] === '!')) {
        throw new SqlGuardError('executable_comment', { position: i })
      }
      if (marker === '+') throw new SqlGuardError('optimizer_hint', { position: i })
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new SqlGuardError('unterminated', { position: i })
      i = end + 2
      current += ' '
      continue
    }
    if (char === "'" || char === '"') {
      const end = readQuoted(sql, i, char)
      emit(encodeString(decodeString(sql.slice(i + 1, end - 1), char)), 'other', i)
      i = end
      continue
    }
    if (char === '`') {
      const end = readQuoted(sql, i, '`')
      emit(sql.slice(i, end), 'other', i)
      i = end
      continue
    }
    if (char === ';') {
      if (ended) throw new SqlGuardError('multiple_statements', { position: i })
      ended = true
      i++
      continue
    }
    if (char === '?') throw new SqlGuardError('positional_placeholder', { position: i })
    if (char === '@') throw new SqlGuardError('variable_not_allowed', { position: i })
    if (char === '\\' || char < ' ' || char === '\x7f') {
      throw new SqlGuardError('unexpected_character', { position: i })
    }
    if (char === ':') {
      if (next === '=') throw new SqlGuardError('assignment_not_allowed', { position: i })
      let end = i + 1
      while (end < sql.length && wordChar.test(sql.charAt(end))) end++
      const name = sql.slice(i + 1, end)
      if (name === '') throw new SqlGuardError('unexpected_character', { position: i })
      if (!paramNamePattern.test(name)) {
        throw new SqlGuardError('invalid_parameter_name', { position: i, detail: name })
      }
      if (ended) throw new SqlGuardError('multiple_statements', { position: i })
      segments.push(current)
      current = ''
      params.push(name)
      tokens.push({ kind: 'other', text: '?', position: i })
      i = end
      continue
    }
    if (wordChar.test(char)) {
      let end = i
      // A number may contain `.` and a signed exponent; a word only word characters.
      while (end < sql.length) {
        const c = sql.charAt(end)
        if (wordChar.test(c)) {
          end++
          continue
        }
        const digitStart = /\d/.test(char)
        if (digitStart && c === '.' && /^\d*$/.test(sql.slice(i, end))) {
          end++
          continue
        }
        if (
          digitStart &&
          (c === '+' || c === '-') &&
          /[eE]$/.test(sql.slice(i, end)) &&
          /^\d+(\.\d*)?[eE]$/.test(sql.slice(i, end))
        ) {
          end++
          continue
        }
        break
      }
      const text = sql.slice(i, end)
      // MySQL reads `1abc` as an identifier and a parser may read a number; neither guess
      // is safe, so such names must be quoted.
      if (/^\d/.test(text) && !numberPattern.test(text)) {
        throw new SqlGuardError('ambiguous_identifier', { position: i, detail: text })
      }
      emit(text, /^\d/.test(text) ? 'other' : 'word', i)
      i = end
      continue
    }
    emit(char, 'other', i)
    i++
  }
  segments.push(current)
  checkKeywords(tokens)
  if (tokens.length === 0) throw new SqlGuardError('empty')
  return { canonical: segments.join('?'), segments, params }
}

/** Keywords a read-only query never needs; the parser may not know all of them (D16). */
function checkKeywords(tokens: Token[]): void {
  tokens.forEach((token, index) => {
    if (token.kind !== 'word') return
    const word = token.text.toUpperCase()
    const following = tokens[index + 1]
    // Comments are gone, so a clause is two adjacent tokens: `FOR UPDATE`, `LOCK IN`.
    const next = following?.kind === 'word' ? following.text.toUpperCase() : undefined
    if (word === 'INTO') throw new SqlGuardError('into_not_allowed', { position: token.position })
    if (word === 'PROCEDURE') throw new SqlGuardError('not_select', { position: token.position })
    if (
      (word === 'FOR' && (next === 'UPDATE' || next === 'SHARE')) ||
      (word === 'LOCK' && next === 'IN')
    ) {
      throw new SqlGuardError('locking_clause', { position: token.position })
    }
  })
}
