// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchSession } from './api/client.ts'
import { sessionKey } from './api/session.ts'
import { Providers, queryClient, userLocale } from './app/providers.tsx'
import { router } from './app/router.tsx'
import { loadMessages } from './i18n/locale.ts'
import './ui/tokens.css'
import './ui/base.css'

const session = await fetchSession().catch(() => undefined)
if (session !== undefined) queryClient.setQueryData(sessionKey, session)
const locale = userLocale(session)
document.documentElement.lang = locale
const messages = await loadMessages(locale)

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <Providers initial={{ locale, messages }}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
