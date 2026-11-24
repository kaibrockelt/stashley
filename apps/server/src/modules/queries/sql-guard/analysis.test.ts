// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { corpusContext } from './corpus.ts'
import { buildStatement, type BoundValue } from './executable.ts'
import { lex, maxSqlLength, SqlGuardError } from './lexer.ts'
import { guardSql } from './validate.ts'

const ctx = corpusContext('mariadb')

describe('lexer', () => {
  it('rewrites strings into one canonical form and drops comments', () => {
    const lexed = lex(
      "SELECT 'it''s', \"say \"\"hi\"\"\", 'a\\'b', 'c\\\\d', 'x\\%y', 'nul\\0z' -- note\nFROM t /* c */ # end",
    )
    expect(lexed.canonical).toBe(
      "SELECT 'it''s', 'say \"hi\"', 'a''b', 'c\\\\d', 'x\\\\%y', 'nul\\0z'  \nFROM t    ",
    )
    expect(lex("SELECT 'a\\nb\\tc\\Zd\\re\\bf\\qg'").canonical).toBe("SELECT 'a\nb\tc\\Zd\re\bfqg'")
  })

  it('replaces named parameters and splits the statement at them', () => {
    const lexed = lex("SELECT a FROM t WHERE b = :x AND c IN (:ids) AND d = ':y' AND e = :x")
    expect(lexed.params).toEqual(['x', 'ids', 'x'])
    expect(lexed.segments).toEqual([
      'SELECT a FROM t WHERE b = ',
      ' AND c IN (',
      ") AND d = ':y' AND e = ",
      '',
    ])
    expect(lexed.canonical).toBe("SELECT a FROM t WHERE b = ? AND c IN (?) AND d = ':y' AND e = ?")
  })

  it('keeps backtick identifiers and numbers as written', () => {
    expect(lex('SELECT `a``b`, 1.5e+3, 0x1F, 12 FROM `t`').canonical).toBe(
      'SELECT `a``b`, 1.5e+3, 0x1F, 12 FROM `t`',
    )
  })

  it('rejects oversized input and control characters', () => {
    expect(() => lex('x'.repeat(maxSqlLength + 1))).toThrow(SqlGuardError)
    expect(() => lex('SELECT 1\u0000')).toThrow(/unexpected_character/)
    expect(() => lex('SELECT 1 -- note')).not.toThrow()
    expect(() => lex('SELECT 1 --')).not.toThrow()
  })

  it('reports the position of a problem', () => {
    try {
      lex('SELECT 1 /*! x */')
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: 'executable_comment', position: 9 })
    }
  })
})

describe('analysis', () => {
  it('lists objects, columns, functions, parameters and dependencies', () => {
    const result = guardSql(
      `SELECT p.nachname, COUNT(*) AS n, MAX(z.betrag)
         FROM person p
         JOIN anmeldung a ON a.person_id = p.id
         JOIN v_zahlungsstatus v ON v.anmeldung_id = a.id
         LEFT JOIN zahlung z ON z.anmeldung_id = a.id
        WHERE a.event_id = :current_event_id AND p.email <> :current_user_email AND v.status = :status
        GROUP BY p.nachname`,
      ctx,
    )
    expect(result.analysis).toEqual({
      objects: ['anmeldung', 'person', 'v_zahlungsstatus', 'zahlung'],
      columns: [
        { object: 'anmeldung', column: 'event_id' },
        { object: 'anmeldung', column: 'id' },
        { object: 'anmeldung', column: 'person_id' },
        { object: 'person', column: 'email' },
        { object: 'person', column: 'id' },
        { object: 'person', column: 'nachname' },
        { object: 'v_zahlungsstatus', column: 'anmeldung_id' },
        { object: 'v_zahlungsstatus', column: 'status' },
        { object: 'zahlung', column: 'anmeldung_id' },
        { object: 'zahlung', column: 'betrag' },
      ],
      stars: [],
      functions: ['COUNT', 'MAX'],
      parameters: ['current_event_id', 'current_user_email', 'status'],
      variables: ['current_event_id'],
      usesUserContext: true,
      dependencies: ['anmeldung', 'hotelbuchung', 'person', 'v_zahlungsstatus', 'zahlung'],
      unknownDependencies: false,
    })
    expect(result.limit).toBe('append')
  })

  it('resolves names to catalog spelling and follows views with unknown base tables', () => {
    const result = guardSql('SELECT NACHNAME, w.WERT FROM person, v_geheim AS w', ctx)
    expect(result.analysis.columns).toEqual([
      { object: 'person', column: 'nachname' },
      { object: 'v_geheim', column: 'wert' },
    ])
    expect(result.analysis.unknownDependencies).toBe(true)
  })

  it('records star references and CTE shadowing', () => {
    expect(guardSql('SELECT * FROM event', ctx).analysis.stars).toEqual(['event'])
    // The CTE shadows the table, so the table is not referenced at all.
    expect(
      guardSql('WITH person AS (SELECT 1 AS id) SELECT id FROM person', ctx).analysis.objects,
    ).toEqual([])
  })

  it('records what an ORDER BY name reads: the alias, or with COLLATE the column', () => {
    const columns = (sql: string) =>
      guardSql(sql, ctx).analysis.columns.map((entry) => `${entry.object}.${entry.column}`)
    expect(columns('SELECT nachname AS vorname FROM person ORDER BY vorname')).toEqual([
      'person.nachname',
    ])
    expect(
      columns('SELECT nachname AS vorname FROM person ORDER BY vorname COLLATE utf8mb4_bin DESC'),
    ).toEqual(['person.nachname', 'person.vorname'])
  })

  it('wraps statements that bring their own LIMIT', () => {
    expect(guardSql('SELECT id FROM event LIMIT 3', ctx).limit).toBe('wrap')
    expect(guardSql('SELECT id FROM event UNION SELECT id FROM event LIMIT 3', ctx).limit).toBe(
      'wrap',
    )
    expect(guardSql('SELECT id FROM event ORDER BY id', ctx).limit).toBe('append')
  })
})

describe('executable statements', () => {
  it('bind values in placeholder order and expand lists', () => {
    const result = guardSql(
      'SELECT id FROM anmeldung WHERE event_id = :e AND id IN (:ids) -- tail',
      ctx,
    )
    const statement = buildStatement(
      result,
      new Map<string, string | number | (string | number)[]>([
        ['e', 14],
        ['ids', [1, 2, 3]],
      ]),
      101,
    )
    expect(statement.sql).toBe(
      'SELECT id FROM anmeldung WHERE event_id = ? AND id IN (?, ?, ?)  \nLIMIT ?',
    )
    expect(statement.values).toEqual([14, 1, 2, 3, 101])
    const empty = buildStatement(
      result,
      new Map<string, BoundValue>([
        ['e', 14],
        ['ids', []],
      ]),
      5,
    )
    expect(empty.sql).toContain('IN (NULL)')
    expect(empty.values).toEqual([14, 5])
  })

  it('wrap a statement with its own LIMIT as a derived table', () => {
    const result = guardSql('SELECT id FROM event ORDER BY id DESC LIMIT 3', ctx)
    expect(buildStatement(result, new Map(), 11)).toEqual({
      sql: 'SELECT * FROM (\nSELECT id FROM event ORDER BY id DESC LIMIT 3\n) AS stashley_q LIMIT ?',
      values: [11],
    })
  })

  it('refuse unbound parameters and bad limits', () => {
    const result = guardSql('SELECT id FROM event WHERE id = :x', ctx)
    expect(() => buildStatement(result, new Map(), 1)).toThrow(/Unbound/)
    expect(() => buildStatement(result, new Map([['x', 1]]), 0)).toThrow(/limit/)
    expect(() =>
      buildStatement({ segments: ['a'], params: ['x'], limit: 'append' }, new Map([['x', 1]]), 1),
    ).toThrow(/inconsistent/)
  })
})

describe('read session SQL mode', () => {
  it('drops the modes that change how statements are read', async () => {
    const { readSqlMode } = await import('../../../target/pools.ts')
    expect(
      readSqlMode(
        'REAL_AS_FLOAT,PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ONLY_FULL_GROUP_BY,ANSI,NO_BACKSLASH_ESCAPES',
      ),
    ).toBe('REAL_AS_FLOAT,PIPES_AS_CONCAT,IGNORE_SPACE,ONLY_FULL_GROUP_BY')
    expect(readSqlMode('STRICT_TRANS_TABLES,ORACLE')).toBe('STRICT_TRANS_TABLES')
    expect(readSqlMode('')).toBe('')
  })
})
