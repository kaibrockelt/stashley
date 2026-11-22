// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'

/**
 * The demo scenario as a Stashley configuration file (§24): roles, the instance variable,
 * relations, display templates, queries and every page of the hiking club. Admins import it
 * after connecting the demo database and sharing its tables with `demoCeilings`. IDs are
 * derived from names, so every generated file is the same.
 *
 * The types are kept structural on purpose; the server validates the file on import, and
 * the unit test parses it with the shared schema.
 */

/** The connection name the configuration refers to; the import maps it. */
export const demoConnectionName = 'wanderverein'

/** Table access of the scenario (§ Obergrenzen). Views are read only. */
export const demoCeilings: Record<string, ('read' | 'create' | 'update' | 'delete')[]> = {
  person: ['read', 'create', 'update'],
  event: ['read', 'create', 'update'],
  hotel: ['read', 'create', 'update'],
  hotel_kontingent: ['read', 'create', 'update'],
  station: ['read', 'create', 'update'],
  anmeldung: ['read', 'create', 'update'],
  hotelbuchung: ['read', 'create', 'update', 'delete'],
  zahlung: ['read', 'create', 'update'],
  checkin: ['read', 'create', 'delete'],
  stempel: ['read', 'create', 'delete'],
  ehrung: ['read', 'create'],
}

/** Key columns of the views; `v_medaille` has none and is used like a query. */
export const demoViewKeys: Record<string, string | null> = {
  v_teilnahmen: 'person_id',
  v_zahlungsstatus: 'anmeldung_id',
  v_streckenlage: 'anmeldung_id',
  v_medaille: null,
}

/** A stable UUID (version 4 layout) derived from a name. */
export function demoId(name: string): string {
  const hex = createHash('sha256').update(`stashley-demo:${name}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

type Op = 'read' | 'create' | 'update' | 'delete'
type Json = Record<string, unknown>

export const demoRoles = {
  orga: { name: 'Orga', description: 'Anmeldungen, Teilnehmer, Hotels, Strecke und Ehrung' },
  kasse: { name: 'Kasse', description: 'Zahlungen und offene Posten' },
  checkin: { name: 'Check-in', description: 'Zahlungsprüfung und Start' },
  station: { name: 'Station', description: 'Stempel an den Stationen' },
  lindenhof: { name: 'Hotel Lindenhof', description: 'Rezeption des Hotels Lindenhof' },
  adler: { name: 'Berggasthof Adler', description: 'Rezeption des Berggasthofs Adler' },
} as const
export type DemoRole = keyof typeof demoRoles

const role = (key: DemoRole) => demoId(`role:${key}`)
const table = (object: string) => demoId(`table:${object}`)
const query = (key: string) => demoId(`query:${key}`)
const page = (slug: string) => demoId(`page:${slug}`)

const tableSource = (object: string, cacheTtlSeconds = 0) => ({
  kind: 'table',
  tableAccessId: table(object),
  cacheTtlSeconds,
})
const querySource = (key: string) => ({ kind: 'query', queryId: query(key) })
const col = (column: string, path: [string, string][] = []) => ({
  path: path.map(([from, target]) => ({ column: from, target })),
  column,
})
const column = (id: string, name: string, path: [string, string][] = [], label?: string) => ({
  kind: 'column',
  id,
  column: col(name, path),
  ...(label !== undefined && { label }),
})
const display = (id: string, path: [string, string][], label?: string) => ({
  kind: 'display',
  id,
  path: path.map(([from, target]) => ({ column: from, target })),
  ...(label !== undefined && { label }),
})
const currentEvent = (path: [string, string][] = []) => ({
  column: col('event_id', path),
  operator: 'eq',
  value: { kind: 'variable', name: 'current_event_id' },
})
const input = (id: string, columnName: string, extra: Json = {}) => ({
  kind: 'input',
  id,
  column: columnName,
  required: false,
  hidden: false,
  ...extra,
})
const generatedDate = (id: string, columnName: string, expression: string, editable: boolean) => ({
  kind: 'generated',
  id,
  column: columnName,
  generator: { kind: 'date', expression, editable },
})
const tableConfig = (config: Json) => ({
  searchColumns: [],
  baseFilter: [],
  bindings: [],
  pageSize: 50,
  editing: null,
  csvExport: true,
  sort: null,
  ...config,
})
const block = (id: string, title: string, rest: Json) => ({
  id,
  title,
  restrictions: [],
  ...rest,
})
const metric = (id: string, title: string, source: string, value: string, settings: Json = {}) =>
  block(id, title, {
    type: 'metric',
    source: querySource(source),
    bindings: [],
    settings: { value, ...settings },
  })
const chart = (id: string, title: string, source: string, settings: Json) =>
  block(id, title, {
    type: 'chart',
    source: querySource(source),
    bindings: [],
    settings: { height: 'M', ...settings },
  })
const queryTable = (id: string, title: string, source: string, settings?: Json) =>
  block(id, title, {
    type: 'table',
    source: querySource(source),
    bindings: [],
    table: null,
    ...(settings !== undefined && { settings }),
  })
const row = (id: string, layout: string, blocks: Json[]) => ({ id, layout, blocks })

interface Grant {
  role: DemoRole
  source: string
  ops: Op[]
}
const grant = (roleKey: DemoRole, source: string, ops: Op[]): Grant => ({
  role: roleKey,
  source,
  ops,
})
const reads = (roles: DemoRole[], sources: string[]): Grant[] =>
  roles.flatMap((roleKey) =>
    sources.map((source) => grant(roleKey, `query:${query(source)}`, ['read'])),
  )
const onTable = (roleKey: DemoRole, object: string, ops: Op[]): Grant =>
  grant(roleKey, `table:${table(object)}`, ops)

function dashboard(
  title: string,
  description: string,
  filters: Json[],
  rows: Json[],
  view: DemoRole[],
  grants: Grant[],
) {
  return {
    schemaVersion: 1,
    kind: 'dashboard',
    title,
    description,
    filters,
    parameters: [],
    rows,
    table: null,
    detail: null,
    access: access(view, grants),
    mcp: { available: false },
  }
}

function tablePage(
  title: string,
  description: string,
  main: Json,
  detail: Json[] | null,
  view: DemoRole[],
  grants: Grant[],
) {
  return {
    schemaVersion: 1,
    kind: 'table',
    title,
    description,
    filters: [],
    parameters: [],
    rows: [],
    table: main,
    detail: detail === null ? null : { tables: detail },
    access: access(view, grants),
    mcp: { available: false },
  }
}

function access(view: DemoRole[], grants: Grant[]) {
  return {
    view: view.map(role),
    grants: grants.map((entry) => ({
      principal: role(entry.role),
      source: entry.source,
      ops: entry.ops,
    })),
  }
}

// Queries. Instance variables are named parameters; `:current_event_id` selects the event.

interface DemoQuery {
  key: string
  name: string
  description: string
  cacheTtlSeconds: number
  sql: string
  parameters?: Json[]
}

const active = "a.event_id = :current_event_id AND a.status = 'angemeldet'"

const queries: DemoQuery[] = [
  {
    key: 'kennzahlen',
    name: 'Übersicht Kennzahlen',
    description:
      'Anmeldungen, Zahlungen, Check-in und Strecke des laufenden Events in einer Zeile.',
    cacheTtlSeconds: 300,
    sql: `SELECT
  (SELECT COUNT(*) FROM anmeldung a WHERE ${active}) AS anmeldungen,
  (SELECT COUNT(*) FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id
    WHERE ${active} AND z.status = 'bezahlt') AS bezahlt,
  (SELECT COALESCE(SUM(z.offen), 0) FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id
    WHERE ${active} AND z.offen > 0) AS offen,
  (SELECT COUNT(*) FROM v_streckenlage s WHERE s.event_id = :current_event_id) AS eingecheckt,
  (SELECT COUNT(*) FROM v_streckenlage s WHERE s.event_id = :current_event_id AND s.im_ziel = 0) AS unterwegs,
  (SELECT COUNT(*) FROM v_streckenlage s WHERE s.event_id = :current_event_id AND s.im_ziel = 1) AS im_ziel`,
  },
  {
    key: 'pro_woche',
    name: 'Anmeldungen pro Woche',
    description: '',
    cacheTtlSeconds: 300,
    sql: `SELECT DATE_SUB(DATE(a.angemeldet_am), INTERVAL WEEKDAY(a.angemeldet_am) DAY) AS woche, COUNT(*) AS anmeldungen
FROM anmeldung a
WHERE ${active}
GROUP BY 1
ORDER BY woche`,
  },
  {
    key: 'trichter',
    name: 'Trichter Anmeldung bis Ziel',
    description: '',
    cacheTtlSeconds: 300,
    sql: `SELECT 1 AS schritt, 'angemeldet' AS stufe, COUNT(*) AS anzahl FROM anmeldung a WHERE ${active}
UNION ALL SELECT 2, 'bezahlt', COUNT(*) FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id
  WHERE ${active} AND z.status = 'bezahlt'
UNION ALL SELECT 3, 'eingecheckt', COUNT(*) FROM v_streckenlage s WHERE s.event_id = :current_event_id
UNION ALL SELECT 4, 'im Ziel', COUNT(*) FROM v_streckenlage s WHERE s.event_id = :current_event_id AND s.im_ziel = 1
ORDER BY schritt`,
  },
  {
    key: 'nach_land',
    name: 'Teilnehmer nach Land',
    description: '',
    cacheTtlSeconds: 300,
    sql: `SELECT p.land, COUNT(*) AS teilnehmer
FROM anmeldung a JOIN person p ON p.id = a.person_id
WHERE ${active}
GROUP BY p.land
ORDER BY teilnehmer DESC`,
  },
  {
    key: 'kasse_summen',
    name: 'Kasse Soll und Ist',
    description: '',
    cacheTtlSeconds: 60,
    sql: `SELECT COALESCE(SUM(z.soll), 0) AS soll, COALESCE(SUM(z.ist), 0) AS ist, COALESCE(SUM(z.offen), 0) AS offen
FROM v_zahlungsstatus z JOIN anmeldung a ON a.id = z.anmeldung_id
WHERE ${active}`,
  },
  {
    key: 'offene_posten',
    name: 'Offene Posten',
    description: 'Anmeldungen des laufenden Events mit offenem Betrag.',
    cacheTtlSeconds: 60,
    sql: `SELECT a.startnummer, p.vorname, p.nachname, z.soll, z.ist, z.offen, z.status
FROM v_zahlungsstatus z
JOIN anmeldung a ON a.id = z.anmeldung_id
JOIN person p ON p.id = a.person_id
WHERE ${active} AND z.offen > 0
ORDER BY a.startnummer`,
  },
  {
    key: 'hotel_auslastung',
    name: 'Hotel-Auslastung',
    description: '',
    cacheTtlSeconds: 300,
    sql: `SELECT CONCAT(h.name, ' · ', k.zimmerart) AS kontingent, k.anzahl AS zimmer, COUNT(b.id) AS gebucht
FROM hotel_kontingent k
JOIN hotel h ON h.id = k.hotel_id
LEFT JOIN hotelbuchung b ON b.hotel_kontingent_id = k.id
WHERE k.event_id = :current_event_id
GROUP BY h.name, k.zimmerart, k.anzahl
ORDER BY kontingent`,
  },
  {
    key: 'checkin_auswahl',
    name: 'Check-in Teilnehmerauswahl',
    description: 'Registrierte Anmeldungen des laufenden Events nach Startnummer und Name.',
    cacheTtlSeconds: 60,
    sql: `SELECT a.id, CONCAT(a.startnummer, ' – ', p.vorname, ' ', p.nachname) AS teilnehmer
FROM anmeldung a JOIN person p ON p.id = a.person_id
WHERE ${active}
ORDER BY a.startnummer`,
  },
  {
    key: 'checkin_datensatz',
    name: 'Check-in Teilnehmer',
    description: 'Person, Ticket, Hotel und Zahlungsstatus einer Anmeldung.',
    cacheTtlSeconds: 0,
    sql: `SELECT a.startnummer, CONCAT(p.vorname, ' ', p.nachname) AS name, p.land, a.ticket_typ,
  h.name AS hotel, z.status AS zahlung, z.offen, c.eingecheckt_am
FROM anmeldung a
JOIN person p ON p.id = a.person_id
JOIN v_zahlungsstatus z ON z.anmeldung_id = a.id
LEFT JOIN hotelbuchung b ON b.anmeldung_id = a.id
LEFT JOIN hotel_kontingent k ON k.id = b.hotel_kontingent_id
LEFT JOIN hotel h ON h.id = k.hotel_id
LEFT JOIN checkin c ON c.anmeldung_id = a.id
WHERE a.id = :anmeldung AND a.event_id = :current_event_id`,
    parameters: [
      {
        name: 'anmeldung',
        type: 'integer',
        list: false,
        required: false,
        defaultValue: null,
        label: 'Anmeldung',
      },
    ],
  },
  {
    key: 'checkin_offen',
    name: 'Bereit zum Check-in',
    description: 'Bezahlte, noch nicht eingecheckte Anmeldungen des laufenden Events.',
    cacheTtlSeconds: 0,
    sql: `SELECT a.id, CONCAT(a.startnummer, ' – ', p.vorname, ' ', p.nachname) AS teilnehmer
FROM anmeldung a
JOIN person p ON p.id = a.person_id
JOIN v_zahlungsstatus z ON z.anmeldung_id = a.id
LEFT JOIN checkin c ON c.anmeldung_id = a.id
WHERE ${active} AND z.status = 'bezahlt' AND c.id IS NULL
ORDER BY a.startnummer`,
  },
  {
    key: 'stationen',
    name: 'Stationen',
    description: '',
    cacheTtlSeconds: 3600,
    sql: `SELECT s.id, CONCAT(s.nummer, ' · ', s.name) AS station
FROM station s
WHERE s.event_id = :current_event_id
ORDER BY s.nummer`,
  },
  {
    key: 'letzte_station',
    name: 'Teilnehmer pro letzter Station',
    description: '',
    cacheTtlSeconds: 30,
    sql: `SELECT COALESCE(s.nummer, 0) AS nummer, v.letzte_station, COUNT(*) AS teilnehmer
FROM v_streckenlage v LEFT JOIN station s ON s.id = v.station_id
WHERE v.event_id = :current_event_id AND v.im_ziel = 0
GROUP BY s.nummer, v.letzte_station
ORDER BY nummer`,
  },
  {
    key: 'im_ziel',
    name: 'Im Ziel',
    description: '',
    cacheTtlSeconds: 30,
    sql: `SELECT COUNT(*) AS im_ziel FROM v_streckenlage v WHERE v.event_id = :current_event_id AND v.im_ziel = 1`,
  },
  {
    key: 'ueberfaellig',
    name: 'Überfällige Teilnehmer',
    description: 'Mehr als 90 Minuten ohne Stempel und nicht im Ziel.',
    cacheTtlSeconds: 30,
    sql: `SELECT v.startnummer, p.vorname, p.nachname, p.telefon, v.letzte_station, v.minuten_seit
FROM v_streckenlage v
JOIN anmeldung a ON a.id = v.anmeldung_id
JOIN person p ON p.id = a.person_id
WHERE v.event_id = :current_event_id AND v.im_ziel = 0 AND v.minuten_seit > 90
ORDER BY v.minuten_seit DESC`,
  },
  {
    key: 'stempel_heatmap',
    name: 'Stempel pro Station und Viertelstunde',
    description: '',
    cacheTtlSeconds: 30,
    sql: `SELECT s.name AS station,
  DATE_ADD(TIMESTAMP(DATE_FORMAT(st.zeitpunkt, '%Y-%m-%d %H:00:00')), INTERVAL (FLOOR(MINUTE(st.zeitpunkt) / 15) * 15) MINUTE) AS viertelstunde,
  COUNT(*) AS stempel
FROM stempel st JOIN station s ON s.id = st.station_id
WHERE s.event_id = :current_event_id
GROUP BY 1, 2
ORDER BY viertelstunde`,
  },
  {
    key: 'medaille',
    name: 'Medaillenkandidaten',
    description: 'Teilnehmer mit ihrer 10. Teilnahme ohne Ehrung im laufenden Event.',
    cacheTtlSeconds: 60,
    sql: `SELECT m.person_id, CONCAT(p.vorname, ' ', p.nachname) AS name, p.land, m.teilnahme_nr
FROM v_medaille m JOIN person p ON p.id = m.person_id
WHERE m.event_id = :current_event_id AND m.kandidat = 1
ORDER BY p.nachname, p.vorname`,
  },
]

// Pages.

const euro = { kind: 'currency', currency: 'EUR' }

function pages() {
  const all: { slug: string; section: string; document: Json }[] = []

  all.push({
    slug: 'uebersicht',
    section: 'veranstaltung',
    document: dashboard(
      'Übersicht',
      'Stand des laufenden Events: Anmeldungen, Zahlungen, Check-in und Strecke.',
      [],
      [
        row('kennzahlen-1', '4-4-4', [
          metric('anmeldungen', 'Anmeldungen', 'kennzahlen', 'anmeldungen'),
          metric('bezahlt', 'Bezahlt', 'kennzahlen', 'bezahlt'),
          metric('offen', 'Offener Betrag', 'kennzahlen', 'offen', { formats: { offen: euro } }),
        ]),
        row('kennzahlen-2', '4-4-4', [
          metric('eingecheckt', 'Eingecheckt', 'kennzahlen', 'eingecheckt'),
          metric('unterwegs', 'Unterwegs', 'kennzahlen', 'unterwegs'),
          metric('im-ziel', 'Im Ziel', 'kennzahlen', 'im_ziel'),
        ]),
        row('verlauf', '8-4', [
          chart('woche', 'Anmeldungen pro Woche', 'pro_woche', {
            chart: 'line',
            x: 'woche',
            measures: ['anmeldungen'],
          }),
          chart('trichter', 'Vom Anmelden bis ins Ziel', 'trichter', {
            chart: 'funnel',
            x: 'stufe',
            measures: ['anzahl'],
            roles: { schritt: 'identifier', stufe: 'ordered' },
          }),
        ]),
        row('laender', '12', [
          chart('land', 'Teilnehmer nach Land', 'nach_land', {
            chart: 'bar',
            x: 'land',
            measures: ['teilnehmer'],
          }),
        ]),
      ],
      ['orga', 'kasse', 'checkin'],
      reads(['orga', 'kasse', 'checkin'], ['kennzahlen', 'pro_woche', 'trichter', 'nach_land']),
    ),
  })

  all.push({
    slug: 'anmeldungen',
    section: 'veranstaltung',
    document: tablePage(
      'Anmeldungen',
      'Anmeldungen des laufenden Events mit Zahlungsstatus.',
      block('anmeldungen', 'Anmeldungen', {
        type: 'table',
        source: tableSource('anmeldung'),
        bindings: [],
        settings: { formats: { offen: euro } },
        table: tableConfig({
          columns: [
            column('startnummer', 'startnummer', [], 'Startnr.'),
            display('person', [['person_id', 'person']], 'Teilnehmer'),
            column('land', 'land', [['person_id', 'person']], 'Land'),
            column('ticket', 'ticket_typ', [], 'Ticket'),
            column('status', 'status', [], 'Status'),
            column('zahlung', 'status', [['id', 'v_zahlungsstatus']], 'Zahlung'),
            column('offen', 'offen', [['id', 'v_zahlungsstatus']], 'Offen'),
          ],
          sort: { columnId: 'startnummer', direction: 'asc' },
          searchColumns: ['startnummer', 'person'],
          baseFilter: [currentEvent()],
          editing: {
            ops: ['create', 'update'],
            fields: [
              input('person', 'person_id', {
                widget: 'reference',
                required: true,
                reference: { target: 'person' },
              }),
              input('ticket', 'ticket_typ'),
              input('status', 'status'),
              input('startnummer', 'startnummer'),
              input('betrag', 'betrag_soll', { required: true }),
            ],
            inline: false,
            dialog: true,
          },
        }),
      }),
      [
        block('buchungen', 'Hotelbuchungen', {
          type: 'table',
          source: tableSource('hotelbuchung'),
          link: { column: 'anmeldung_id' },
          bindings: [],
          table: tableConfig({
            columns: [
              display('kontingent', [['hotel_kontingent_id', 'hotel_kontingent']], 'Zimmer'),
              column('anreise', 'anreise', [], 'Anreise'),
              column('abreise', 'abreise', [], 'Abreise'),
              column('betrag', 'betrag_soll', [], 'Betrag'),
            ],
          }),
        }),
        block('zahlungen', 'Zahlungen', {
          type: 'table',
          source: tableSource('zahlung'),
          link: { column: 'anmeldung_id' },
          bindings: [],
          table: tableConfig({
            columns: [
              column('eingang', 'eingang_am', [], 'Eingang'),
              column('betrag', 'betrag', [], 'Betrag'),
              column('zweck', 'verwendungszweck', [], 'Verwendungszweck'),
            ],
            sort: { columnId: 'eingang', direction: 'asc' },
          }),
        }),
      ],
      ['orga', 'kasse', 'checkin'],
      [
        onTable('orga', 'anmeldung', ['read', 'create', 'update']),
        onTable('kasse', 'anmeldung', ['read']),
        onTable('checkin', 'anmeldung', ['read']),
        onTable('orga', 'hotelbuchung', ['read']),
        onTable('orga', 'zahlung', ['read']),
        onTable('kasse', 'zahlung', ['read']),
      ],
    ),
  })

  all.push({
    slug: 'teilnehmer',
    section: 'veranstaltung',
    document: tablePage(
      'Teilnehmer',
      'Stammdaten aller Personen mit ihren Teilnahmen.',
      block('personen', 'Teilnehmer', {
        type: 'table',
        source: tableSource('person'),
        bindings: [],
        table: tableConfig({
          columns: [
            column('nachname', 'nachname', [], 'Nachname'),
            column('vorname', 'vorname', [], 'Vorname'),
            column('land', 'land', [], 'Land'),
            column('email', 'email', [], 'E-Mail'),
            column('telefon', 'telefon', [], 'Telefon'),
          ],
          sort: { columnId: 'nachname', direction: 'asc' },
          searchColumns: ['nachname', 'vorname', 'email'],
          editing: {
            ops: ['create', 'update'],
            fields: [
              input('vorname', 'vorname'),
              input('nachname', 'nachname'),
              input('email', 'email'),
              input('land', 'land'),
              input('telefon', 'telefon'),
            ],
            inline: true,
            dialog: true,
          },
        }),
      }),
      [
        block('teilnahmen', 'Teilnahmen', {
          type: 'table',
          source: tableSource('anmeldung'),
          link: { column: 'person_id' },
          bindings: [],
          table: tableConfig({
            columns: [
              column('jahr', 'jahr', [['event_id', 'event']], 'Jahr'),
              column('startnummer', 'startnummer', [], 'Startnr.'),
              column('status', 'status', [], 'Status'),
            ],
            sort: { columnId: 'jahr', direction: 'desc' },
          }),
        }),
      ],
      ['orga'],
      [
        onTable('orga', 'person', ['read', 'create', 'update']),
        onTable('orga', 'anmeldung', ['read']),
      ],
    ),
  })

  all.push({
    slug: 'kasse',
    section: 'veranstaltung',
    document: dashboard(
      'Kasse',
      'Zahlungseingänge erfassen und offene Posten abgleichen.',
      [],
      [
        row('summen', '4-4-4', [
          metric('soll', 'Soll', 'kasse_summen', 'soll', { formats: { soll: euro } }),
          metric('ist', 'Ist', 'kasse_summen', 'ist', { formats: { ist: euro } }),
          metric('offen', 'Offen', 'kasse_summen', 'offen', { formats: { offen: euro } }),
        ]),
        row('erfassen', '4-8', [
          block('zahlung', 'Zahlung erfassen', {
            type: 'form',
            source: tableSource('zahlung'),
            mode: 'create',
            fields: [
              input('anmeldung', 'anmeldung_id', {
                widget: 'reference',
                required: true,
                label: 'Anmeldung',
                reference: {
                  target: 'anmeldung',
                  searchColumns: ['startnummer'],
                  extras: [col('land', [['person_id', 'person']])],
                  baseFilter: [currentEvent()],
                },
              }),
              input('betrag', 'betrag', { required: true, label: 'Betrag' }),
              { ...generatedDate('eingang', 'eingang_am', 'today', true), label: 'Eingang' },
              input('zweck', 'verwendungszweck', { label: 'Verwendungszweck' }),
              input('kommentar', 'kommentar', { widget: 'textarea', label: 'Kommentar' }),
            ],
            record: null,
            upsertKey: null,
            baseFilter: [],
            afterSave: { action: 'clear' },
            submitLabel: 'Zahlung speichern',
          }),
          queryTable('offene-posten', 'Offene Posten', 'offene_posten', {
            formats: { soll: euro, ist: euro, offen: euro },
          }),
        ]),
      ],
      ['kasse', 'orga'],
      [
        ...reads(['kasse', 'orga'], ['kasse_summen', 'offene_posten']),
        onTable('kasse', 'zahlung', ['read', 'create', 'update']),
        onTable('orga', 'zahlung', ['read']),
      ],
    ),
  })

  all.push({
    slug: 'hotels',
    section: 'hotels',
    document: dashboard(
      'Hotels',
      'Auslastung der Zimmerkontingente und Gäste des laufenden Events.',
      [],
      [
        row('auslastung', '12', [
          chart('auslastung', 'Auslastung pro Kontingent', 'hotel_auslastung', {
            chart: 'bar',
            x: 'kontingent',
            measures: ['gebucht', 'zimmer'],
            orientation: 'horizontal',
            sort: 'query',
          }),
        ]),
        row('gaeste', '12', [
          block('gaeste', 'Gäste', {
            type: 'table',
            source: tableSource('hotelbuchung'),
            bindings: [],
            table: tableConfig({
              columns: [
                display('gast', [['anmeldung_id', 'anmeldung']], 'Gast'),
                display('kontingent', [['hotel_kontingent_id', 'hotel_kontingent']], 'Zimmer'),
                column('anreise', 'anreise', [], 'Anreise'),
                column('abreise', 'abreise', [], 'Abreise'),
                column('eingecheckt', 'eingecheckt_am', [], 'Eingecheckt'),
              ],
              sort: { columnId: 'anreise', direction: 'asc' },
              searchColumns: ['gast'],
              baseFilter: [currentEvent([['hotel_kontingent_id', 'hotel_kontingent']])],
              editing: {
                ops: ['create', 'update', 'delete'],
                fields: [
                  input('anmeldung', 'anmeldung_id', {
                    widget: 'reference',
                    required: true,
                    reference: {
                      target: 'anmeldung',
                      searchColumns: ['startnummer'],
                      baseFilter: [currentEvent()],
                    },
                  }),
                  input('kontingent', 'hotel_kontingent_id', {
                    widget: 'reference',
                    required: true,
                    reference: { target: 'hotel_kontingent', baseFilter: [currentEvent()] },
                  }),
                  input('anreise', 'anreise', { required: true }),
                  input('abreise', 'abreise', { required: true }),
                  input('betrag', 'betrag_soll', { required: true }),
                  input('eingecheckt', 'eingecheckt_am'),
                ],
                inline: false,
                dialog: true,
              },
            }),
          }),
        ]),
      ],
      ['orga'],
      [
        ...reads(['orga'], ['hotel_auslastung']),
        onTable('orga', 'hotelbuchung', ['read', 'create', 'update', 'delete']),
      ],
    ),
  })

  all.push({
    slug: 'check-in',
    section: 'veranstaltung',
    document: dashboard(
      'Check-in',
      'Zahlung prüfen, Stempelkarte ausgeben, Start erfassen.',
      [
        {
          kind: 'select',
          id: 'teilnehmer',
          label: 'Teilnehmer',
          source: querySource('checkin_auswahl'),
          valueColumn: 'id',
          labelColumn: 'teilnehmer',
          multiple: false,
          required: false,
        },
      ],
      [
        row('pruefen', '6-6', [
          block('person', 'Teilnehmer', {
            type: 'record',
            source: querySource('checkin_datensatz'),
            bindings: [
              { parameter: 'anmeldung', from: { kind: 'filter', filterId: 'teilnehmer' } },
            ],
            settings: { formats: { offen: euro, eingecheckt_am: { kind: 'datetime' } } },
          }),
          block('checkin', 'Check-in erfassen', {
            type: 'form',
            source: tableSource('checkin'),
            mode: 'create',
            fields: [
              input('anmeldung', 'anmeldung_id', {
                widget: 'reference',
                required: true,
                label: 'Teilnehmer',
                default: { kind: 'filter', filterId: 'teilnehmer' },
                reference: {
                  target: 'anmeldung',
                  query: {
                    source: querySource('checkin_offen'),
                    valueColumn: 'id',
                    labelColumn: 'teilnehmer',
                    bindings: [],
                  },
                },
              }),
              input('karte', 'stempelkarte_nr', { required: true, label: 'Stempelkarte' }),
              generatedDate('zeit', 'eingecheckt_am', 'now', false),
            ],
            record: null,
            upsertKey: null,
            baseFilter: [],
            afterSave: { action: 'clear' },
            submitLabel: 'Einchecken',
          }),
        ]),
        row('letzte', '12', [
          block('letzte', 'Letzte Check-ins', {
            type: 'table',
            source: tableSource('checkin'),
            bindings: [],
            table: tableConfig({
              columns: [
                column('zeit', 'eingecheckt_am', [], 'Zeit'),
                display('teilnehmer', [['anmeldung_id', 'anmeldung']], 'Teilnehmer'),
                column('karte', 'stempelkarte_nr', [], 'Stempelkarte'),
              ],
              sort: { columnId: 'zeit', direction: 'desc' },
              baseFilter: [currentEvent([['anmeldung_id', 'anmeldung']])],
              pageSize: 20,
              editing: { ops: ['delete'], fields: [], inline: false, dialog: false },
            }),
          }),
        ]),
      ],
      ['checkin', 'orga'],
      [
        // The filter's and the option list's queries count under the page and the form (D12).
        ...reads(['checkin', 'orga'], ['checkin_datensatz']),
        onTable('checkin', 'checkin', ['read', 'create']),
        onTable('orga', 'checkin', ['read', 'delete']),
      ],
    ),
  })

  all.push({
    slug: 'station',
    section: 'veranstaltung',
    document: dashboard(
      'Station',
      'Stempel an der Station erfassen.',
      [
        {
          kind: 'select',
          id: 'station',
          label: 'Station',
          source: querySource('stationen'),
          valueColumn: 'id',
          labelColumn: 'station',
          multiple: false,
          required: false,
        },
      ],
      [
        row('stempeln', '12', [
          block('stempel', 'Stempel erfassen', {
            type: 'form',
            source: tableSource('stempel'),
            mode: 'create',
            fields: [
              input('station', 'station_id', {
                widget: 'reference',
                required: true,
                label: 'Station',
                default: { kind: 'filter', filterId: 'station' },
                reference: { target: 'station', baseFilter: [currentEvent()] },
              }),
              input('startnummer', 'anmeldung_id', {
                widget: 'reference',
                required: true,
                label: 'Startnummer',
                reference: {
                  target: 'anmeldung',
                  searchColumns: ['startnummer'],
                  baseFilter: [
                    currentEvent(),
                    {
                      column: col('status'),
                      operator: 'eq',
                      value: { kind: 'constant', value: 'angemeldet' },
                    },
                  ],
                },
              }),
              generatedDate('zeit', 'zeitpunkt', 'now', false),
            ],
            record: null,
            upsertKey: null,
            baseFilter: [],
            afterSave: { action: 'clear' },
            submitLabel: 'Stempeln',
          }),
        ]),
        row('letzte', '12', [
          block('letzte', 'Letzte Stempel', {
            type: 'table',
            source: tableSource('stempel'),
            bindings: [],
            table: tableConfig({
              columns: [
                column('zeit', 'zeitpunkt', [], 'Zeit'),
                column('startnummer', 'startnummer', [['anmeldung_id', 'anmeldung']], 'Startnr.'),
                display(
                  'name',
                  [
                    ['anmeldung_id', 'anmeldung'],
                    ['person_id', 'person'],
                  ],
                  'Name',
                ),
              ],
              sort: { columnId: 'zeit', direction: 'desc' },
              baseFilter: [currentEvent([['station_id', 'station']])],
              bindings: [
                {
                  from: { kind: 'filter', filterId: 'station' },
                  column: col('station_id'),
                  operator: 'eq',
                },
              ],
              pageSize: 10,
              editing: { ops: ['delete'], fields: [], inline: false, dialog: false },
            }),
          }),
        ]),
      ],
      ['station', 'orga'],
      [
        onTable('station', 'stempel', ['read', 'create']),
        onTable('orga', 'stempel', ['read', 'create', 'delete']),
      ],
    ),
  })

  all.push({
    slug: 'streckenlage',
    section: 'veranstaltung',
    document: dashboard(
      'Streckenlage',
      'Wo die Teilnehmer gerade unterwegs sind.',
      [],
      [
        row('verteilung', '8-4', [
          chart('stationen', 'Teilnehmer pro letzter Station', 'letzte_station', {
            chart: 'bar',
            x: 'letzte_station',
            measures: ['teilnehmer'],
            sort: 'query',
            roles: { nummer: 'identifier' },
          }),
          metric('im-ziel', 'Im Ziel', 'im_ziel', 'im_ziel'),
        ]),
        row('ueberfaellig', '12', [
          queryTable('ueberfaellig', 'Überfällig (über 90 min ohne Stempel)', 'ueberfaellig', {
            formats: { minuten_seit: { kind: 'duration', unit: 'minutes' } },
            labels: { minuten_seit: 'seit' },
          }),
        ]),
        row('heatmap', '12', [
          chart('heatmap', 'Stempel pro Station und Viertelstunde', 'stempel_heatmap', {
            height: 'L',
            chart: 'heatmap',
            x: 'viertelstunde',
            series: 'station',
            measures: ['stempel'],
          }),
        ]),
      ],
      ['orga'],
      reads(['orga'], ['letzte_station', 'im_ziel', 'ueberfaellig', 'stempel_heatmap']),
    ),
  })

  all.push({
    slug: 'ehrung',
    section: 'veranstaltung',
    document: dashboard(
      'Ehrung',
      'Medaillen für die 10. Teilnahme.',
      [],
      [
        row('ehrung', '8-4', [
          queryTable('kandidaten', 'Medaillenkandidaten', 'medaille', {
            columns: [
              { column: 'name' },
              { column: 'land' },
              { column: 'teilnahme_nr', label: 'Teilnahme' },
            ],
          }),
          block('erfassen', 'Ehrung erfassen', {
            type: 'form',
            source: tableSource('ehrung'),
            mode: 'create',
            fields: [
              input('person', 'person_id', {
                widget: 'reference',
                required: true,
                label: 'Person',
                reference: {
                  target: 'person',
                  query: {
                    source: querySource('medaille'),
                    valueColumn: 'person_id',
                    labelColumn: 'name',
                    bindings: [],
                  },
                },
              }),
              input('event', 'event_id', {
                hidden: true,
                default: { kind: 'variable', name: 'current_event_id' },
              }),
              input('art', 'art', {
                hidden: true,
                default: { kind: 'constant', value: 'medaille_10' },
              }),
              {
                ...generatedDate('uebergeben', 'uebergeben_am', 'now', true),
                label: 'Übergeben am',
              },
            ],
            record: null,
            upsertKey: null,
            baseFilter: [],
            afterSave: { action: 'clear' },
            submitLabel: 'Ehrung speichern',
          }),
        ]),
      ],
      ['orga'],
      [...reads(['orga'], ['medaille']), onTable('orga', 'ehrung', ['create'])],
    ),
  })

  for (const [slug, key, hotelId, title] of [
    ['gaeste-lindenhof', 'lindenhof', 1, 'Gäste Hotel Lindenhof'],
    ['gaeste-adler', 'adler', 2, 'Gäste Berggasthof Adler'],
  ] as const) {
    all.push({
      slug,
      section: 'hotels',
      document: tablePage(
        title,
        'Gäste des laufenden Events; Check-in am Abend.',
        block('gaeste', 'Gäste', {
          type: 'table',
          source: tableSource('hotelbuchung'),
          bindings: [],
          table: tableConfig({
            columns: [
              display('gast', [['anmeldung_id', 'anmeldung']], 'Gast'),
              column(
                'zimmer',
                'zimmerart',
                [['hotel_kontingent_id', 'hotel_kontingent']],
                'Zimmer',
              ),
              column('anreise', 'anreise', [], 'Anreise'),
              column('abreise', 'abreise', [], 'Abreise'),
              column('eingecheckt', 'eingecheckt_am', [], 'Eingecheckt'),
            ],
            sort: { columnId: 'anreise', direction: 'asc' },
            searchColumns: ['gast'],
            baseFilter: [
              {
                column: col('hotel_id', [['hotel_kontingent_id', 'hotel_kontingent']]),
                operator: 'eq',
                value: { kind: 'constant', value: hotelId },
              },
              currentEvent([['hotel_kontingent_id', 'hotel_kontingent']]),
            ],
            editing: {
              ops: ['update'],
              fields: [input('eingecheckt', 'eingecheckt_am', { label: 'Eingecheckt' })],
              inline: true,
              dialog: false,
            },
          }),
        }),
        null,
        [key],
        [onTable(key, 'hotelbuchung', ['read', 'update'])],
      ),
    })
  }
  return all
}

const homePages: Record<DemoRole, string> = {
  orga: 'uebersicht',
  kasse: 'kasse',
  checkin: 'check-in',
  station: 'station',
  lindenhof: 'gaeste-lindenhof',
  adler: 'gaeste-adler',
}

/** Every query a document uses, pinned to version 1 for the published document. */
function pinned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pinned)
  if (value === null || typeof value !== 'object') return value
  const record = value as Json
  const copy = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, pinned(entry)]),
  )
  return record.kind === 'query' && typeof record.queryId === 'string'
    ? { ...copy, version: 1 }
    : copy
}

/** The scenario as a configuration file. */
export function demoConfig(options: { exportedAt?: Date } = {}) {
  const tablesUsed = new Set<string>()
  const scenarioPages = pages()
  const findTables = (value: unknown) => {
    const text = JSON.stringify(value)
    for (const object of [...Object.keys(demoCeilings), ...Object.keys(demoViewKeys)]) {
      if (text.includes(table(object))) tablesUsed.add(object)
    }
  }
  for (const entry of scenarioPages) findTables(entry.document)
  return {
    format: 'stashley-config',
    formatVersion: 1,
    appVersion: 'demo',
    exportedAt: (options.exportedAt ?? new Date('2026-01-01T00:00:00Z')).toISOString(),
    connections: [{ ref: demoConnectionName }],
    tables: [...tablesUsed].sort().map((object) => ({
      id: table(object),
      connectionRef: demoConnectionName,
      object,
    })),
    roles: (Object.keys(demoRoles) as DemoRole[]).map((key) => ({
      id: role(key),
      name: demoRoles[key].name,
      description: demoRoles[key].description,
      homePageId: page(homePages[key]),
    })),
    variables: [
      { name: 'current_event_id', type: 'integer', value: 13, description: 'Laufendes Event' },
    ],
    relations: [
      {
        connectionRef: demoConnectionName,
        sourceObject: 'anmeldung',
        sourceColumn: 'id',
        targetObject: 'v_zahlungsstatus',
        targetColumn: 'anmeldung_id',
        kind: 'one_to_one',
      },
    ],
    displayTemplates: [
      ['person', '{vorname} {nachname}'],
      ['anmeldung', '{startnummer} – {person.vorname} {person.nachname}'],
      ['event', '{jahr}'],
      ['hotel', '{name}'],
      ['hotel_kontingent', '{hotel.name} · {zimmerart}'],
      ['station', '{nummer} · {name}'],
    ].map(([object, template]) => ({ connectionRef: demoConnectionName, object, template })),
    queries: queries.map((entry) => ({
      id: query(entry.key),
      connectionRef: demoConnectionName,
      name: entry.name,
      description: entry.description,
      cacheTtlSeconds: entry.cacheTtlSeconds,
      versions: [{ version: 1, sql: entry.sql, builder: null, parameters: entry.parameters ?? [] }],
    })),
    sections: [
      { id: demoId('section:veranstaltung'), name: 'Veranstaltung' },
      { id: demoId('section:hotels'), name: 'Hotels' },
    ],
    pages: scenarioPages.map((entry) => ({
      id: page(entry.slug),
      sectionId: demoId(`section:${entry.section}`),
      slug: entry.slug,
      draft: entry.document,
      published: pinned(entry.document),
    })),
  }
}

/** IDs of the scenario, for tests. */
export const demoIds = { role, table, query, page }
