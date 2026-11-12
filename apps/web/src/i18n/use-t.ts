// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { useIntl } from 'react-intl'
import type { MessageId } from './locale.ts'

type Values = Record<string, string | number | Date>

/** Typed message lookup: unknown IDs fail type checking. */
export function useT(): (id: MessageId, values?: Values) => string {
  const intl = useIntl()
  return (id, values) => intl.formatMessage({ id }, values)
}
