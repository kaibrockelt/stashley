// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Navigation, PageMode, RenderPage } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
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

export function useRenderPage(slug: string, mode: PageMode, roles: readonly string[]) {
  return useQuery({
    queryKey: pageKey(slug, mode, roles),
    queryFn: () => {
      const search = new URLSearchParams()
      if (mode !== 'runtime') search.set('mode', mode)
      if (roles.length > 0) search.set('roles', roles.join(','))
      const query = search.size > 0 ? `?${search.toString()}` : ''
      return api<RenderPage>('GET', `/internal/pages/${encodeURIComponent(slug)}${query}`)
    },
    retry: false,
  })
}
