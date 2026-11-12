// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { useIntl } from 'react-intl'
import { useSession } from '../api/session.ts'

/** Formats instants in the instance time zone and the user's formatting locale. */
export function useFormatDateTime(): (iso: string | null) => string {
  const intl = useIntl()
  const { instance } = useSession()
  return (iso) =>
    iso === null
      ? '–'
      : intl.formatDate(iso, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: instance.timeZone,
        })
}
