// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react'
import { resolvedTheme } from './theme.ts'

/** Follows theme changes from the profile and from the system, for canvas charts. */
export function useResolvedTheme(): 'light' | 'dark' {
  const read = () =>
    resolvedTheme(
      document.documentElement,
      window.matchMedia('(prefers-color-scheme: dark)').matches,
    )
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setTheme(read())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])
  return theme
}
