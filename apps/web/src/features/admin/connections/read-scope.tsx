// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ReadScope } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Button } from '../../../ui/controls.tsx'
import styles from './connections.module.css'

const noteLabels: Record<ReadScope['notes'][number], MessageId> = {
  no_grant_report: 'readScope.note.noGrantReport',
  account_unknown: 'readScope.note.accountUnknown',
  global_select: 'readScope.note.globalSelect',
  roles: 'readScope.note.roles',
}

/**
 * What the read user may read beyond the exposed objects and columns, with the statements
 * that limit it to them, so the database refuses the rest itself.
 */
export function ReadScopePanel(props: { connectionId: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const scope = useQuery({
    queryKey: ['admin', 'connection', props.connectionId, 'read-scope'],
    queryFn: () =>
      api<ReadScope>('GET', `/internal/admin/connections/${props.connectionId}/read-scope`),
  })
  const data = scope.data
  if (data === undefined) return null
  const wide = data.unexposedReadable.length > 0 || data.excludedReadable.length > 0
  const text = data.statements.join('\n')
  return (
    <div className={styles.grants}>
      <p className={styles.blockTitle}>{t('readScope.title')}</p>
      {!wide && data.notes.length === 0 && <p className={styles.ok}>{t('readScope.ok')}</p>}
      {wide && (
        <ul className={styles.warnings}>
          {data.unexposedReadable.length > 0 && (
            <li>{t('readScope.unexposed', { objects: data.unexposedReadable.join(', ') })}</li>
          )}
          {data.excludedReadable.length > 0 && (
            <li>
              {t('readScope.excluded', {
                columns: data.excludedReadable
                  .flatMap((entry) => entry.columns.map((column) => `${entry.object}.${column}`))
                  .join(', '),
              })}
            </li>
          )}
        </ul>
      )}
      {data.notes.map((note) => (
        <p key={note} className={styles.muted}>
          {t(noteLabels[note])}
        </p>
      ))}
      {data.statements.length > 0 && (
        <>
          <p className={styles.muted}>{t('readScope.hint')}</p>
          <pre className={styles.statements} aria-label={t('readScope.statements')}>
            {text}
          </pre>
          <div>
            <Button
              onPress={() => {
                void navigator.clipboard.writeText(text).then(() => setCopied(true))
              }}
            >
              {copied ? t('action.copied') : t('action.copy')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
