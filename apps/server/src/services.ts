// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from './config/env.ts'
import type { Metastore } from './metastore/db.ts'
import { SettingsRepository } from './metastore/settings.ts'
import { AuditLog } from './modules/audit/audit-log.ts'
import { CatalogService } from './modules/catalog/service.ts'
import { ConnectionsService } from './modules/connections/service.ts'
import { AccessFacts } from './modules/access/facts.ts'
import { AccessService } from './modules/access/service.ts'
import { QueryCache } from './modules/cache/query-cache.ts'
import { ComponentReader } from './modules/execution/component-reader.ts'
import { PagesService } from './modules/pages/service.ts'
import { ReadExecutor } from './modules/execution/executor.ts'
import { QueriesService } from './modules/queries/service.ts'
import { RolesService } from './modules/roles/service.ts'
import { TableAccessService } from './modules/table-access/service.ts'
import { VariablesService } from './modules/variables/service.ts'
import { RowWriter } from './modules/execution/writer.ts'
import { TargetPools, type HostResolver } from './target/pools.ts'
import { sessionCookieName } from './modules/auth/sessions.ts'
import { createOidcClient, OidcService, type OidcClient } from './modules/auth/oidc.ts'
import { AuthService } from './modules/auth/service.ts'
import { SessionService } from './modules/auth/sessions.ts'
import { UserTokens } from './modules/auth/user-tokens.ts'
import { createMailer, type Mailer } from './modules/mail/mailer.ts'
import { InstanceSettingsService } from './modules/system/instance-settings.ts'
import { UsersRepository } from './modules/users/repository.ts'
import { UsersService } from './modules/users/service.ts'
import { systemClock, type Clock } from './platform/clock.ts'
import type { KeyRing } from './platform/crypto/keys.ts'
import { EventBus } from './platform/events.ts'

export interface ServiceOverrides {
  oidcClient?: OidcClient
  /** Integration tests on a developer machine reach databases through loopback. */
  resolveTargetHost?: HostResolver
  mailer?: Mailer
  clock?: Clock
}

/** Composition root shared by the server and the CLI. */
export function createServices(
  config: AppConfig,
  store: Metastore,
  keys: KeyRing,
  log: FastifyBaseLogger,
  overrides: ServiceOverrides = {},
) {
  const db = store.db
  const clock = overrides.clock ?? systemClock
  const base = config.baseUrl.href.replace(/\/$/, '')
  const appUrl = (path: string) => `${base}${path}`
  const settings = new SettingsRepository(db)
  const audit = new AuditLog(db, clock)
  const users = new UsersRepository(db)
  const sessions = new SessionService(db, keys, settings, clock)
  const tokens = new UserTokens(db, clock)
  const mailer = overrides.mailer ?? createMailer(config, log)
  const auth = new AuthService({
    db,
    users,
    sessions,
    tokens,
    settings,
    keys,
    audit,
    mailer,
    appUrl,
    log,
    clock,
  })
  const oidc = new OidcService({
    db,
    users,
    sessions,
    settings,
    keys,
    audit,
    appUrl,
    clock,
    client:
      overrides.oidcClient ??
      createOidcClient({ keys, allowHttp: config.baseUrl.protocol === 'http:' }),
  })
  const usersService = new UsersService({
    db,
    settings,
    users,
    sessions,
    tokens,
    auth,
    audit,
    mailer,
    appUrl,
    clock,
  })
  const instanceSettings = new InstanceSettingsService(db, settings, audit)
  const events = new EventBus((error, event) =>
    log.error({ err: error, event }, 'event handler failed'),
  )
  const pools = new TargetPools(
    overrides.resolveTargetHost === undefined ? {} : { resolveHost: overrides.resolveTargetHost },
  )
  const connections = new ConnectionsService({ db, keys, audit, pools, clock, events })
  const catalog = new CatalogService({ db, connections, audit, log, clock, events })
  const tableAccess = new TableAccessService({ db, connections, catalog, audit, clock, events })
  const roles = new RolesService({ db, settings, audit, events, clock })
  const variables = new VariablesService({ db, audit, events, clock })
  const executor = new ReadExecutor({ connections, pools, events })
  const cache = new QueryCache({ maxBytes: config.cacheMaxMb * 1024 * 1024, events, clock })
  const queries = new QueriesService({
    db,
    connections,
    catalog,
    tableAccess,
    variables,
    executor,
    audit,
    events,
    clock,
  })
  const pages = new PagesService({ db, audit, events, queries, variables, clock })
  const facts = new AccessFacts({ db, connections, catalog, tableAccess, events })
  const access = new AccessService({ facts, pages, queries, roles, variables, events })
  catalog.addImpactProvider((connectionId, diff) => access.impact(connectionId, diff))
  const reader = new ComponentReader({
    executor,
    cache,
    variables,
    cursorKey: keys.key('cursor'),
    displayTimeZone: config.timeZone,
    clock,
  })
  const writer = new RowWriter({
    connections,
    pools,
    audit,
    variables,
    events,
    references: {
      allowed: (handle, field, value, input) =>
        reader.referenceAllowed(handle, field, value, input),
    },
    versionKey: keys.key('rowVersion'),
    timeZone: config.timeZone,
    log,
    clock,
  })
  return {
    access,
    facts,
    pages,
    reader,
    writer,
    cache,
    executor,
    queries,
    roles,
    variables,
    events,
    pools,
    connections,
    catalog,
    tableAccess,
    settings,
    audit,
    users,
    sessions,
    tokens,
    mailer,
    auth,
    oidc,
    usersService,
    instanceSettings,
    cookie: { name: sessionCookieName(config.secureCookies), secure: config.secureCookies },
    origin: config.baseUrl.origin,
    clock,
  }
}

export type Services = ReturnType<typeof createServices>
