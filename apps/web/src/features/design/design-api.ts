// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DesignCatalog,
  DesignConnection,
  InstanceVariable,
  PageSummary,
  Query,
  QuerySummary,
  Role,
  Section,
} from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'

/** Server state of the design area, shared by the page list, the editor and the query editor. */
export const designKeys = {
  sections: ['design', 'sections'] as const,
  pages: ['design', 'pages'] as const,
  page: (id: string) => ['design', 'page', id] as const,
  versions: (id: string) => ['design', 'page', id, 'versions'] as const,
  roles: ['design', 'roles'] as const,
  queries: ['design', 'queries'] as const,
  query: (id: string) => ['design', 'query', id] as const,
  connections: ['design', 'connections'] as const,
  catalog: (id: string) => ['design', 'catalog', id] as const,
  variables: ['design', 'variables'] as const,
}

export function useSections() {
  return useQuery({
    queryKey: designKeys.sections,
    queryFn: async () => (await api<{ data: Section[] }>('GET', '/internal/design/sections')).data,
  })
}

export function usePages() {
  return useQuery({
    queryKey: designKeys.pages,
    queryFn: async () => (await api<{ data: PageSummary[] }>('GET', '/internal/design/pages')).data,
  })
}

export function useRoles() {
  return useQuery({
    queryKey: designKeys.roles,
    queryFn: async () => (await api<{ data: Role[] }>('GET', '/internal/design/roles')).data,
  })
}

export function useQueries() {
  return useQuery({
    queryKey: designKeys.queries,
    queryFn: async () =>
      (await api<{ data: QuerySummary[] }>('GET', '/internal/design/queries')).data,
  })
}

export function useQueryDetail(id: string | undefined) {
  return useQuery({
    queryKey: designKeys.query(id ?? ''),
    queryFn: () => api<Query>('GET', `/internal/design/queries/${id ?? ''}`),
    enabled: id !== undefined && id !== '',
  })
}

export function useDesignConnections() {
  return useQuery({
    queryKey: designKeys.connections,
    queryFn: async () =>
      (await api<{ data: DesignConnection[] }>('GET', '/internal/design/connections')).data,
  })
}

export function useCatalog(connectionId: string | undefined) {
  return useQuery({
    queryKey: designKeys.catalog(connectionId ?? ''),
    queryFn: () => api<DesignCatalog>('GET', `/internal/design/catalog/${connectionId ?? ''}`),
    enabled: connectionId !== undefined && connectionId !== '',
    staleTime: 60_000,
  })
}

export function useVariables() {
  return useQuery({
    queryKey: designKeys.variables,
    queryFn: async () =>
      (await api<{ data: InstanceVariable[] }>('GET', '/internal/design/variables')).data,
  })
}
