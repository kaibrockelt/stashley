// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageMode, RenderPage } from '@stashley/shared'
import { createContext, useContext } from 'react'

/** What every block of a page needs to read its data (§13.6). */
export interface PageContextValue {
  page: RenderPage
  mode: PageMode
  /** Preview: the roles whose rights apply. */
  roles: readonly string[]
  /** Page filter values by filter ID, as in the URL. */
  filters: Readonly<Record<string, unknown>>
  /** URL parameter values of the page. */
  params: Readonly<Record<string, unknown>>
  /** Managers and admins see configuration hints. */
  designer: boolean
}

const PageContext = createContext<PageContextValue | null>(null)

export const PageContextProvider = PageContext.Provider

export function usePageContext(): PageContextValue {
  const value = useContext(PageContext)
  if (value === null) throw new Error('No page context')
  return value
}

/** The mode fields of every component request. */
export function modeFields(context: PageContextValue) {
  return {
    ...(context.mode !== 'runtime' && { mode: context.mode }),
    ...(context.roles.length > 0 && { roles: [...context.roles] }),
  }
}
