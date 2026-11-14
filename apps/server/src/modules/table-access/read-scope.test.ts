// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, GrantReport } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { buildGrantReport, columnReadable } from '../connections/grants.ts'
import { quoteAccount, readScope, type ExposedObject } from './read-scope.ts'

function object(name: string, columns: string[], type: 'table' | 'view' = 'table'): CatalogObject {
  return {
    name,
    type,
    rowEstimate: 10,
    columns: columns.map((column, index) => ({
      name: column,
      position: index + 1,
      dataType: 'varchar',
      columnType: 'varchar(80)',
      kind: 'string',
      nullable: true,
      defaultValue: null,
      autoIncrement: false,
      generated: false,
      maxLength: 80,
      precision: null,
      scale: null,
    })),
    primaryKey: type === 'table' ? ['id'] : [],
    uniqueKeys: [],
    foreignKeys: [],
  }
}

const catalog = [
  object('person', ['id', 'vorname', 'telefon']),
  object('event', ['id', 'name']),
  object('geheim', ['id', 'wert']),
  object('v_status', ['id', 'offen'], 'view'),
]

const exposed: ExposedObject[] = [
  { objectName: 'person', objectType: 'table', readable: true, excluded: new Set(['telefon']) },
  { objectName: 'event', objectType: 'table', readable: true, excluded: new Set() },
  { objectName: 'v_status', objectType: 'view', readable: true, excluded: new Set() },
]

function report(lines: string[], account = 'stashley_read@%'): GrantReport {
  return { ...buildGrantReport({ purpose: 'read', database: 'wanderverein', lines }), account }
}

describe('read scope', () => {
  it('finds unexposed objects and excluded columns behind a schema-wide grant', () => {
    const scope = readScope({
      database: 'wanderverein',
      report: report(['GRANT SELECT, SHOW VIEW ON `wanderverein`.* TO `stashley_read`@`%`']),
      catalog,
      exposed,
    })
    expect(scope).toEqual({
      account: 'stashley_read@%',
      unexposedReadable: ['geheim'],
      excludedReadable: [{ object: 'person', columns: ['telefon'] }],
      statements: [
        "REVOKE SELECT, SHOW VIEW ON `wanderverein`.* FROM 'stashley_read'@'%';",
        "GRANT SELECT ON `wanderverein`.`event` TO 'stashley_read'@'%';",
        "GRANT SELECT (`id`, `vorname`) ON `wanderverein`.`person` TO 'stashley_read'@'%';",
        "GRANT SELECT, SHOW VIEW ON `wanderverein`.`v_status` TO 'stashley_read'@'%';",
      ],
      notes: [],
    })
  })

  it('has nothing to change once the grants match the exposures', () => {
    const scope = readScope({
      database: 'wanderverein',
      report: report([
        'GRANT USAGE ON *.* TO `stashley_read`@`%`',
        'GRANT SELECT ON `wanderverein`.`event` TO `stashley_read`@`%`',
        'GRANT SELECT (`id`, `vorname`) ON `wanderverein`.`person` TO `stashley_read`@`%`',
        'GRANT SELECT, SHOW VIEW ON `wanderverein`.`v_status` TO `stashley_read`@`%`',
      ]),
      // Column grants hide the excluded column from the catalog as well.
      catalog: [
        object('person', ['id', 'vorname']),
        ...catalog.slice(1, 2),
        catalog[3] as CatalogObject,
      ],
      exposed,
    })
    expect(scope).toMatchObject({ unexposedReadable: [], excludedReadable: [], statements: [] })
  })

  it('revokes object and column grants that reach too far', () => {
    const scope = readScope({
      database: 'wanderverein',
      report: report([
        'GRANT SELECT ON `wanderverein`.`geheim` TO `stashley_read`@`%`',
        'GRANT SELECT ON `wanderverein`.`event` TO `stashley_read`@`%`',
        'GRANT SELECT (`id`, `Telefon`, `vorname`) ON `wanderverein`.`person` TO `stashley_read`@`%`',
      ]),
      catalog,
      exposed,
    })
    expect(scope.unexposedReadable).toEqual(['geheim'])
    expect(scope.excludedReadable).toEqual([{ object: 'person', columns: ['telefon'] }])
    expect(scope.statements.slice(0, 2)).toEqual([
      "REVOKE SELECT ON `wanderverein`.`geheim` FROM 'stashley_read'@'%';",
      "REVOKE SELECT (`Telefon`) ON `wanderverein`.`person` FROM 'stashley_read'@'%';",
    ])
  })

  it('says what the statements cannot change', () => {
    const global = readScope({
      database: 'wanderverein',
      report: report(['GRANT SELECT ON *.* TO `stashley_read`@`%`']),
      catalog,
      exposed,
    })
    expect(global.notes).toEqual(['global_select'])
    expect(global.statements[0]).toBe(
      "GRANT SELECT ON `wanderverein`.`event` TO 'stashley_read'@'%';",
    )
    const all = readScope({
      database: 'wanderverein',
      report: report(['GRANT ALL PRIVILEGES ON `wanderverein`.* TO `stashley_read`@`%`']),
      catalog,
      exposed,
    })
    expect(all.statements[0]).toBe(
      "REVOKE ALL PRIVILEGES ON `wanderverein`.* FROM 'stashley_read'@'%';",
    )
    const roles = readScope({
      database: 'wanderverein',
      report: {
        ...report(['GRANT SELECT ON `wanderverein`.* TO `r_lesen`']),
        roles: ['r_lesen'],
      },
      catalog,
      exposed,
    })
    expect(roles.notes).toEqual(['roles'])
    const old = readScope({
      database: 'wanderverein',
      report: buildGrantReport({
        purpose: 'read',
        database: 'wanderverein',
        lines: ['GRANT SELECT ON `wanderverein`.* TO `x`@`%`'],
      }),
      catalog,
      exposed,
    })
    expect(old).toMatchObject({ account: null, statements: [], notes: ['account_unknown'] })
    expect(old.unexposedReadable).toEqual(['geheim'])
    expect(
      readScope({ database: 'wanderverein', report: undefined, catalog, exposed }).notes,
    ).toEqual(['no_grant_report'])
  })

  it('leaves out objects without read and quotes names and accounts', () => {
    const scope = readScope({
      database: 'wander`verein',
      report: {
        ...buildGrantReport({
          purpose: 'read',
          database: 'wander`verein',
          lines: ["GRANT SELECT ON `wander``verein`.* TO `o'brien`@`%`"],
        }),
        account: "o'brien@10.0.%",
      },
      catalog: [object('event', ['id']), object('ehrung', ['id'])],
      exposed: [
        { objectName: 'event', objectType: 'table', readable: true, excluded: new Set() },
        { objectName: 'ehrung', objectType: 'table', readable: false, excluded: new Set() },
      ],
    })
    expect(scope.unexposedReadable).toEqual(['ehrung'])
    expect(scope.statements).toEqual([
      "REVOKE SELECT ON `wander``verein`.* FROM 'o''brien'@'10.0.%';",
      "GRANT SELECT ON `wander``verein`.`event` TO 'o''brien'@'10.0.%';",
    ])
    expect(quoteAccount('back\\slash')).toBe("'back\\\\slash'")
  })

  it('reads column grants case-insensitively', () => {
    const grants = report([
      'GRANT SELECT (`Telefon`) ON `wanderverein`.`person` TO `stashley_read`@`%`',
      'GRANT INSERT ON `wanderverein`.`event` TO `stashley_read`@`%`',
    ])
    expect(columnReadable(grants, 'person', 'telefon')).toBe(true)
    expect(columnReadable(grants, 'person', 'vorname')).toBe(false)
    expect(columnReadable(grants, 'event', 'id')).toBe(false)
    expect(columnReadable(grants, 'geheim', 'id')).toBe(false)
  })
})
