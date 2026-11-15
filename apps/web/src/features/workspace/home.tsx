// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Navigate } from '@tanstack/react-router'
import { useT } from '../../i18n/use-t.ts'
import { StateView } from '../../ui/state.tsx'
import { useNavigation } from './api.ts'

/** The start page of the user's first role with one, otherwise the first visible page (§13.5). */
export function Home() {
  const t = useT()
  const navigation = useNavigation()
  if (navigation.isPending) return <StateView title={t('block.loading')} mascot={false} />
  const home = navigation.data?.home ?? null
  if (home !== null) return <Navigate to="/pages/$slug" params={{ slug: home }} replace />
  return <StateView title={t('home.empty.title')} />
}
