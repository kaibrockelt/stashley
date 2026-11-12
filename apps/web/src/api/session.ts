// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionResponse, SessionUser } from '@stashley/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchSession } from './client.ts'

export const sessionKey = ['session'] as const

export function useSession(): SessionResponse {
  const query = useQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 60_000 })
  if (query.data === undefined) throw new Error('Session not loaded')
  return query.data
}

/** The signed-in user; only for routes behind the session gate. */
export function useUser(): SessionUser {
  const { user } = useSession()
  if (user === null) throw new Error('No user')
  return user
}

export function useRefreshSession(): () => Promise<SessionResponse> {
  const client = useQueryClient()
  return () => client.fetchQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 0 })
}
