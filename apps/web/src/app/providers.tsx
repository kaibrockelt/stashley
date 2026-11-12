// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionResponse, Theme } from '@stashley/shared'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { IntlProvider } from 'react-intl'
import { sessionKey } from '../api/session.ts'
import { fetchSession } from '../api/client.ts'
import { loadMessages, negotiateLocale, type Locale, type Messages } from '../i18n/locale.ts'
import { applyTheme, readStoredTheme, storeTheme } from '../ui/theme.ts'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (value === undefined) throw new Error('useTheme outside of Providers')
  return value
}

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function userLocale(session: SessionResponse | undefined): Locale {
  return session?.user?.locale ?? negotiateLocale(navigator.languages)
}

/**
 * Applies the signed-in user's language, formatting locale and theme; anonymous visitors
 * get the browser language and the theme stored on this device.
 */
function Preferences(props: {
  initial: { locale: Locale; messages: Messages }
  children: ReactNode
}) {
  const session = useQuery({ queryKey: sessionKey, queryFn: fetchSession }).data
  const [loaded, setLoaded] = useState(props.initial)
  const [localTheme, setLocalTheme] = useState<Theme>(() => readStoredTheme(storage()))
  const locale = userLocale(session)
  const theme = session?.user?.theme ?? localTheme

  useEffect(() => {
    if (locale === loaded.locale) return
    let cancelled = false
    void loadMessages(locale).then((messages) => {
      if (!cancelled) setLoaded({ locale, messages })
    })
    return () => {
      cancelled = true
    }
  }, [locale, loaded.locale])

  useEffect(() => {
    document.documentElement.lang = loaded.locale
  }, [loaded.locale])

  useEffect(() => {
    applyTheme(document.documentElement, theme)
  }, [theme])

  const setTheme = (next: Theme) => {
    storeTheme(storage(), next)
    setLocalTheme(next)
  }

  return (
    <IntlProvider
      locale={session?.user?.formatLocale ?? loaded.locale}
      messages={loaded.messages}
      defaultLocale="en"
    >
      <ThemeContext value={{ theme, setTheme }}>{props.children}</ThemeContext>
    </IntlProvider>
  )
}

export function Providers(props: {
  initial: { locale: Locale; messages: Messages }
  children: ReactNode
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <Preferences initial={props.initial}>{props.children}</Preferences>
    </QueryClientProvider>
  )
}
