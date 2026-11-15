// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { tableOps, type TableOp } from '../api/connections.ts'
import type { Block } from '../model/page.ts'
import {
  allOps,
  authenticatedPrincipal,
  canView,
  capabilityOf,
  componentKindOf,
  componentOps,
  effectiveOps,
  grantsAboveCeiling,
  hasOp,
  isDelivered,
  noOps,
  opBits,
  pageOps,
  principalOps,
  principalsOf,
  queryCeiling,
  querySource,
  restrictionOf,
  restrictionsAbovePage,
  staticMask,
  tableSource,
  toMask,
  toOps,
  type ComponentAccess,
  type ComponentKind,
  type ComponentRestriction,
  type ObjectAccess,
  type PageAccess,
  type SourceKey,
} from './algebra.ts'

const orga = 'role-orga'
const kasse = 'role-kasse'
const station = 'role-station'
const zahlung = tableSource('zahlung')
const offen = querySource('offene-posten')

const principalArb = fc.constantFrom(orga, kasse, station, authenticatedPrincipal)
const sourceArb = fc.constantFrom<SourceKey>(zahlung, offen)
const opsArb = fc.subarray([...tableOps] as TableOp[])
const maskArb = fc.integer({ min: 0, max: allOps })
const accessArb: fc.Arbitrary<PageAccess> = fc.record({
  view: fc.uniqueArray(principalArb),
  grants: fc.array(fc.record({ principal: principalArb, source: sourceArb, ops: opsArb }), {
    maxLength: 8,
  }),
})
const restrictionsArb: fc.Arbitrary<ComponentRestriction[]> = fc.array(
  fc.record({ principal: principalArb, ops: opsArb }),
  { maxLength: 4 },
)
const componentArb: fc.Arbitrary<ComponentAccess> = fc.record({
  access: accessArb,
  restrictions: restrictionsArb,
  source: sourceArb,
  limits: fc.record({ capability: maskArb, ceiling: maskArb, dbGrants: maskArb }),
})
const principalsArb = fc.uniqueArray(principalArb)
const subset = (a: number, b: number) => (a & ~b) === 0

describe('access algebra', () => {
  it('round-trips operation sets through masks', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        expect(toOps(toMask(ops))).toEqual(ops)
      }),
    )
    expect(toMask(['read', 'delete'])).toBe(9)
    expect(hasOp(9, 'delete')).toBe(true)
    expect(hasOp(9, 'update')).toBe(false)
    expect(toOps(allOps)).toEqual(['read', 'create', 'update', 'delete'])
  })

  it('adds authenticated to every user', () => {
    expect(principalsOf([orga, orga])).toEqual([orga, authenticatedPrincipal])
    expect(principalsOf([])).toEqual([authenticatedPrincipal])
  })

  it('never widens rights through restrictions', () => {
    fc.assert(
      fc.property(componentArb, principalsArb, (component, principals) => {
        const restricted = effectiveOps(component, principals)
        const open = effectiveOps({ ...component, restrictions: [] }, principals)
        expect(subset(restricted, open)).toBe(true)
      }),
    )
  })

  it('grows with the principals and distributes over their union', () => {
    fc.assert(
      fc.property(componentArb, principalsArb, principalsArb, (component, a, b) => {
        const union = effectiveOps(component, [...a, ...b])
        expect(union).toBe(effectiveOps(component, a) | effectiveOps(component, b))
        expect(subset(effectiveOps(component, a), union)).toBe(true)
      }),
    )
  })

  it('stays within capability, ceiling and database grants', () => {
    fc.assert(
      fc.property(componentArb, principalsArb, (component, principals) => {
        const effective = effectiveOps(component, principals)
        expect(subset(effective, component.limits.capability)).toBe(true)
        expect(subset(effective, component.limits.ceiling)).toBe(true)
        expect(subset(effective, component.limits.dbGrants)).toBe(true)
      }),
    )
  })

  it('gives the same result when the static limits are applied per principal', () => {
    fc.assert(
      fc.property(componentArb, principalsArb, (component, principals) => {
        let perPrincipal = noOps
        for (const principal of principals) {
          perPrincipal |=
            componentOps(component.access, component.restrictions, principal, component.source) &
            staticMask(component.limits)
        }
        expect(effectiveOps(component, principals)).toBe(perPrincipal)
      }),
    )
  })

  it('gives nothing to principals that may not see the page', () => {
    fc.assert(
      fc.property(componentArb, principalArb, (component, principal) => {
        const access = {
          ...component.access,
          view: component.access.view.filter((entry) => entry !== principal),
        }
        expect(pageOps(access, principal, component.source)).toBe(noOps)
        expect(effectiveOps({ ...component, access }, [principal])).toBe(noOps)
      }),
    )
  })

  it('evaluates the scenario rights', () => {
    const access: PageAccess = {
      view: [orga, kasse],
      grants: [
        { principal: kasse, source: zahlung, ops: ['read', 'create', 'update'] },
        { principal: orga, source: zahlung, ops: ['read'] },
        { principal: kasse, source: offen, ops: ['read'] },
        // A grant without the view right has no effect.
        { principal: station, source: zahlung, ops: ['read', 'create'] },
      ],
    }
    const form: ComponentAccess = {
      access,
      restrictions: [],
      source: zahlung,
      limits: {
        capability: capabilityOf({ type: 'form', mode: 'create' }),
        ceiling: toMask(['read', 'create', 'update']),
        dbGrants: allOps,
      },
    }
    expect(canView(access, principalsOf([station]))).toBe(false)
    expect(canView(access, principalsOf([kasse]))).toBe(true)
    expect(toOps(effectiveOps(form, principalsOf([kasse])))).toEqual(['create'])
    expect(effectiveOps(form, principalsOf([orga]))).toBe(noOps)
    expect(effectiveOps(form, principalsOf([station]))).toBe(noOps)
    expect(isDelivered({ type: 'form', mode: 'create' }, effectiveOps(form, [kasse]))).toBe(true)
    expect(isDelivered({ type: 'form', mode: 'create' }, effectiveOps(form, [orga]))).toBe(false)

    // Restricting Kasse on the form to read leaves no create right.
    const restricted = { ...form, restrictions: [{ principal: kasse, ops: ['read' as TableOp] }] }
    expect(effectiveOps(restricted, [kasse])).toBe(noOps)
    expect(restrictionOf(restricted.restrictions, orga)).toBe(allOps)
    expect(restrictionOf([...restricted.restrictions, { principal: kasse, ops: [] }], kasse)).toBe(
      noOps,
    )
    expect(principalOps(access, [], [kasse, orga], zahlung)).toBe(
      toMask(['read', 'create', 'update']),
    )
    // The authenticated principal covers everyone.
    const everyone: PageAccess = {
      view: [authenticatedPrincipal],
      grants: [{ principal: authenticatedPrincipal, source: offen, ops: ['read'] }],
    }
    expect(canView(everyone, principalsOf([]))).toBe(true)
    expect(pageOps(everyone, authenticatedPrincipal, offen)).toBe(opBits.read)
  })

  it('reads the editing operations of table sources only (§ Tabellenseiten)', () => {
    const table = (source: 'query' | 'table', ops: ('create' | 'update' | 'delete')[] | null) =>
      ({
        id: 't',
        type: 'table',
        title: 'T',
        restrictions: [],
        source:
          source === 'query'
            ? { kind: 'query', queryId: '0196f3a4-3333-7000-8000-000000000001' }
            : {
                kind: 'table',
                tableAccessId: '0196f3a4-3333-7000-8000-000000000001',
                cacheTtlSeconds: 0,
              },
        bindings: [],
        table:
          source === 'query'
            ? null
            : {
                columns: [],
                sort: null,
                searchColumns: [],
                baseFilter: [],
                bindings: [],
                pageSize: 50,
                editing: ops === null ? null : { ops, fields: [], inline: false, dialog: true },
                csvExport: true,
              },
      }) as Block
    expect(componentKindOf(table('table', ['update', 'delete']))).toEqual({
      type: 'table',
      editing: toMask(['update', 'delete']),
    })
    expect(componentKindOf(table('table', null))).toEqual({ type: 'table' })
    expect(componentKindOf(table('query', null))).toEqual({ type: 'table' })
  })

  it('derives capabilities and the delivery rule per component type', () => {
    const cases: [ComponentKind, number][] = [
      [{ type: 'metric' }, opBits.read],
      [{ type: 'chart' }, opBits.read],
      [{ type: 'record' }, opBits.read],
      [{ type: 'table' }, opBits.read],
      [
        { type: 'table', editing: toMask(['update', 'delete']) },
        toMask(['read', 'update', 'delete']),
      ],
      [{ type: 'form', mode: 'create' }, opBits.create],
      [{ type: 'form', mode: 'edit' }, toMask(['read', 'update'])],
      [{ type: 'form', mode: 'upsert' }, toMask(['create', 'update'])],
      [{ type: 'text' }, noOps],
    ]
    for (const [kind, mask] of cases) expect(capabilityOf(kind), JSON.stringify(kind)).toBe(mask)

    expect(isDelivered({ type: 'text' }, noOps)).toBe(true)
    expect(isDelivered({ type: 'chart' }, opBits.read)).toBe(true)
    expect(isDelivered({ type: 'table', editing: opBits.delete }, opBits.delete)).toBe(false)
    expect(isDelivered({ type: 'form', mode: 'edit' }, opBits.read)).toBe(false)
    expect(isDelivered({ type: 'form', mode: 'edit' }, opBits.update)).toBe(false)
    expect(isDelivered({ type: 'form', mode: 'edit' }, toMask(['read', 'update']))).toBe(true)
    expect(isDelivered({ type: 'form', mode: 'upsert' }, opBits.update)).toBe(true)
    fc.assert(
      fc.property(maskArb, (mask) => {
        expect(isDelivered({ type: 'record' }, mask)).toBe(hasOp(mask, 'read'))
      }),
    )
  })

  it('reads the ceiling of a query source from its references', () => {
    const tables = new Map<string, ObjectAccess>([
      ['person', { ceiling: allOps, excluded: new Set(['telefon']), active: true }],
      ['anmeldung', { ceiling: toMask(['read', 'create']), excluded: new Set(), active: true }],
      ['hotel', { ceiling: opBits.create, excluded: new Set(), active: true }],
      ['station', { ceiling: opBits.read, excluded: new Set(), active: false }],
    ])
    const of = (name: string) => tables.get(name)
    const ok = {
      objects: ['person', 'anmeldung'],
      columns: [
        { object: 'person', column: 'nachname' },
        { object: 'anmeldung', column: 'person_id' },
      ],
      stars: ['anmeldung'],
    }
    expect(queryCeiling(ok, of)).toBe(opBits.read)
    expect(queryCeiling({ ...ok, columns: [{ object: 'person', column: 'TELEFON' }] }, of)).toBe(
      noOps,
    )
    expect(queryCeiling({ ...ok, stars: ['person'] }, of)).toBe(noOps)
    expect(queryCeiling({ ...ok, objects: ['hotel'] }, of)).toBe(noOps)
    expect(queryCeiling({ ...ok, objects: ['station'] }, of)).toBe(noOps)
    expect(queryCeiling({ ...ok, objects: ['unknown'] }, of)).toBe(noOps)
    expect(queryCeiling({ ...ok, columns: [{ object: 'unknown', column: 'x' }] }, of)).toBe(noOps)
    expect(queryCeiling({ ...ok, stars: ['unknown'] }, of)).toBe(noOps)
    // A further exclusion never raises the ceiling.
    fc.assert(
      fc.property(fc.constantFrom('nachname', 'person_id', 'id'), (column) => {
        const narrowed = (name: string) => {
          const access = tables.get(name)
          return access && { ...access, excluded: new Set([...access.excluded, column]) }
        }
        expect(subset(queryCeiling(ok, narrowed), queryCeiling(ok, of))).toBe(true)
      }),
    )
  })

  it('finds grants above the ceiling and restrictions above the page rights', () => {
    const access: PageAccess = {
      view: [kasse, orga],
      grants: [
        { principal: kasse, source: zahlung, ops: ['read', 'create', 'delete'] },
        { principal: orga, source: offen, ops: ['read', 'update'] },
        { principal: orga, source: zahlung, ops: ['read'] },
      ],
    }
    const ceilings: Record<string, number> = {
      [zahlung]: toMask(['read', 'create', 'update']),
      [offen]: opBits.read,
    }
    expect(grantsAboveCeiling(access, (source) => ceilings[source] ?? noOps)).toEqual([
      { index: 0, ops: ['delete'] },
      { index: 1, ops: ['update'] },
    ])
    expect(
      restrictionsAbovePage(
        access,
        [
          { principal: orga, ops: ['read'] },
          { principal: orga, ops: ['read', 'create'] },
          { principal: station, ops: ['read'] },
        ],
        zahlung,
      ),
    ).toEqual([
      { index: 1, ops: ['create'] },
      { index: 2, ops: ['read'] },
    ])
    expect(restrictionsAbovePage(access, [{ principal: orga, ops: ['read'] }], undefined)).toEqual([
      { index: 0, ops: ['read'] },
    ])
    fc.assert(
      fc.property(accessArb, maskArb, (generated, ceiling) => {
        const problems = grantsAboveCeiling(generated, () => ceiling)
        const exceeding = generated.grants.filter((grant) => !subset(toMask(grant.ops), ceiling))
        expect(problems.length).toBe(exceeding.length)
      }),
    )
  })
})
