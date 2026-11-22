// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path'
import { demoCeilings, demoConnectionName, demoViewKeys } from '@stashley/demo'
import type { Connection, TableAccess } from '@stashley/shared'
import { expect, test } from '@playwright/test'
import { Api } from '../support/api.ts'
import { expectAccessible } from '../support/axe.ts'
import { demoDatabase, env, runDirectory, userPassword } from '../support/env.ts'
import { as, facts, signIn } from '../support/ui.ts'

// Criterion: the configuration is exported and imported into a second instance. After the
// connection is mapped, the demo works there unchanged.
test('the configuration moves to a second instance and works there', async ({ browser }) => {
  test.setTimeout(180_000)
  // Export from the first instance, through the UI.
  const a = await as(browser, 'admin')
  await a.page.goto('/admin/configuration')
  const download = a.page.waitForEvent('download')
  await a.page.getByRole('button', { name: 'Export configuration' }).click()
  const file = path.join(runDirectory, 'exported-config.json')
  await (await download).saveAs(file)
  await a.context.close()

  // The second instance: its admin connects the same database under another name and
  // shares it with the scenario's ceilings (the configuration carries no ceilings).
  const contextB = await browser.newContext({ baseURL: env.b.base })
  const page = await contextB.newPage()
  const api = await signIn(page, 'admin', env.b.base)
  const connection = await api.json<Connection>('POST', '/internal/admin/connections', {
    name: 'Vereinsdatenbank',
    host: demoDatabase.host,
    port: demoDatabase.port,
    databaseName: demoDatabase.database,
    tls: { mode: 'disabled', caPem: null, serverName: null },
    timezone: 'UTC',
    queryTimeoutSeconds: 30,
    credentials: {
      read: demoDatabase.read,
      write: demoDatabase.write,
      schema: null,
    },
  })
  for (const [object, ops] of [
    ...Object.entries(demoCeilings),
    ...Object.keys(demoViewKeys).map((name) => [name, ['read']] as const),
  ]) {
    await api.json<TableAccess>('POST', '/internal/admin/table-access', {
      connectionId: connection.id,
      objectName: object,
      ops,
      keyColumn: object in demoViewKeys ? demoViewKeys[object] : null,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: [],
    })
  }

  await page.goto('/admin/configuration')
  await page.locator('input[type="file"]').setInputFiles(file)
  // Another name: the admin maps the connection.
  await page.getByRole('button', { name: `Connection “${demoConnectionName}”` }).click()
  await page.getByRole('option', { name: 'Vereinsdatenbank' }).click()
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByText(/· 0 conflicts$/)).toBeVisible()
  await expectAccessible(page, 'import preview on the second instance')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByText('Configuration imported.')).toBeVisible()

  // A user with the cashier role sees the same overview figures there.
  const invited = await api.json<{ user: { id: string }; link: string }>(
    'POST',
    '/internal/admin/users',
    {
      email: 'kasse@zweite-instanz.test',
      displayName: 'Kasse Zwei',
      systemRole: 'user',
    },
  )
  const roles = await api.json<{ data: { id: string; name: string }[] }>(
    'GET',
    '/internal/design/roles',
  )
  await api.json('PUT', `/internal/admin/users/${invited.user.id}/roles`, {
    roleIds: [roles.data.find((role) => role.name === 'Kasse')?.id],
  })
  const user = await Api.open(env.b.base)
  await user.json('POST', '/internal/invitations/accept', {
    token: invited.link.split('#').at(-1),
    password: userPassword,
  })
  const second = await browser.newContext({ baseURL: env.b.base })
  const kasse = await second.newPage()
  await Api.of(kasse, env.b.base).signIn('kasse@zweite-instanz.test', userPassword)
  await kasse.goto('/pages/uebersicht')
  await expect(kasse.getByRole('region', { name: 'Eingecheckt', exact: true })).toContainText(
    String(facts().checkedIn),
  )
  await expect(kasse.getByRole('region', { name: 'Zahlung erfassen' })).toBeHidden()
  await kasse.goto('/pages/kasse')
  await expect(kasse.getByRole('region', { name: 'Zahlung erfassen' })).toBeVisible()
  await second.close()
  await contextB.close()
})
