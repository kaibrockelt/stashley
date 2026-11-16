// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionResponse } from '@stashley/shared'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

/** Browser-like test client: keeps cookies and sends the CSRF token like the web client. */
export class TestClient {
  private readonly app: FastifyInstance
  readonly cookies = new Map<string, string>()
  private csrf = ''

  constructor(app: FastifyInstance) {
    this.app = app
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private store(response: LightMyRequestResponse): void {
    for (const cookie of response.cookies) {
      const expired =
        cookie.value === '' ||
        cookie.maxAge === 0 ||
        (cookie.expires !== undefined && cookie.expires.getTime() < Date.now())
      if (expired) this.cookies.delete(cookie.name)
      else this.cookies.set(cookie.name, cookie.value)
    }
  }

  async session(): Promise<SessionResponse> {
    const response = await this.request('GET', '/internal/session')
    const body = response.json<SessionResponse>()
    this.csrf = body.csrfToken
    return body
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const response = await this.app.inject({
      method,
      url,
      headers: {
        cookie: this.cookieHeader(),
        ...(method !== 'GET' && { 'x-csrf-token': this.csrf, 'sec-fetch-site': 'same-origin' }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { payload: JSON.stringify(body) }),
    })
    this.store(response)
    return response
  }

  /** Posts a raw body, e.g. a CSV upload (D1), with a fresh CSRF token. */
  async upload(
    url: string,
    payload: string | Buffer,
    contentType = 'text/csv',
  ): Promise<LightMyRequestResponse> {
    await this.session()
    const response = await this.app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: this.cookieHeader(),
        'x-csrf-token': this.csrf,
        'sec-fetch-site': 'same-origin',
        'content-type': contentType,
      },
      payload,
    })
    this.store(response)
    return response
  }

  /** Sends a state-changing request with a fresh CSRF token. */
  async send(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse> {
    await this.session()
    return this.request(method, url, body)
  }

  async login(email: string, password: string): Promise<LightMyRequestResponse> {
    return this.send('POST', '/internal/auth/login', { email, password })
  }
}
