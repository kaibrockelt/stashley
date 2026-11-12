// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { IntlProvider } from 'react-intl'
import type { Locale, Messages } from '../i18n/locale.ts'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../ui/theme.ts'

const queryClient = new QueryClient({
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

export function Providers(props: { locale: Locale; messages: Messages; children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(storage()))

  useEffect(() => {
    applyTheme(document.documentElement, theme)
  }, [theme])

  const setTheme = (next: Theme) => {
    storeTheme(storage(), next)
    setThemeState(next)
  }

  return (
    <IntlProvider locale={props.locale} messages={props.messages} defaultLocale="en">
      <ThemeContext value={{ theme, setTheme }}>
        <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
      </ThemeContext>
    </IntlProvider>
  )
}
