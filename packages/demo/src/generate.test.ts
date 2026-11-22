// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { generateDemo } from './generate.ts'

const now = new Date('2026-11-22T13:30:00Z')

describe('generateDemo', () => {
  it('is deterministic', () => {
    expect(generateDemo({ now }).statements).toEqual(generateDemo({ now }).statements)
  })

  it('promises the figures of the scenario', () => {
    expect(generateDemo({ now }).facts).toEqual({
      events: 13,
      currentEventId: 13,
      previousEventId: 12,
      persons: 420,
      countries: 23,
      registrations: 260,
      cancelled: 8,
      hotelBookings: 96,
      hotelRooms: 110,
      paid: 214,
      partlyPaid: 15,
      unpaid: 23,
      checkedIn: 205,
      atFinish: 61,
      overdue: 3,
      medalCandidates: 12,
      awards: 3,
    })
  })

  it('sets the event day around now', () => {
    const sql = generateDemo({ now }).statements.join('\n')
    expect(sql).toContain("'Internationale 32-km-Wanderung 2026', '2026-11-22'")
    // Nothing on the event day lies in the future.
    const stamps = [...sql.matchAll(/'2026-11-2\d (\d\d:\d\d:\d\d)'/g)].map((m) => m[0])
    expect(stamps.length).toBeGreaterThan(500)
    for (const stamp of stamps) expect(stamp <= "'2026-11-22 13:30:00'").toBe(true)
  })
})
