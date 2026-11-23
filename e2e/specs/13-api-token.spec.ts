// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, request, test } from '@playwright/test'
import { expectAccessible } from '../support/axe.ts'
import { sql } from '../support/db.ts'
import { env, runDirectory } from '../support/env.ts'
import { as, dialog, facts, setChecked } from '../support/ui.ts'

// Criterion: the admin enables list, get and create for payments and creates a token with
// create only. A write through the API appears in the audit log, and list with that token
// returns 403.
test('a create-only token writes payments and cannot list them', async ({ browser }) => {
  const { context, page } = await as(browser, 'admin')

  // The API name must differ from the table name before endpoints open (E14).
  await page.goto('/admin/connections')
  await page.getByRole('link', { name: 'wanderverein' }).click()
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'zahlung', exact: true }) })
    .getByRole('button', { name: 'Edit' })
    .click()
  const access = dialog(page, 'zahlung')
  await access.getByRole('textbox', { name: 'Name in the API', exact: true }).fill('payments')
  await access.getByRole('button', { name: 'Save' }).click()
  await expect(access).toBeHidden()

  await page.goto('/admin/api')
  const endpoint = page.getByRole('row').filter({ hasText: 'payments' })
  await endpoint.getByRole('button').first().click()
  const endpoints = page.getByRole('dialog')
  for (const operation of ['List', 'Get', 'Create']) await setChecked(endpoints, operation, true)
  await endpoints.getByRole('button', { name: 'Save' }).click()
  await expect(endpoints).toBeHidden()
  await expectAccessible(page, 'API endpoints')

  await page.getByRole('button', { name: 'New token' }).click()
  const form = dialog(page, 'New token')
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('n8n Zahlungsimport')
  await setChecked(form, 'Create on payments', true)
  await form.getByRole('button', { name: 'Create token' }).click()
  const secret = await page.getByRole('textbox', { name: 'Token', exact: true }).inputValue()
  expect(secret).toMatch(/^stl_api_/)
  await expectAccessible(page, 'token shown once')
  await page.getByRole('button', { name: 'Done' }).click()

  const [registration] = await sql<{ id: number }>(
    "SELECT id FROM anmeldung WHERE event_id = ? AND status = 'angemeldet' ORDER BY id DESC LIMIT 1",
    [facts().currentEventId],
  )
  const client = await request.newContext({
    baseURL: env.a.base,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  })
  const created = await client.post('/api/v1/payments', {
    data: {
      anmeldung_id: registration?.id,
      betrag: '5.00',
      eingang_am: '2026-05-01',
      verwendungszweck: 'API',
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const listed = await client.get('/api/v1/payments')
  expect(listed.status()).toBe(403)
  await client.dispose()

  // The full OpenAPI document of this instance, the example the API reference is built from.
  const openapi = await page.request.get('/internal/admin/api/openapi')
  expect(openapi.status()).toBe(200)
  const document: unknown = await openapi.json()
  writeFileSync(path.join(runDirectory, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`)
  // The documentation site renders its API reference from this example; keep it current.
  const example: unknown = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '..', '..', 'docs', 'api', 'openapi.example.json'),
      'utf8',
    ),
  )
  expect(
    document,
    'docs/api/openapi.example.json is out of date; copy e2e/.tmp/openapi.json over it',
  ).toEqual(example)

  await page.goto('/admin/audit')
  await page.getByRole('textbox', { name: 'Action', exact: true }).fill('row.created')
  await expect(
    page.getByRole('row').filter({ hasText: 'n8n Zahlungsimport' }).first(),
  ).toContainText(/verwendungszweck: null → "API"/)
  await context.close()
})
