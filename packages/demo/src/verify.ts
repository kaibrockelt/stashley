// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { DemoFacts } from './generate.ts'

/**
 * One `SELECT` that checks the loaded data against its facts, through the views where the
 * scenario reads them. It returns an empty string when everything holds, otherwise the names
 * of the failed checks.
 */
export function verificationQuery(facts: DemoFacts): string {
  const current = String(facts.currentEventId)
  const checks: [string, string, number][] = [
    ['events', 'SELECT COUNT(*) FROM event', facts.events],
    ['persons', 'SELECT COUNT(*) FROM person', facts.persons],
    ['countries', 'SELECT COUNT(DISTINCT land) FROM person', facts.countries],
    [
      'registrations',
      `SELECT COUNT(*) FROM anmeldung WHERE event_id = ${current}`,
      facts.registrations,
    ],
    [
      'cancelled',
      `SELECT COUNT(*) FROM anmeldung WHERE event_id = ${current} AND status = 'storniert'`,
      facts.cancelled,
    ],
    [
      'hotel_bookings',
      `SELECT COUNT(*) FROM hotelbuchung b JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id WHERE k.event_id = ${current}`,
      facts.hotelBookings,
    ],
    [
      'hotel_rooms',
      `SELECT SUM(anzahl) FROM hotel_kontingent WHERE event_id = ${current}`,
      facts.hotelRooms,
    ],
    ...(
      [
        ['paid', 'bezahlt', facts.paid],
        ['partly_paid', 'teilbezahlt', facts.partlyPaid],
        ['unpaid', 'offen', facts.unpaid],
      ] as const
    ).map(([name, status, expected]): [string, string, number] => [
      name,
      `SELECT COUNT(*) FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id WHERE z.event_id = ${current} AND a.status = 'angemeldet' AND z.status = '${status}'`,
      expected,
    ]),
    [
      'checked_in',
      `SELECT COUNT(*) FROM v_streckenlage WHERE event_id = ${current}`,
      facts.checkedIn,
    ],
    [
      'at_finish',
      `SELECT COUNT(*) FROM v_streckenlage WHERE event_id = ${current} AND im_ziel`,
      facts.atFinish,
    ],
    [
      'overdue',
      `SELECT COUNT(*) FROM v_streckenlage WHERE event_id = ${current} AND NOT im_ziel AND minuten_seit > 90`,
      facts.overdue,
    ],
    [
      'medal_candidates',
      `SELECT COUNT(*) FROM v_medaille WHERE event_id = ${current} AND kandidat`,
      facts.medalCandidates,
    ],
    ['awards', 'SELECT COUNT(*) FROM ehrung', facts.awards],
  ]
  const parts = checks.map(
    ([name, sql, expected]) => `IF((${sql}) = ${String(expected)}, NULL, '${name}')`,
  )
  return `SELECT COALESCE(CONCAT_WS(' ', ${parts.join(',\n  ')}), '') AS failed`
}
