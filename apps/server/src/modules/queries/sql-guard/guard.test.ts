// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { allowedStatements, corpusContext, engines, rejectedStatements } from './corpus.ts'
import { SqlGuardError } from './lexer.ts'
import { guardSql } from './validate.ts'

function code(sql: string, engine: (typeof engines)[number]): string {
  try {
    guardSql(sql, corpusContext(engine))
    return 'accepted'
  } catch (error) {
    if (error instanceof SqlGuardError) return error.code
    throw error
  }
}

describe.each(engines)('SQL validation on %s', (engine) => {
  it.each(allowedStatements)('accepts %s', (sql) => {
    expect(code(sql, engine)).toBe('accepted')
  })

  it.each(rejectedStatements)('rejects %s', (sql, expected) => {
    expect(code(sql, engine)).toBe(expected)
  })
})
