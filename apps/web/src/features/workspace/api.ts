// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Navigation, PageMode, RenderPage } from '@stashley/shared'
import { type QueryClient, useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'

export const navigationKey = ['workspace', 'navigation'] as const

export function useNavigation() {
  return useQuery({
    queryKey: navigationKey,
    queryFn: () => api<Navigation>('GET', '/internal/navigation'),
    staleTime: 30_000,
  })
}

export function pageKey(slug: string, mode: PageMode, roles: readonly string[]) {
  return ['workspace', 'page', slug, mode, roles.join(',')] as const
}

function renderPageQuery(slug: string, mode: PageMode, roles: readonly string[]) {
  return {
    queryKey: pageKey(slug, mode, roles),
    queryFn: () => {
      const search = new URLSearchParams()
      if (mode !== 'runtime') search.set('mode', mode)
      if (roles.length > 0) search.set('roles', roles.join(','))
      const query = search.size > 0 ? `?${search.toString()}` : ''
      return api<RenderPage>('GET', `/internal/pages/${encodeURIComponent(slug)}${query}`)
    },
    retry: false,
    // A prefetch at start (prefetchPage) counts as fresh for the first render.
    staleTime: 5_000,
  }
}

export function useRenderPage(slug: string, mode: PageMode, roles: readonly string[]) {
  return useQuery(renderPageQuery(slug, mode, roles))
}

/**
 * Starts loading the navigation and the page of a page link while the app starts, instead of
 * after its code has loaded and rendered (§ first render under 2 s on 4G).
 */
export function prefetchPage(client: QueryClient, location: Location): void {
  const slug = /^\/pages\/([^/]+)\/?$/.exec(location.pathname)?.[1]
  if (slug === undefined || new URLSearchParams(location.search).has('mode')) return
  void client.prefetchQuery({
    queryKey: navigationKey,
    queryFn: () => api<Navigation>('GET', '/internal/navigation'),
    staleTime: 30_000,
  })
  void client.prefetchQuery(renderPageQuery(decodeURIComponent(slug), 'runtime', []))
}
