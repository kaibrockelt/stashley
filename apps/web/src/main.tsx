// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchSession } from './api/client.ts'
import { sessionKey } from './api/session.ts'
import { Providers, queryClient, userLocale } from './app/providers.tsx'
import { loadPageRoute, router } from './app/router.tsx'
import { prefetchPage } from './features/workspace/api.ts'
import { loadMessages, negotiateLocale } from './i18n/locale.ts'
import './ui/tokens.css'
import './ui/base.css'

// The first render needs the session, the messages and, on a page link, the page chunk. They
// load side by side; the browser language stands in for the profile's until the session says.
if (window.location.pathname.startsWith('/pages/')) void loadPageRoute().catch(() => undefined)
const guessed = negotiateLocale(navigator.languages)
const guessedMessages = loadMessages(guessed)
const session = await fetchSession().catch(() => undefined)
if (session !== undefined) queryClient.setQueryData(sessionKey, session)
if (session?.state === 'active') prefetchPage(queryClient, window.location)
const locale = userLocale(session)
document.documentElement.lang = locale
const messages = locale === guessed ? await guessedMessages : await loadMessages(locale)

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <Providers initial={{ locale, messages }}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
