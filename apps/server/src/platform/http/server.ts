// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { v7 as uuidv7 } from 'uuid'
import { errorHandler, problem, sendProblem } from './problem.ts'

/** Path prefixes owned by the server; unknown paths below them never fall back to the web client. */
const serverPrefixes = ['/internal/', '/api/', '/mcp', '/oauth/', '/.well-known/', '/auth/']

export interface HttpOptions {
  logLevel: string
  trustProxy: string | undefined
  webDir: string | undefined
  /** Disables request logging, e.g. in tests. */
  quiet?: boolean
}

/** Link tokens belong in the URL fragment; a token pasted into a path is still never logged. */
const tokenPath = /^(\/(?:internal\/)?(?:invitations?|password-reset))\/[^/?]{16,}/

export function logPath(url: string): string {
  return (url.split('?')[0] ?? '').replace(tokenPath, '$1/[redacted]')
}

export function loggerOptions(
  level: string,
  quiet = false,
): NonNullable<FastifyServerOptions['logger']> {
  if (quiet) return false
  return {
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
      remove: true,
    },
    serializers: {
      // Query strings can carry filter values from users; log the path only.
      req(request: { method: string; url: string; ip?: string }) {
        return { method: request.method, path: logPath(request.url), ip: request.ip }
      },
    },
  }
}

export async function createHttpServer(options: HttpOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(options.logLevel, options.quiet),
    genReqId: () => uuidv7(),
    trustProxy: options.trustProxy ?? false,
    forceCloseConnections: 'idle',
    return503OnClosing: true,
  })

  // JSON is the only accepted request body type; everything else is answered with 415.
  app.removeContentTypeParser('text/plain')

  await app.register(helmet, {
    enableCSPNonces: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: false,
    referrerPolicy: { policy: 'same-origin' },
  })

  app.setErrorHandler(errorHandler)

  const indexHtml = loadIndexHtml(options.webDir)
  if (options.webDir !== undefined && indexHtml !== undefined) {
    await app.register(fastifyStatic, {
      root: options.webDir,
      prefix: '/',
      index: false,
      wildcard: true,
      // Directories and index.html go to the web client fallback below.
      allowedPath: (pathName) => !pathName.endsWith('/') && pathName !== '/index.html',
      setHeaders(res, filePath) {
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
        res.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }

  app.setNotFoundHandler((request, reply) => {
    const pathName = request.url.split('?')[0] ?? '/'
    const isServerPath = serverPrefixes.some((prefix) => pathName.startsWith(prefix))
    const isRead = request.method === 'GET' || request.method === 'HEAD'
    if (isRead && !isServerPath && indexHtml !== undefined) {
      const nonce = reply.cspNonce.style
      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(
          indexHtml.replace('<head>', `<head>\n    <meta name="csp-nonce" content="${nonce}" />`),
        )
    }
    return sendProblem(reply, problem('not_found'))
  })

  return app
}

function loadIndexHtml(webDir: string | undefined): string | undefined {
  if (webDir === undefined) return undefined
  const file = path.join(webDir, 'index.html')
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}
