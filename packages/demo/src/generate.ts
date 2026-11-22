// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { asciiName, countries } from './names.ts'

/**
 * Deterministic demo data for the `wanderverein` schema. The same seed and the same `now`
 * give the same rows. The 2026 event takes place today: every time stamp of the event day is
 * set relative to `now`, which stands for 14:30 event time. Time stamps are UTC wall times,
 * so the demo connection uses the time zone UTC (the views compare with `NOW()` of a UTC
 * session).
 */
export interface DemoOptions {
  now: Date
  seed?: number
}

export interface DemoData {
  /** `INSERT` statements in foreign key order. */
  statements: string[]
  facts: DemoFacts
}

/** What the data promises; `verificationQuery` checks it in the database. */
export interface DemoFacts {
  events: number
  currentEventId: number
  previousEventId: number
  persons: number
  countries: number
  registrations: number
  cancelled: number
  hotelBookings: number
  hotelRooms: number
  paid: number
  partlyPaid: number
  unpaid: number
  checkedIn: number
  atFinish: number
  overdue: number
  medalCandidates: number
  awards: number
}

export const DEMO_SEED = 20_260_516
const PAST_YEARS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024, 2025]
const CURRENT_YEAR = 2026
const MINUTE = 60_000
const DAY = 1440 * MINUTE

const STATIONS = [
  { nummer: 1, name: 'Waldhütte', km: '7.5', oeffnet: '07:30:00', schliesst: '11:30:00' },
  { nummer: 2, name: 'Aussichtsturm', km: '13.0', oeffnet: '08:30:00', schliesst: '13:30:00' },
  { nummer: 3, name: 'Mühlental', km: '19.5', oeffnet: '09:30:00', schliesst: '15:30:00' },
  { nummer: 4, name: 'Schäferei', km: '25.0', oeffnet: '10:30:00', schliesst: '17:00:00' },
  { nummer: 5, name: 'Ziel Marktplatz', km: '32.0', oeffnet: '11:00:00', schliesst: '19:00:00' },
]

/** Room quotas per event: hotel, room type, price per night in cents, rooms (110 in all). */
const QUOTAS = [
  { hotel: 1, zimmerart: 'Einzelzimmer', preis: 7900, anzahl: 20, booked2026: 18 },
  { hotel: 1, zimmerart: 'Doppelzimmer', preis: 11_900, anzahl: 40, booked2026: 36 },
  { hotel: 2, zimmerart: 'Einzelzimmer', preis: 6900, anzahl: 15, booked2026: 12 },
  { hotel: 2, zimmerart: 'Doppelzimmer', preis: 9900, anzahl: 35, booked2026: 30 },
]

type Ticket = 'standard' | 'ermaessigt' | 'helfer'
type Group = 'paid' | 'partly' | 'unpaid'

interface Person {
  id: number
  vorname: string
  nachname: string
  email: string
  land: string
  telefon: string
  firstSeen: number
}

interface Registration {
  id: number
  person: Person
  eventId: number
  ticket: Ticket
  cancelled: boolean
  startnummer: number
  soll: number
  angemeldetAm: number
  hotel: number
  group: Group
}

/** mulberry32: small, fast and good enough for demo data. */
function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T
  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i)
      ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
    }
    return copy
  }
  return { next, int, pick, shuffle }
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/** `YYYY-MM-DD HH:MM:SS` of an instant in UTC. */
function dateTime(ms: number): string {
  const d = new Date(ms)
  return `${date(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function date(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Today's date in Europe/Berlin as midnight UTC. */
function berlinToday(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return Date.parse(`${parts}T00:00:00Z`)
}

/** The second Saturday in May, the traditional date before 2026. */
function pastEventDay(year: number): number {
  const first = new Date(Date.UTC(year, 4, 1))
  const offset = (6 - first.getUTCDay() + 7) % 7
  return Date.UTC(year, 4, 1 + offset + 7)
}

const money = (cents: number) => `${String(Math.trunc(cents / 100))}.${pad(cents % 100)}`

function sqlValue(value: string | number | boolean | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

function inserts(
  table: string,
  columns: string[],
  rows: (string | number | boolean | null)[][],
): string[] {
  const statements: string[] = []
  for (let start = 0; start < rows.length; start += 400) {
    const values = rows
      .slice(start, start + 400)
      .map((row) => `(${row.map(sqlValue).join(', ')})`)
      .join(',\n')
    statements.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values}`)
  }
  return statements
}

export function generateDemo(options: DemoOptions): DemoData {
  const rng = random(options.seed ?? DEMO_SEED)
  const nowMs = Math.floor(options.now.getTime() / 1000) * 1000
  const today = berlinToday(options.now)
  // Instants of the event day 2026, given as minutes after midnight event time.
  const eventStart2026 = nowMs - (14 * 60 + 30) * MINUTE
  const at2026 = (minutes: number) => eventStart2026 + minutes * MINUTE

  // Events, 2012–2026 without 2020 and 2021.
  const years = [...PAST_YEARS, CURRENT_YEAR]
  const events = years.map((jahr, index) => {
    const day = jahr === CURRENT_YEAR ? today : pastEventDay(jahr)
    return {
      id: index + 1,
      jahr,
      day,
      // Past event days in May: 08:00 CEST is 06:00 UTC.
      at: (minutes: number) =>
        jahr === CURRENT_YEAR ? at2026(minutes) : day + (minutes - 120) * MINUTE,
      ticketpreis: 2500 + (jahr - 2012) * 100,
      anmeldeschluss: day - (jahr === CURRENT_YEAR ? 7 : 14) * DAY,
    }
  })
  const current = events[events.length - 1]!
  const pastEvents = events.slice(0, -1)

  // People from 23 countries; the first 23 cover every country once.
  const totalWeight = countries.reduce((sum, country) => sum + country.weight, 0)
  const weightedCountry = () => {
    let roll = rng.next() * totalWeight
    for (const country of countries) {
      roll -= country.weight
      if (roll < 0) return country
    }
    return countries[0]!
  }
  const emails = new Set<string>()
  const persons: Person[] = Array.from({ length: 420 }, (_, index) => {
    const country = index < countries.length ? countries[index]! : weightedCountry()
    const vorname = rng.pick(country.first)
    const nachname = rng.pick(country.last)
    const base = `${asciiName(vorname)}.${asciiName(nachname)}`
    let email = `${base}@example.org`
    for (let n = 2; emails.has(email); n++) email = `${base}${String(n)}@example.org`
    emails.add(email)
    return {
      id: index + 1,
      vorname,
      nachname,
      email,
      land: country.code,
      telefon: `${country.dial} ${String(rng.int(1_000_000, 9_999_999))}`,
      firstSeen: Number.POSITIVE_INFINITY,
    }
  })

  // Participation history: 12 people reach their 10th participation in 2026, 3 reached it
  // earlier and were honoured, 45 are new, everyone else has 1–8 earlier participations.
  const order = rng.shuffle(persons)
  const candidates = order.slice(0, 12)
  const veterans = order.slice(12, 15)
  const newcomers = order.slice(15, 60)
  const regulars = order.slice(60)
  const pastCount = new Map<Person, number>()
  for (const person of candidates) pastCount.set(person, 9)
  veterans.forEach((person, index) => pastCount.set(person, 10 + index))
  for (const person of newcomers) pastCount.set(person, 0)
  for (const person of regulars) pastCount.set(person, rng.int(1, 8))

  const registrations: Registration[] = []
  const register = (person: Person, event: (typeof events)[number], cancelled = false) => {
    const angemeldetAm =
      event === current
        ? nowMs - rng.int(8 * 1440, 150 * 1440) * MINUTE
        : event.day - rng.int(15 * 1440, 150 * 1440) * MINUTE + rng.int(0, 600) * MINUTE
    const registration: Registration = {
      id: registrations.length + 1,
      person,
      eventId: event.id,
      ticket: 'standard',
      cancelled,
      startnummer: 0,
      soll: 0,
      angemeldetAm,
      hotel: 0,
      group: 'paid',
    }
    person.firstSeen = Math.min(person.firstSeen, angemeldetAm)
    registrations.push(registration)
    return registration
  }
  const randomTicket = (): Ticket => {
    const roll = rng.next()
    return roll < 0.05 ? 'helfer' : roll < 0.2 ? 'ermaessigt' : 'standard'
  }

  // Earlier events: every participation is a registration with a check-in, plus a few
  // no-shows and cancellations that do not count as participations.
  const participations = new Map<number, Registration[]>()
  const awards: { person: Person; event: (typeof events)[number] }[] = []
  for (const person of persons) {
    const count = pastCount.get(person) ?? 0
    const attended = rng
      .shuffle(pastEvents)
      .slice(0, count)
      .sort((a, b) => a.jahr - b.jahr)
    for (const event of attended) {
      const registration = register(person, event)
      registration.ticket = randomTicket()
      participations.set(event.id, [...(participations.get(event.id) ?? []), registration])
    }
    if (veterans.includes(person)) awards.push({ person, event: attended[9]! })
  }
  for (const event of pastEvents) {
    const present = new Set(participations.get(event.id)?.map((r) => r.person))
    const others = rng.shuffle(regulars.filter((person) => !present.has(person)))
    others.slice(0, 5).forEach((person, index) => {
      const registration = register(person, event, index >= 3)
      registration.ticket = randomTicket()
    })
  }

  // 2026: 260 registrations, 8 of them cancelled.
  const returning = rng.shuffle(regulars).slice(0, 201)
  const people2026 = [...candidates, ...veterans.slice(0, 2), ...newcomers, ...returning]
  const cancelledPeople = new Set(rng.shuffle([...newcomers, ...returning]).slice(0, 8))
  const current2026 = people2026.map((person) =>
    register(person, current, cancelledPeople.has(person)),
  )
  const active = current2026.filter((registration) => !registration.cancelled)
  const candidateRegs = active.filter((registration) => candidates.includes(registration.person))
  const others2026 = rng.shuffle(active.filter((r) => !candidates.includes(r.person)))
  // 205 checked in (every candidate among them), all paid in full, plus 9 paid but not yet
  // checked in; 15 partly paid, 23 unpaid.
  const checkedIn = [...candidateRegs, ...others2026.slice(0, 193)]
  const paidWaiting = others2026.slice(193, 202)
  const partly = others2026.slice(202, 217)
  const unpaid = others2026.slice(217)
  for (const registration of partly) registration.group = 'partly'
  for (const registration of unpaid) registration.group = 'unpaid'
  for (const registration of [...checkedIn, ...paidWaiting]) {
    registration.ticket = randomTicket()
  }
  for (const registration of [...partly, ...unpaid]) {
    registration.ticket = rng.next() < 0.2 ? 'ermaessigt' : 'standard'
  }
  for (const registration of current2026.filter((r) => r.cancelled)) {
    registration.ticket = 'standard'
    registration.group = 'unpaid'
  }

  // Start numbers per event.
  for (const event of events) {
    const own = registrations.filter((registration) => registration.eventId === event.id)
    rng.shuffle(own).forEach((registration, index) => (registration.startnummer = index + 1))
  }
  for (const registration of registrations) {
    const event = events[registration.eventId - 1]!
    registration.soll =
      registration.ticket === 'helfer'
        ? 0
        : registration.ticket === 'ermaessigt'
          ? Math.round((event.ticketpreis * 0.7) / 100) * 100
          : event.ticketpreis
  }

  // Hotels: four room quotas per event; 96 bookings in 2026, about 50 in earlier years.
  const quotaRows: (string | number)[][] = []
  const bookingRows: (string | number | null)[][] = []
  for (const event of events) {
    const quotaIds = QUOTAS.map((quota) => {
      const id = quotaRows.length + 1
      quotaRows.push([id, event.id, quota.hotel, quota.zimmerart, money(quota.preis), quota.anzahl])
      return id
    })
    const pool =
      event === current ? rng.shuffle(active) : rng.shuffle(participations.get(event.id) ?? [])
    let next = 0
    QUOTAS.forEach((quota, index) => {
      const count = event === current ? quota.booked2026 : rng.int(8, Math.floor(quota.anzahl / 2))
      for (let n = 0; n < count && next < pool.length; n++) {
        const registration = pool[next++]!
        const early = rng.next() < 0.45
        const nights = early ? 2 : 1
        const anreise = event.day - (early ? DAY : 0)
        const betrag = quota.preis * nights
        registration.soll += betrag
        registration.hotel += 1
        // Guests check in the evening they arrive; today's evening is still ahead.
        const eingecheckt =
          event === current
            ? early
              ? dateTime(at2026(-1440 + rng.int(17 * 60, 21 * 60)))
              : null
            : dateTime(anreise + rng.int(15 * 60, 19 * 60) * MINUTE)
        bookingRows.push([
          bookingRows.length + 1,
          registration.id,
          quotaIds[index]!,
          date(anreise),
          date(event.day + DAY),
          money(betrag),
          eingecheckt,
        ])
      }
    })
  }

  // Payments: in full for everyone who took part earlier and for 214 of 2026, partly or not
  // at all for the rest. Some overpay, some transfers have an unclear reference.
  const paymentRows: (string | number | null)[][] = []
  const overpaid = new Set(rng.shuffle(checkedIn).slice(0, 4))
  const unclear = new Set(rng.shuffle([...checkedIn, ...paidWaiting]).slice(0, 5))
  const unclearReferences = ['Wanderung', 'Anmeldung', null, 'Teilnahme', 'Überweisung']
  let unclearIndex = 0
  for (const registration of registrations) {
    if (registration.cancelled || registration.group === 'unpaid' || registration.soll === 0) {
      continue
    }
    const event = events[registration.eventId - 1]!
    const last = event === current ? today : event.day
    const paidOn = () => Math.min(last, registration.angemeldetAm + rng.int(1, 20) * DAY)
    let amount =
      registration.group === 'partly'
        ? Math.round((registration.soll * (0.3 + rng.next() * 0.4)) / 100) * 100
        : registration.soll
    if (overpaid.has(registration)) amount += rng.pick([500, 1000])
    const reference = `Startnr ${String(registration.startnummer)} ${registration.person.nachname}`
    const parts = registration.group === 'paid' && rng.next() < 0.1 ? 2 : 1
    const first = parts === 2 ? Math.round(amount / 200) * 100 : amount
    const isUnclear = unclear.has(registration)
    const pushPayment = (cents: number) =>
      paymentRows.push([
        paymentRows.length + 1,
        registration.id,
        money(cents),
        date(paidOn()),
        isUnclear
          ? (unclearReferences[unclearIndex++ % unclearReferences.length] ?? null)
          : reference,
        isUnclear ? 'Zugeordnet über Betrag und Absender' : null,
      ])
    pushPayment(first)
    if (parts === 2) pushPayment(amount - first)
  }

  // Stations, check-ins and stamps. Earlier events: everyone who showed up reached the finish.
  const stationRows: (string | number | boolean)[][] = []
  const checkinRows: (string | number)[][] = []
  const stamps: (string | number)[][] = []
  for (const event of events) {
    const stationIds = STATIONS.map((station) => {
      const id = stationRows.length + 1
      stationRows.push([
        id,
        event.id,
        station.nummer,
        station.name,
        station.km,
        station.oeffnet,
        station.schliesst,
        station.nummer === 5,
      ])
      return id
    })
    const checkin = (registration: Registration, at: number) =>
      checkinRows.push([
        checkinRows.length + 1,
        registration.id,
        dateTime(at),
        `${String(event.jahr)}-${pad(registration.startnummer, 4)}`,
      ])
    const stamp = (registration: Registration, station: number, at: number) =>
      stamps.push([stamps.length + 1, registration.id, stationIds[station - 1]!, dateTime(at)])

    if (event !== current) {
      for (const registration of participations.get(event.id) ?? []) {
        let time = event.at(rng.int(450, 600))
        checkin(registration, time)
        for (let station = 1; station <= 5; station++) {
          time += rng.int(45, 80) * MINUTE
          stamp(registration, station, time)
        }
      }
      continue
    }
    // 2026 at 14:30: 5 just started, 136 on the way (20, 35, 40 and 41 at stations 1–4),
    // 3 overdue, 61 at the finish.
    const walkers = rng.shuffle(checkedIn)
    const groups: { count: number; last: number; overdue?: boolean; finish?: boolean }[] = [
      { count: 5, last: 0 },
      { count: 20, last: 1 },
      { count: 35, last: 2 },
      { count: 40, last: 3 },
      { count: 41, last: 4 },
      { count: 3, last: 2, overdue: true },
      { count: 61, last: 5, finish: true },
    ]
    let index = 0
    for (const group of groups) {
      for (let n = 0; n < group.count; n++) {
        const registration = walkers[index++]!
        if (group.last === 0) {
          checkin(registration, nowMs - rng.int(10, 45) * MINUTE)
          continue
        }
        const ago = group.finish
          ? rng.int(5, 150)
          : group.overdue
            ? rng.int(100, 140)
            : rng.int(3, 50)
        let time = nowMs - ago * MINUTE
        const times: number[] = []
        for (let station = group.last; station >= 1; station--) {
          times.unshift(time)
          time -= (group.finish ? rng.int(45, 60) : rng.int(55, 80)) * MINUTE
        }
        checkin(registration, time - (group.finish ? 0 : rng.int(0, 5)) * MINUTE)
        times.forEach((at, offset) => stamp(registration, offset + 1, at))
      }
    }
  }

  const statements = [
    ...inserts(
      'person',
      ['id', 'vorname', 'nachname', 'email', 'land', 'telefon', 'created_at', 'updated_at'],
      persons.map((p) => [
        p.id,
        p.vorname,
        p.nachname,
        p.email,
        p.land,
        p.telefon,
        dateTime(p.firstSeen),
        dateTime(p.firstSeen),
      ]),
    ),
    ...inserts(
      'event',
      ['id', 'jahr', 'name', 'datum', 'startort', 'strecke_km', 'ticketpreis', 'anmeldeschluss'],
      events.map((e) => [
        e.id,
        e.jahr,
        `Internationale 32-km-Wanderung ${String(e.jahr)}`,
        date(e.day),
        'Bad Grünstein',
        '32.0',
        money(e.ticketpreis),
        date(e.anmeldeschluss),
      ]),
    ),
    ...inserts(
      'anmeldung',
      [
        'id',
        'person_id',
        'event_id',
        'ticket_typ',
        'status',
        'startnummer',
        'betrag_soll',
        'angemeldet_am',
        'updated_at',
      ],
      registrations.map((r) => {
        const event = events[r.eventId - 1]!
        const ticket =
          r.ticket === 'helfer'
            ? 0
            : r.ticket === 'ermaessigt'
              ? Math.round((event.ticketpreis * 0.7) / 100) * 100
              : event.ticketpreis
        return [
          r.id,
          r.person.id,
          r.eventId,
          r.ticket,
          r.cancelled ? 'storniert' : 'angemeldet',
          r.startnummer,
          money(ticket),
          dateTime(r.angemeldetAm),
          dateTime(r.angemeldetAm),
        ]
      }),
    ),
    ...inserts(
      'hotel',
      ['id', 'name', 'ort', 'kontakt_email'],
      [
        [1, 'Hotel Lindenhof', 'Bad Grünstein', 'rezeption@lindenhof.example.org'],
        [2, 'Berggasthof Adler', 'Adlersberg', 'info@berggasthof-adler.example.org'],
      ],
    ),
    ...inserts(
      'hotel_kontingent',
      ['id', 'event_id', 'hotel_id', 'zimmerart', 'preis_nacht', 'anzahl'],
      quotaRows,
    ),
    ...inserts(
      'hotelbuchung',
      [
        'id',
        'anmeldung_id',
        'hotel_kontingent_id',
        'anreise',
        'abreise',
        'betrag_soll',
        'eingecheckt_am',
      ],
      bookingRows,
    ),
    ...inserts(
      'zahlung',
      ['id', 'anmeldung_id', 'betrag', 'eingang_am', 'verwendungszweck', 'kommentar'],
      paymentRows,
    ),
    ...inserts(
      'station',
      ['id', 'event_id', 'nummer', 'name', 'km', 'oeffnet', 'schliesst', 'ist_ziel'],
      stationRows,
    ),
    ...inserts('checkin', ['id', 'anmeldung_id', 'eingecheckt_am', 'stempelkarte_nr'], checkinRows),
    ...inserts('stempel', ['id', 'anmeldung_id', 'station_id', 'zeitpunkt'], stamps),
    ...inserts(
      'ehrung',
      ['id', 'person_id', 'event_id', 'art', 'uebergeben_am'],
      awards.map((award, index) => [
        index + 1,
        award.person.id,
        award.event.id,
        'medaille_10',
        dateTime(award.event.at(21 * 60)),
      ]),
    ),
  ]

  return {
    statements,
    facts: {
      events: events.length,
      currentEventId: current.id,
      previousEventId: current.id - 1,
      persons: persons.length,
      countries: new Set(persons.map((p) => p.land)).size,
      registrations: current2026.length,
      cancelled: current2026.filter((r) => r.cancelled).length,
      hotelBookings: QUOTAS.reduce((sum, quota) => sum + quota.booked2026, 0),
      hotelRooms: QUOTAS.reduce((sum, quota) => sum + quota.anzahl, 0),
      paid: checkedIn.length + paidWaiting.length,
      partlyPaid: partly.length,
      unpaid: unpaid.length,
      checkedIn: checkedIn.length,
      atFinish: 61,
      overdue: 3,
      medalCandidates: candidates.length,
      awards: awards.length,
    },
  }
}
