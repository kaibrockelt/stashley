// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
  request,
} from '@playwright/test'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * The internal API as the web client uses it: session cookie, CSRF token and same-origin
 * headers. Works on a page's own request context, so a browser page shares its session.
 */
export class Api {
  private csrf = ''
  readonly context: APIRequestContext
  readonly base: string

  constructor(context: APIRequestContext, base: string) {
    this.context = context
    this.base = base
  }

  /** A separate, signed-out API client. */
  static async open(base: string): Promise<Api> {
    return new Api(await request.newContext({ baseURL: base }), base)
  }

  /** The API of a browser page, sharing its cookies. */
  static of(page: Page, base: string): Api {
    return new Api(page.request, base)
  }

  async refresh(): Promise<void> {
    const response = await this.context.get(`${this.base}/internal/session`)
    this.csrf = ((await response.json()) as { csrfToken: string }).csrfToken
  }

  /** Whether the session belongs to a signed-in, active account. */
  async signedIn(): Promise<boolean> {
    const response = await this.context.get(`${this.base}/internal/session`)
    const session = (await response.json()) as { state: string; user: unknown }
    return session.state === 'active' && session.user !== null
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.refresh()
    const response = await this.send('POST', '/internal/auth/login', { email, password })
    expect(response.status(), `sign-in of ${email}: ${await response.text()}`).toBe(200)
    await this.refresh()
  }

  async send(
    method: Method,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<APIResponse> {
    if (this.csrf === '') await this.refresh()
    return this.context.fetch(`${this.base}${path}`, {
      method,
      headers: {
        origin: this.base,
        'sec-fetch-site': 'same-origin',
        ...(method !== 'GET' && { 'x-csrf-token': this.csrf }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { data: JSON.stringify(body) }),
    })
  }

  /** Sends and expects a status; returns the parsed body. */
  async json<T>(method: Method, path: string, body?: unknown, status = [200, 201]): Promise<T> {
    const response = await this.send(method, path, body)
    expect(status, `${method} ${path}: ${await response.text()}`).toContain(response.status())
    const text = await response.text()
    return (text === '' ? undefined : JSON.parse(text)) as T
  }
}
