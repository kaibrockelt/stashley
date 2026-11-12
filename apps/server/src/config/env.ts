// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Variables that may be supplied through a `<NAME>_FILE` path, e.g. for Docker secrets. */
const secretVariables = ['APP_SECRET_KEY', 'INITIAL_ADMIN_PASSWORD', 'SMTP_PASSWORD'] as const

const logLevels = ['debug', 'info', 'warn', 'error'] as const

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()

const defaultWebDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../web/dist',
)

const schema = z
  .object({
    APP_SECRET_KEY: z
      .string({ error: 'is required' })
      .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'must be at least 32 bytes'),
    APP_BASE_URL: z
      .url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL' })
      .transform((value) => new URL(value.replace(/\/+$/, ''))),
    APP_TIMEZONE: z.string().default('UTC').refine(isTimeZone, 'must be an IANA time zone'),
    INITIAL_ADMIN_EMAIL: optionalString.pipe(z.email().optional()),
    INITIAL_ADMIN_PASSWORD: optionalString,
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    SMTP_FROM: optionalString,
    TRUST_PROXY: optionalString,
    CACHE_MAX_MB: z.coerce.number().int().min(16).max(65536).default(256),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    STASHLEY_DATA_DIR: z.string().default('/data'),
    STASHLEY_WEB_DIR: z.string().default(defaultWebDir),
  })
  .superRefine((value, ctx) => {
    if (value.APP_BASE_URL.protocol === 'http:' && !isLocalHost(value.APP_BASE_URL.hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_BASE_URL'],
        message: 'must use https unless the host is localhost',
      })
    }
  })

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export interface AppConfig {
  secretKey: string
  baseUrl: URL
  timeZone: string
  initialAdmin: { email: string; password: string } | undefined
  smtp: { host: string; port: number; user?: string; password?: string; from: string } | undefined
  trustProxy: string | undefined
  cacheMaxMb: number
  logLevel: (typeof logLevels)[number]
  port: number
  dataDir: string
  webDir: string
  secureCookies: boolean
}

export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

type Env = Record<string, string | undefined>

/** Resolves `<NAME>_FILE` variants. Values are never included in error messages. */
function resolveSecretFiles(env: Env, readFile: (file: string) => string): [Env, string[]] {
  const resolved: Env = { ...env }
  const issues: string[] = []
  for (const name of secretVariables) {
    const file = env[`${name}_FILE`]
    if (file === undefined || file === '') continue
    if (env[name] !== undefined && env[name] !== '') {
      issues.push(`${name}: set either ${name} or ${name}_FILE, not both`)
      continue
    }
    try {
      resolved[name] = readFile(file).replace(/\r?\n$/, '')
    } catch {
      issues.push(`${name}_FILE: cannot read ${file}`)
    }
  }
  return [resolved, issues]
}

export function loadConfig(
  env: Env = process.env,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): AppConfig {
  // Empty values (e.g. `SMTP_HOST=` in an env file) count as unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  const [resolved, fileIssues] = resolveSecretFiles(present, readFile)
  const result = schema.safeParse(resolved)
  const issues = [...fileIssues]
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(`${issue.path.join('.') || 'environment'}: ${issue.message}`)
    }
  }
  if (issues.length > 0 || !result.success) throw new ConfigError(issues)

  const v = result.data
  const adminPair = [v.INITIAL_ADMIN_EMAIL, v.INITIAL_ADMIN_PASSWORD]
  if (adminPair.filter((item) => item !== undefined).length === 1) {
    throw new ConfigError(['INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD: set both or neither'])
  }
  if (v.SMTP_HOST !== undefined && v.SMTP_FROM === undefined) {
    throw new ConfigError(['SMTP_FROM: is required when SMTP_HOST is set'])
  }

  return {
    secretKey: v.APP_SECRET_KEY,
    baseUrl: v.APP_BASE_URL,
    timeZone: v.APP_TIMEZONE,
    initialAdmin:
      v.INITIAL_ADMIN_EMAIL !== undefined && v.INITIAL_ADMIN_PASSWORD !== undefined
        ? { email: v.INITIAL_ADMIN_EMAIL, password: v.INITIAL_ADMIN_PASSWORD }
        : undefined,
    smtp:
      v.SMTP_HOST !== undefined && v.SMTP_FROM !== undefined
        ? {
            host: v.SMTP_HOST,
            port: v.SMTP_PORT ?? 587,
            ...(v.SMTP_USER !== undefined && { user: v.SMTP_USER }),
            ...(v.SMTP_PASSWORD !== undefined && { password: v.SMTP_PASSWORD }),
            from: v.SMTP_FROM,
          }
        : undefined,
    trustProxy: v.TRUST_PROXY,
    cacheMaxMb: v.CACHE_MAX_MB,
    logLevel: v.LOG_LEVEL,
    port: v.PORT,
    dataDir: v.STASHLEY_DATA_DIR,
    webDir: v.STASHLEY_WEB_DIR,
    secureCookies: v.APP_BASE_URL.protocol === 'https:',
  }
}
