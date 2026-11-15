// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="esnext.temporal" />
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  dateUnits,
  evaluateDateExpression,
  formatDateExpression,
  instantOf,
  parseDateExpression,
  type DateExpression,
} from './date-expression.ts'

const berlin = 'Europe/Berlin'
const at = (iso: string) => Date.parse(iso)

describe('date expressions', () => {
  it('parse now, today and one offset', () => {
    expect(parseDateExpression('now')).toEqual({ base: 'now', offset: null })
    expect(parseDateExpression(' today ')).toEqual({ base: 'today', offset: null })
    expect(parseDateExpression('now + 1d')).toEqual({
      base: 'now',
      offset: { amount: 1, unit: 'd' },
    })
    expect(parseDateExpression('now-2h')).toEqual({
      base: 'now',
      offset: { amount: -2, unit: 'h' },
    })
    expect(parseDateExpression('today + 3mo')).toEqual({
      base: 'today',
      offset: { amount: 3, unit: 'mo' },
    })
    for (const text of ['', 'tomorrow', 'now + 1', 'now + d', 'now + 1d + 2h', 'NOW', 'now * 2d']) {
      expect(parseDateExpression(text), text).toBeUndefined()
    }
    expect(formatDateExpression({ base: 'now', offset: { amount: -15, unit: 'min' } })).toBe(
      'now - 15min',
    )
  })

  it('evaluate in the instance time zone', () => {
    const now = at('2026-07-04T12:34:56.789Z') // 14:34:56 in Berlin
    const evaluate = (text: string, kind: 'date' | 'datetime' = 'datetime') =>
      evaluateDateExpression(parseDateExpression(text) as DateExpression, now, berlin, kind)
    expect(evaluate('now')).toBe('2026-07-04T12:34:56Z')
    expect(evaluate('today')).toBe('2026-07-03T22:00:00Z')
    expect(evaluate('now + 1d')).toBe('2026-07-05T12:34:56Z')
    expect(evaluate('now - 2h')).toBe('2026-07-04T10:34:56Z')
    expect(evaluate('now + 90min')).toBe('2026-07-04T14:04:56Z')
    expect(evaluate('now', 'date')).toBe('2026-07-04')
    // 23:30 UTC is already the next day in Berlin.
    expect(
      evaluateDateExpression(
        { base: 'today', offset: null },
        at('2026-07-04T23:30:00Z'),
        berlin,
        'date',
      ),
    ).toBe('2026-07-05')
    expect(
      evaluateDateExpression(
        { base: 'today', offset: { amount: 1, unit: 'mo' } },
        at('2026-01-31T10:00:00Z'),
        berlin,
        'date',
      ),
    ).toBe('2026-02-28')
  })

  it('keep the wall time across daylight saving time for calendar offsets', () => {
    // 28 March 2026 12:00 CET; one day later it is 12:00 CEST, 23 hours on.
    const before = at('2026-03-28T11:00:00Z')
    expect(
      evaluateDateExpression(
        { base: 'now', offset: { amount: 1, unit: 'd' } },
        before,
        berlin,
        'datetime',
      ),
    ).toBe('2026-03-29T10:00:00Z')
    expect(
      evaluateDateExpression(
        { base: 'now', offset: { amount: 24, unit: 'h' } },
        before,
        berlin,
        'datetime',
      ),
    ).toBe('2026-03-29T11:00:00Z')
  })

  it('resolve gaps forward and overlaps to the earlier instant', () => {
    // 02:30 does not exist on 29 March 2026 in Berlin; 02:30 exists twice on 25 October.
    const wall = { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }
    expect(new Date(instantOf(wall, berlin)).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(new Date(instantOf({ ...wall, month: 10, day: 25 }, berlin)).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    )
  })

  it('agree with Temporal in any time zone', () => {
    const zones = [
      'Europe/Berlin',
      'America/New_York',
      'Australia/Lord_Howe',
      'Asia/Kolkata',
      'Pacific/Apia',
      'UTC',
    ]
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2060, 0, 1) }),
        fc.constantFrom(...zones),
        fc.constantFrom('now', 'today'),
        fc.option(
          fc.record({
            amount: fc.integer({ min: -400, max: 400 }),
            unit: fc.constantFrom(...dateUnits),
          }),
          { nil: null },
        ),
        (now, zone, base, offset) => {
          const expression: DateExpression = { base, offset }
          let zoned = Temporal.Instant.fromEpochMilliseconds(
            Math.floor(now / 1000) * 1000,
          ).toZonedDateTimeISO(zone)
          if (base === 'today') zoned = zoned.startOfDay()
          if (offset !== null) {
            const unit = {
              min: 'minutes',
              h: 'hours',
              d: 'days',
              w: 'weeks',
              mo: 'months',
              y: 'years',
            }[offset.unit]
            zoned = zoned.add({ [unit]: offset.amount })
          }
          expect(evaluateDateExpression(expression, now, zone, 'datetime')).toBe(
            zoned.toInstant().toString(),
          )
          expect(evaluateDateExpression(expression, now, zone, 'date')).toBe(
            zoned.toPlainDate().toString(),
          )
        },
      ),
      { numRuns: 2000 },
    )
  })
})
