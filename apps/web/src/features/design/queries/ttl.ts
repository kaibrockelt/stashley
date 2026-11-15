// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { cacheTtlPresets } from '@stashley/shared'
import { useIntl } from 'react-intl'
import { useT } from '../../../i18n/use-t.ts'
import { formatDuration } from '../../workspace/format.ts'

/** Cache durations of § Abfragen und Caching: live, presets, or custom seconds. */
export function useTtlLabel(): (seconds: number) => string {
  const t = useT()
  const intl = useIntl()
  return (seconds) => (seconds === 0 ? t('queries.ttl.live') : formatDuration(intl, seconds))
}

export function ttlOptions(label: (seconds: number) => string, current: number) {
  const presets: number[] = [...cacheTtlPresets]
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b)
  return values.map((seconds) => ({ id: String(seconds), label: label(seconds) }))
}
