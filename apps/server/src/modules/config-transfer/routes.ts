// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { configImportApply, configImportInput } from '@stashley/shared'
import type { FastifyInstance } from 'fastify'
import { parse } from '../../platform/http/validation.ts'
import { actorOf, requireRole } from '../auth/context.ts'
import type { ConfigTransferService } from './service.ts'

export interface ConfigTransferRouteDeps {
  transfer: ConfigTransferService
}

/** A configuration file of a few hundred pages and queries stays well below this. */
const bodyLimit = 20 * 1024 * 1024

/** Configuration export and import (§24), for admins only. */
export function registerConfigTransferRoutes(
  app: FastifyInstance,
  deps: ConfigTransferRouteDeps,
): void {
  app.get('/internal/admin/config/export', async (request) => {
    requireRole(request, ['admin'])
    return deps.transfer.export(actorOf(request))
  })

  app.post('/internal/admin/config/import/preview', { bodyLimit }, async (request) => {
    requireRole(request, ['admin'])
    const body = parse(configImportInput, request.body)
    return deps.transfer.preview(body)
  })

  app.post('/internal/admin/config/import', { bodyLimit }, async (request) => {
    requireRole(request, ['admin'])
    const body = parse(configImportApply, request.body)
    return deps.transfer.apply(actorOf(request), body)
  })
}
