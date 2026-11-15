// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentResult, CountResult, TableResult } from '@stashley/shared'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client.ts'
import { modeFields, usePageContext } from '../page-context.tsx'

export interface TableOptions {
  sort?: { columnId: string; direction: 'asc' | 'desc' } | undefined
  search?: string | undefined
  cursor?: string | undefined
  pageSize?: number | undefined
}

function body(context: ReturnType<typeof usePageContext>, options: TableOptions) {
  return {
    ...modeFields(context),
    filters: context.filters,
    params: context.params,
    ...(options.sort !== undefined && { sort: options.sort }),
    ...(options.search !== undefined && options.search !== '' && { search: options.search }),
    ...(options.cursor !== undefined && { cursor: options.cursor }),
    ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
  }
}

/** Reads a component through its page (§15); the server checks rights on every call. */
export function useComponentData<T extends ComponentResult | TableResult>(
  componentId: string,
  options: TableOptions = {},
  enabled = true,
) {
  const context = usePageContext()
  const client = useQueryClient()
  const request = body(context, options)
  const key = ['workspace', 'component', context.page.id, componentId, request] as const
  const url = `/internal/pages/${context.page.id}/components/${componentId}`
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<T>('POST', `${url}/query`, request),
    placeholderData: keepPreviousData,
    retry: false,
    enabled,
  })
  const refresh = useMutation({
    mutationFn: () => api<T>('POST', `${url}/refresh`, request),
    onSuccess: (result) => client.setQueryData(key, result),
  })
  return { query, refresh }
}

export function useComponentCount(componentId: string, options: TableOptions, enabled: boolean) {
  const context = usePageContext()
  const request = body(context, { search: options.search })
  return useQuery({
    queryKey: ['workspace', 'count', context.page.id, componentId, request],
    queryFn: () =>
      api<CountResult>(
        'POST',
        `/internal/pages/${context.page.id}/components/${componentId}/count`,
        request,
      ),
    enabled,
    retry: false,
  })
}
