// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { useT } from '../../i18n/use-t.ts'
import { StateView } from '../../ui/state.tsx'

export function Home() {
  const t = useT()
  return <StateView title={t('home.empty.title')} />
}
