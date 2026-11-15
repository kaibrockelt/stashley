// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

export const themes = ['light', 'dark', 'system'] as const
export type Theme = (typeof themes)[number]

const storageKey = 'stashley.theme'

export function parseTheme(value: unknown): Theme {
  return themes.includes(value as Theme) ? (value as Theme) : 'system'
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'> | undefined): Theme {
  try {
    return parseTheme(storage?.getItem(storageKey))
  } catch {
    return 'system'
  }
}

export function storeTheme(storage: Pick<Storage, 'setItem'> | undefined, theme: Theme): void {
  try {
    storage?.setItem(storageKey, theme)
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this page only.
  }
}

/** `system` removes the attribute so the `prefers-color-scheme` media query applies. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/** The theme in effect: the `data-theme` attribute, or the system preference. */
export function resolvedTheme(root: HTMLElement, prefersDark: boolean): 'light' | 'dark' {
  const attribute = root.getAttribute('data-theme')
  if (attribute === 'light' || attribute === 'dark') return attribute
  return prefersDark ? 'dark' : 'light'
}
