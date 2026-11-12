// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { loadMessages, negotiateLocale } from './i18n/locale.ts'
import { Providers } from './app/providers.tsx'
import { router } from './app/router.tsx'
import './ui/tokens.css'
import './ui/base.css'

const locale = negotiateLocale(navigator.languages)
document.documentElement.lang = locale
const messages = await loadMessages(locale)

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <Providers locale={locale} messages={messages}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
