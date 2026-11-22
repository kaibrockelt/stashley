// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Load test (§ Qualitätsanforderungen): 50 concurrent users on an instance limited to
// 2 vCPU and 2 GB, run with k6 by scripts/load-test.sh against the environment the end-to-end
// suite set up. Cached block reads must stay under 300 ms at the 95th percentile, uncached
// reads (live table pages) under 1 s.
import { check, sleep } from 'k6'
import http from 'k6/http'

const base = __ENV.BASE_URL ?? 'http://localhost:8080'
const password = __ENV.USER_PASSWORD
const id = (name) => __ENV[`ID_${name}`]

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 50 },
        { duration: '60s', target: 50 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{kind:cached}': ['p(95)<300'],
    'http_req_duration{kind:uncached}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
}

const accounts = [
  'petra.krueger@wanderverein.test',
  'jonas.weber@wanderverein.test',
  'aylin.demir@wanderverein.test',
  'helfer1@wanderverein.test',
]

/** Signs every account in once; virtual users share the sessions (sign-in is rate limited). */
export function setup() {
  return accounts.map((email) => {
    const jar = http.cookieJar()
    const session = http.get(`${base}/internal/session`, { jar }).json()
    const headers = {
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': session.csrfToken,
    }
    const login = http.post(`${base}/internal/auth/login`, JSON.stringify({ email, password }), {
      headers,
      jar,
    })
    check(login, { 'signed in': (response) => response.status === 200 })
    const signedIn = http.get(`${base}/internal/session`, { jar }).json()
    const cookies = jar.cookiesForURL(base)
    return {
      cookie: Object.entries(cookies)
        .map(([name, values]) => `${name}=${values[0]}`)
        .join('; '),
      csrf: signedIn.csrfToken,
    }
  })
}

function read(session, pageId, component, kind, body = {}) {
  const response = http.post(
    `${base}/internal/pages/${pageId}/components/${component}/query`,
    JSON.stringify(body),
    {
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
        origin: base,
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': session.csrf,
      },
      tags: { kind, component },
    },
  )
  check(response, { [`${component} 200`]: (r) => r.status === 200 })
}

export default function (sessions) {
  const orga = sessions[0]
  const kasse = sessions[1]
  // Dashboards: cached queries (5 min).
  for (const component of ['anmeldungen', 'woche', 'trichter', 'land']) {
    read(kasse, id('UEBERSICHT'), component, 'cached')
  }
  read(kasse, id('KASSE'), 'offene-posten', 'cached')
  // Live table pages: every read goes to the database.
  read(orga, id('ANMELDUNGEN'), 'anmeldungen', 'uncached', { pageSize: 50 })
  read(orga, id('TEILNEHMER'), 'personen', 'uncached', { pageSize: 50, search: 'ner' })
  read(sessions[3], id('STATION'), 'letzte', 'uncached')
  sleep(1)
}
