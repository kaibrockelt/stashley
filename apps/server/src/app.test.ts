// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createServer, KeyMismatchError, type Server } from './app.ts'
import { testConfig } from './test/helpers.ts'

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(setup?: (app: FastifyInstance) => void) {
  const config = testConfig()
  mkdirSync(config.webDir, { recursive: true })
  writeFileSync(
    path.join(config.webDir, 'index.html'),
    '<!doctype html><html><head><title>Stashley</title></head><body></body></html>',
  )
  mkdirSync(path.join(config.webDir, 'assets'))
  writeFileSync(path.join(config.webDir, 'assets', 'app-abc.js'), 'console.log(1)')
  const server = await createServer(config, { quiet: true, listen: false })
  servers.push(server)
  setup?.(server.app)
  await server.start()
  return { server, config }
}

describe('health', () => {
  it('reports liveness and readiness', async () => {
    const { server } = await started()
    const health = await server.app.inject('/healthz')
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
    const ready = await server.app.inject('/readyz')
    expect(ready.statusCode).toBe(200)
    server.readiness.ready = false
    const notReady = await server.app.inject('/readyz')
    expect(notReady.statusCode).toBe(503)
    expect(notReady.headers['content-type']).toContain('application/problem+json')
  })
})

describe('http conventions', () => {
  it('answers unknown server paths with a problem document', async () => {
    const { server } = await started()
    const response = await server.app.inject('/internal/nothing')
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      type: 'urn:stashley:problem:not_found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
    })
  })

  it('rejects non-JSON request bodies with 415', async () => {
    const { server } = await started((app) => {
      app.post('/internal/echo', (request) => request.body)
    })
    const response = await server.app.inject({
      method: 'POST',
      url: '/internal/echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    })
    expect(response.statusCode).toBe(415)
    expect(response.json<{ code: string }>().code).toBe('unsupported_media_type')
  })

  it('serves the web client with a CSP nonce', async () => {
    const { server } = await started()
    const root = await server.app.inject('/')
    expect(root.statusCode).toBe(200)
    expect(root.body).toContain('csp-nonce')
    const head = await server.app.inject({ method: 'HEAD', url: '/' })
    expect(head.statusCode).toBe(200)
    const response = await server.app.inject('/pages/overview')
    expect(response.statusCode).toBe(200)
    const csp = response.headers['content-security-policy']
    expect(typeof csp).toBe('string')
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(String(csp))?.[1]
    expect(nonce).toBeDefined()
    expect(response.body).toContain(`<meta name="csp-nonce" content="${nonce}" />`)
    expect(String(csp)).toContain("frame-ancestors 'none'")
    expect(String(csp)).not.toContain('unsafe-inline')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('same-origin')
    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  it('serves hashed assets as immutable and hides index.html', async () => {
    const { server } = await started()
    const asset = await server.app.inject('/assets/app-abc.js')
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['cache-control']).toContain('immutable')
    const index = await server.app.inject('/index.html')
    expect(index.body).toContain('csp-nonce')
  })

  it('hides internal errors behind an error id', async () => {
    const { server } = await started((app) => {
      app.get('/internal/fail', () => {
        throw new Error('database said: secret row value')
      })
    })
    const response = await server.app.inject('/internal/fail')
    expect(response.statusCode).toBe(500)
    const body = response.json<{ code: string; errorId: string }>()
    expect(body.code).toBe('internal_error')
    expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.body).not.toContain('secret row value')
  })
})

describe('startup', () => {
  it('refuses to start with a different secret key', async () => {
    const { config, server } = await started()
    await server.stop()
    const other = await createServer(
      { ...config, secretKey: 'another-secret-key-of-sufficient-length' },
      { quiet: true, listen: false },
    )
    servers.push(other)
    await expect(other.start()).rejects.toBeInstanceOf(KeyMismatchError)
  })
})
