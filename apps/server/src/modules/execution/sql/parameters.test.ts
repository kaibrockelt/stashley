// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryParameter } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { ParameterError, resolveParameters, wallTime, type ParameterContext } from './parameters.ts'

const definitions: QueryParameter[] = [
  { name: 'land', type: 'string', list: false, required: true, defaultValue: null },
  { name: 'ab', type: 'datetime', list: false, required: false, defaultValue: null },
  { name: 'ids', type: 'integer', list: true, required: false, defaultValue: null },
  { name: 'bezahlt', type: 'boolean', list: false, required: false, defaultValue: true },
  { name: 'tage', type: 'integer', list: false, required: false, defaultValue: 7 },
]

const base: ParameterContext = {
  names: [],
  definitions,
  user: { id: 'u-1', email: 'jonas@example.com' },
  variables: new Map([['current_event_id', { type: 'integer', value: 14 }]]),
  input: {},
  timeZone: 'Europe/Berlin',
}

function errors(ctx: Partial<ParameterContext>): unknown {
  try {
    resolveParameters({ ...base, ...ctx })
    return []
  } catch (error) {
    if (error instanceof ParameterError) return error.errors
    throw error
  }
}

describe('parameter resolution', () => {
  it('sets the user context and instance variables on the server', () => {
    const resolved = resolveParameters({
      ...base,
      names: ['current_user_id', 'current_user_email', 'current_event_id'],
    })
    expect([...resolved.values]).toEqual([
      ['current_user_id', 'u-1'],
      ['current_user_email', 'jonas@example.com'],
      ['current_event_id', 14],
    ])
    expect(resolved.usesUserContext).toBe(true)
    expect(resolved.variables).toEqual(['current_event_id'])
    expect(resolved.key).toBe(
      '[["current_event_id",14],["current_user_email","jonas@example.com"],["current_user_id","u-1"]]',
    )
  })

  it('rejects client values for server-set and unknown parameters', () => {
    expect(
      errors({
        names: ['current_user_id', 'current_event_id', 'land'],
        input: { current_user_id: 'u-2', current_event_id: 13, land: 'DE', extra: 1 },
      }),
    ).toEqual([
      { field: 'params.extra', code: 'not_allowed' },
      { field: 'params.current_user_id', code: 'not_allowed' },
      { field: 'params.current_event_id', code: 'not_allowed' },
    ])
  })

  it('lets test runs try other values for variables, checked by type', () => {
    const resolved = resolveParameters({
      ...base,
      names: ['current_event_id'],
      input: { current_event_id: '13' },
      overrideVariables: true,
    })
    expect(resolved.values.get('current_event_id')).toBe(13)
    expect(
      errors({
        names: ['current_event_id'],
        input: { current_event_id: 'x' },
        overrideVariables: true,
      }),
    ).toEqual([{ field: 'params.current_event_id', code: 'invalid' }])
  })

  it('checks selectable values, defaults and required parameters', () => {
    const resolved = resolveParameters({
      ...base,
      names: ['land', 'ab', 'ids', 'bezahlt', 'tage'],
      input: { land: 'DE', ab: '2026-05-01T08:00:00Z', ids: [1, '2'] },
    })
    expect(resolved.values).toEqual(
      new Map<string, unknown>([
        ['land', 'DE'],
        // D13: bound as the wall time of the connection's time zone.
        ['ab', '2026-05-01 10:00:00.000000'],
        ['ids', [1, 2]],
        ['bezahlt', 1],
        ['tage', 7],
      ]),
    )
    expect(
      resolveParameters({ ...base, names: ['land', 'ids', 'ab'], input: { land: 'DE' } }).values,
    ).toEqual(
      new Map<string, unknown>([
        ['land', 'DE'],
        ['ids', []],
        ['ab', null],
      ]),
    )
    expect(
      resolveParameters({ ...base, names: ['bezahlt'], input: { bezahlt: false } }).values.get(
        'bezahlt',
      ),
    ).toBe(0)
    expect(errors({ names: ['land'] })).toEqual([{ field: 'params.land', code: 'required' }])
    expect(errors({ names: ['land'], input: { land: 5 } })).toEqual([
      { field: 'params.land', code: 'invalid' },
    ])
    expect(errors({ names: ['ids'], input: { ids: [1, 'x'] } })).toEqual([
      { field: 'params.ids', code: 'invalid' },
    ])
    expect(errors({ names: ['nirgends'] })).toEqual([
      { field: 'params.nirgends', code: 'undefined' },
    ])
  })

  it('converts instants to wall times across daylight saving time', () => {
    expect(wallTime('2026-03-29T00:30:00Z', 'Europe/Berlin')).toBe('2026-03-29 01:30:00.000000')
    expect(wallTime('2026-03-29T01:30:00Z', 'Europe/Berlin')).toBe('2026-03-29 03:30:00.000000')
    expect(wallTime('2026-07-01T12:00:00.123Z', 'UTC')).toBe('2026-07-01 12:00:00.123000')
  })
})
