// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildGrantReport, objectPrivileges, parseGrantLine, redactGrantLine } from './grants.ts'

const db = 'wanderverein'

describe('parseGrantLine', () => {
  it('parses privileges, levels and column lists', () => {
    expect(
      parseGrantLine(
        'GRANT SELECT, INSERT (`betrag`, `zahlart`), UPDATE ON `wanderverein`.`zahlung` TO `kasse`@`%`',
      ),
    ).toEqual({
      kind: 'privileges',
      privileges: [
        { name: 'SELECT' },
        { name: 'INSERT', columns: ['betrag', 'zahlart'] },
        { name: 'UPDATE' },
      ],
      level: { kind: 'table', schema: 'wanderverein', table: 'zahlung' },
      grantOption: false,
    })
    expect(parseGrantLine('GRANT ALL ON *.* TO `root`@`%` WITH GRANT OPTION')).toMatchObject({
      privileges: [{ name: 'ALL PRIVILEGES' }],
      level: { kind: 'global' },
      grantOption: true,
    })
  })

  it('parses role grants of both engines', () => {
    expect(parseGrantLine('GRANT `leser` TO `app`@`%`')).toEqual({
      kind: 'roles',
      roles: [{ name: 'leser' }],
    })
    expect(parseGrantLine('GRANT `r1`@`%`,`r2`@`%` TO `app`@`%`')).toEqual({
      kind: 'roles',
      roles: [
        { name: 'r1', host: '%' },
        { name: 'r2', host: '%' },
      ],
    })
  })

  it('never keeps password hashes', () => {
    const line = "GRANT USAGE ON *.* TO `app`@`%` IDENTIFIED BY PASSWORD '*94BDCEBE19083CE2'"
    expect(redactGrantLine(line)).toBe('GRANT USAGE ON *.* TO `app`@`%`')
    expect(JSON.stringify(parseGrantLine(line))).not.toContain('94BDCEBE')
  })
})

describe('buildGrantReport', () => {
  it('accepts a read user with exactly the needed privileges', () => {
    const report = buildGrantReport({
      purpose: 'read',
      database: db,
      lines: [
        'GRANT USAGE ON *.* TO `leser`@`%`',
        'GRANT SELECT, SHOW VIEW ON `wanderverein`.* TO `leser`@`%`',
      ],
    })
    expect(report.missing).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.schemaPrivileges).toEqual(['SELECT', 'SHOW VIEW'])
  })

  it('warns about privileges beyond the purpose', () => {
    const report = buildGrantReport({
      purpose: 'read',
      database: db,
      lines: [
        'GRANT FILE, PROCESS ON *.* TO `zuviel`@`%`',
        'GRANT SELECT, INSERT, DROP, ALTER, SHOW VIEW ON `wanderverein`.* TO `zuviel`@`%` WITH GRANT OPTION',
        'GRANT SELECT ON `mysql`.`user` TO `zuviel`@`%`',
        'GRANT EXECUTE ON PROCEDURE `wanderverein`.`p` TO `zuviel`@`%`',
        'GRANT SELECT ON `wander%`.* TO `zuviel`@`%`',
      ],
    })
    const codes = report.warnings.map((w) => `${w.code}:${w.privilege ?? ''}:${w.scope}`)
    expect(codes).toEqual(
      expect.arrayContaining([
        'global_privilege:FILE:*.*',
        'global_privilege:PROCESS:*.*',
        'excess_privilege:INSERT:wanderverein.*',
        'excess_privilege:DROP:wanderverein.*',
        'excess_privilege:ALTER:wanderverein.*',
        'grant_option::wanderverein.*',
        'other_schema:SELECT:mysql.user',
        'routine_privilege:EXECUTE:wanderverein.p',
        'other_schema:SELECT:wander%.*',
      ]),
    )
  })

  it('reports missing privileges and table-level grants', () => {
    const report = buildGrantReport({
      purpose: 'write',
      database: db,
      lines: [
        'GRANT SELECT, INSERT, UPDATE ON `wanderverein`.`zahlung` TO `schreiber`@`%`',
        'GRANT SELECT, INSERT, DELETE ON `wanderverein`.`stempel` TO `schreiber`@`%`',
      ],
    })
    expect(report.missing).toEqual([])
    expect(report.objects.map((o) => o.object)).toEqual(['stempel', 'zahlung'])
    expect([...objectPrivileges(report, 'stempel')].sort()).toEqual(['DELETE', 'INSERT', 'SELECT'])
    expect(objectPrivileges(report, 'person').size).toBe(0)

    const schemaUser = buildGrantReport({
      purpose: 'schema',
      database: db,
      lines: ['GRANT CREATE ON `wanderverein`.* TO `schema`@`%`'],
    })
    expect(schemaUser.missing).toEqual(['INSERT'])
  })

  it('expands ALL PRIVILEGES and treats escaped wildcards literally', () => {
    const report = buildGrantReport({
      purpose: 'read',
      database: 'wander_verein',
      lines: ['GRANT ALL PRIVILEGES ON `wander\\_verein`.* TO `x`@`%`'],
    })
    expect(report.missing).toEqual([])
    expect(report.warnings).toEqual([
      { code: 'excess_privilege', privilege: 'ALL PRIVILEGES', scope: 'wander\\_verein.*' },
    ])
    expect(objectPrivileges(report, 'anything').has('DELETE')).toBe(true)
  })
})
