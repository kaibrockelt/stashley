// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, GrantReport } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { buildGrantReport, columnReadable } from '../connections/grants.ts'
import { quoteAccount, userScope, type ExposedObject } from './user-scope.ts'

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
  {
    objectName: 'person',
    objectType: 'table',
    ops: ['read', 'create', 'update'],
    excluded: new Set(['telefon']),
  },
  { objectName: 'event', objectType: 'table', ops: ['read'], excluded: new Set() },
  { objectName: 'v_status', objectType: 'view', ops: ['read'], excluded: new Set() },
]

function report(
  lines: string[],
  purpose: 'read' | 'write' = 'read',
  account = 'stashley_read@%',
): GrantReport {
  return { ...buildGrantReport({ purpose, database: 'wanderverein', lines }), account }
}

const read = (grants: GrantReport | undefined, objects = catalog, access = exposed) =>
  userScope({
    purpose: 'read',
    database: 'wanderverein',
    report: grants,
    catalog: objects,
    exposed: access,
  })
const write = (grants: GrantReport | undefined, objects = catalog, access = exposed) =>
  userScope({
    purpose: 'write',
    database: 'wanderverein',
    report: grants,
    catalog: objects,
    exposed: access,
  })

describe('read scope', () => {
  it('finds unexposed objects and excluded columns behind a schema-wide grant', () => {
    expect(
      read(report(['GRANT SELECT, SHOW VIEW ON `wanderverein`.* TO `stashley_read`@`%`'])),
    ).toEqual({
      purpose: 'read',
      account: 'stashley_read@%',
      unexposedReadable: ['geheim'],
      excludedReadable: [{ object: 'person', columns: ['telefon'] }],
      excludedWritable: [],
      writableBeyondCeiling: [],
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
    const scope = read(
      report([
        'GRANT USAGE ON *.* TO `stashley_read`@`%`',
        'GRANT SELECT ON `wanderverein`.`event` TO `stashley_read`@`%`',
        'GRANT SELECT (`id`, `vorname`) ON `wanderverein`.`person` TO `stashley_read`@`%`',
        'GRANT SELECT, SHOW VIEW ON `wanderverein`.`v_status` TO `stashley_read`@`%`',
      ]),
      // Column grants hide the excluded column from the catalog as well.
      [
        object('person', ['id', 'vorname']),
        catalog[1] as CatalogObject,
        catalog[3] as CatalogObject,
      ],
    )
    expect(scope).toMatchObject({ unexposedReadable: [], excludedReadable: [], statements: [] })
  })

  it('revokes object and column grants that reach too far', () => {
    const scope = read(
      report([
        'GRANT SELECT, SHOW VIEW ON `wanderverein`.`geheim` TO `stashley_read`@`%`',
        'GRANT SELECT ON `wanderverein`.`event` TO `stashley_read`@`%`',
        'GRANT SELECT (`id`, `Telefon`, `vorname`) ON `wanderverein`.`person` TO `stashley_read`@`%`',
      ]),
    )
    expect(scope.unexposedReadable).toEqual(['geheim'])
    expect(scope.excludedReadable).toEqual([{ object: 'person', columns: ['telefon'] }])
    expect(scope.statements.slice(0, 2)).toEqual([
      "REVOKE SELECT, SHOW VIEW ON `wanderverein`.`geheim` FROM 'stashley_read'@'%';",
      "REVOKE SELECT (`Telefon`) ON `wanderverein`.`person` FROM 'stashley_read'@'%';",
    ])
  })

  it('says what the statements cannot change', () => {
    const global = read(report(['GRANT SELECT ON *.* TO `stashley_read`@`%`']))
    expect(global.notes).toEqual(['global_select'])
    expect(global.statements[0]).toBe(
      "GRANT SELECT ON `wanderverein`.`event` TO 'stashley_read'@'%';",
    )
    const all = read(report(['GRANT ALL PRIVILEGES ON `wanderverein`.* TO `stashley_read`@`%`']))
    expect(all.statements[0]).toBe(
      "REVOKE ALL PRIVILEGES ON `wanderverein`.* FROM 'stashley_read'@'%';",
    )
    const roles = read({
      ...report(['GRANT SELECT ON `wanderverein`.* TO `r_lesen`']),
      roles: ['r_lesen'],
    })
    expect(roles.notes).toEqual(['roles'])
    const old = read(
      buildGrantReport({
        purpose: 'read',
        database: 'wanderverein',
        lines: ['GRANT SELECT ON `wanderverein`.* TO `x`@`%`'],
      }),
    )
    expect(old).toMatchObject({ account: null, statements: [], notes: ['account_unknown'] })
    expect(old.unexposedReadable).toEqual(['geheim'])
    expect(read(undefined).notes).toEqual(['no_grant_report'])
  })

  it('leaves out objects without read and quotes names and accounts', () => {
    const scope = userScope({
      purpose: 'read',
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
        { objectName: 'event', objectType: 'table', ops: ['read'], excluded: new Set() },
        { objectName: 'ehrung', objectType: 'table', ops: ['create'], excluded: new Set() },
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

describe('write scope', () => {
  const account = 'stashley_write@%'

  it('limits writes to the ceilings and reads to the exposed columns', () => {
    const scope = write(
      report(
        [
          'GRANT SELECT, INSERT, UPDATE ON `wanderverein`.* TO `stashley_write`@`%`',
          'GRANT DELETE ON `wanderverein`.`person` TO `stashley_write`@`%`',
        ],
        'write',
        account,
      ),
    )
    expect(scope).toEqual({
      purpose: 'write',
      account,
      unexposedReadable: ['geheim'],
      excludedReadable: [{ object: 'person', columns: ['telefon'] }],
      excludedWritable: [{ object: 'person', columns: ['telefon'] }],
      writableBeyondCeiling: [
        { object: 'event', ops: ['create', 'update'] },
        { object: 'geheim', ops: ['create', 'update'] },
        { object: 'person', ops: ['delete'] },
        { object: 'v_status', ops: ['create', 'update'] },
      ],
      statements: [
        "REVOKE SELECT, INSERT, UPDATE ON `wanderverein`.* FROM 'stashley_write'@'%';",
        "REVOKE DELETE ON `wanderverein`.`person` FROM 'stashley_write'@'%';",
        "GRANT SELECT ON `wanderverein`.`event` TO 'stashley_write'@'%';",
        "GRANT SELECT (`id`, `vorname`), INSERT (`id`, `vorname`), UPDATE (`id`, `vorname`) ON `wanderverein`.`person` TO 'stashley_write'@'%';",
        "GRANT SELECT ON `wanderverein`.`v_status` TO 'stashley_write'@'%';",
      ],
      notes: [],
    })
  })

  it('reads objects it may only write and revokes column writes without a ceiling', () => {
    const scope = write(
      report(
        [
          'GRANT SELECT ON `wanderverein`.`ehrung` TO `stashley_write`@`%`',
          'GRANT INSERT ON `wanderverein`.`ehrung` TO `stashley_write`@`%`',
          'GRANT UPDATE (`wert`) ON `wanderverein`.`geheim` TO `stashley_write`@`%`',
        ],
        'write',
        account,
      ),
      [object('ehrung', ['id']), object('geheim', ['id', 'wert'])],
      [{ objectName: 'ehrung', objectType: 'table', ops: ['create'], excluded: new Set() }],
    )
    expect(scope.writableBeyondCeiling).toEqual([{ object: 'geheim', ops: ['update'] }])
    expect(scope.unexposedReadable).toEqual([])
    expect(scope.statements).toEqual([
      "REVOKE UPDATE (`wert`) ON `wanderverein`.`geheim` FROM 'stashley_write'@'%';",
      "GRANT SELECT, INSERT ON `wanderverein`.`ehrung` TO 'stashley_write'@'%';",
    ])
  })

  it('counts grants on objects the catalog does not show', () => {
    const scope = write(
      report(
        [
          'GRANT SELECT ON `wanderverein`.`event` TO `stashley_write`@`%`',
          'GRANT SELECT, DELETE ON `wanderverein`.`unsichtbar` TO `stashley_write`@`%`',
        ],
        'write',
        account,
      ),
    )
    expect(scope.unexposedReadable).toEqual(['unsichtbar'])
    expect(scope.writableBeyondCeiling).toEqual([{ object: 'unsichtbar', ops: ['delete'] }])
    expect(scope.statements[0]).toBe(
      "REVOKE SELECT, DELETE ON `wanderverein`.`unsichtbar` FROM 'stashley_write'@'%';",
    )
  })

  it('limits inserts and updates to the columns that are not excluded or generated (E6)', () => {
    const person = object('person', ['id', 'vorname', 'telefon', 'anzeige'])
    const columns = person.columns.map((column) =>
      column.name === 'anzeige' ? { ...column, generated: true } : column,
    )
    const objects = [{ ...person, columns }, object('event', ['id', 'name'])]
    const access: ExposedObject[] = [
      {
        objectName: 'person',
        objectType: 'table',
        ops: ['read', 'create', 'update', 'delete'],
        excluded: new Set(['TELEFON']),
      },
      { objectName: 'event', objectType: 'table', ops: ['read', 'update'], excluded: new Set() },
    ]
    const scope = write(
      report(
        [
          'GRANT SELECT (`id`, `vorname`, `anzeige`), INSERT, DELETE ON `wanderverein`.`person` TO `stashley_write`@`%`',
          'GRANT UPDATE (`vorname`, `telefon`) ON `wanderverein`.`person` TO `stashley_write`@`%`',
          'GRANT SELECT, UPDATE ON `wanderverein`.`event` TO `stashley_write`@`%`',
        ],
        'write',
        account,
      ),
      objects,
      access,
    )
    expect(scope.excludedReadable).toEqual([])
    expect(scope.excludedWritable).toEqual([{ object: 'person', columns: ['TELEFON'] }])
    expect(scope.writableBeyondCeiling).toEqual([])
    expect(scope.statements).toEqual([
      "REVOKE INSERT ON `wanderverein`.`person` FROM 'stashley_write'@'%';",
      "REVOKE UPDATE (`telefon`) ON `wanderverein`.`person` FROM 'stashley_write'@'%';",
      "GRANT SELECT, UPDATE ON `wanderverein`.`event` TO 'stashley_write'@'%';",
      "GRANT SELECT (`id`, `vorname`, `anzeige`), INSERT (`id`, `vorname`), UPDATE (`id`, `vorname`), DELETE ON `wanderverein`.`person` TO 'stashley_write'@'%';",
    ])
  })

  it('names global write privileges and revokes all on narrowed objects', () => {
    const global = write(report(['GRANT INSERT ON *.* TO `stashley_write`@`%`'], 'write', account))
    expect(global.notes).toEqual(['global_write'])
    const all = write(
      report(
        ['GRANT ALL PRIVILEGES ON `wanderverein`.`geheim` TO `stashley_write`@`%`'],
        'write',
        account,
      ),
    )
    expect(all.statements[0]).toBe(
      "REVOKE ALL PRIVILEGES ON `wanderverein`.`geheim` FROM 'stashley_write'@'%';",
    )
    expect(
      write(report(['GRANT SELECT ON `wanderverein`.`event` TO `w`@`%`'], 'write', account)),
    ).toMatchObject({ writableBeyondCeiling: [], statements: [] })
  })
})
