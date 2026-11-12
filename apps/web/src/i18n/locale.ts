// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type en from './messages/en.json'

export const locales = ['en', 'de'] as const
export type Locale = (typeof locales)[number]
export type MessageId = keyof typeof en
export type Messages = Record<MessageId, string>

/** Picks the first supported language from the browser's preference list. */
export function negotiateLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const language = tag.toLowerCase().split('-')[0]
    const match = locales.find((locale) => locale === language)
    if (match !== undefined) return match
  }
  return 'en'
}

export async function loadMessages(locale: Locale): Promise<Messages> {
  const module =
    locale === 'de' ? await import('./messages/de.json') : await import('./messages/en.json')
  return module.default
}
