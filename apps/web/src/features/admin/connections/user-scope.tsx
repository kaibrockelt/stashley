// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { UserScope } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Button } from '../../../ui/controls.tsx'
import styles from './connections.module.css'
import { opLabels } from './texts.tsx'

const noteLabels: Record<UserScope['notes'][number], MessageId> = {
  no_grant_report: 'scope.note.noGrantReport',
  account_unknown: 'scope.note.accountUnknown',
  global_select: 'scope.note.globalSelect',
  global_write: 'scope.note.globalWrite',
  roles: 'scope.note.roles',
}

const texts: Record<
  UserScope['purpose'],
  { title: MessageId; ok: MessageId; hint: MessageId; statements: MessageId }
> = {
  read: {
    title: 'scope.read.title',
    ok: 'scope.read.ok',
    hint: 'scope.read.hint',
    statements: 'scope.read.statements',
  },
  write: {
    title: 'scope.write.title',
    ok: 'scope.write.ok',
    hint: 'scope.write.hint',
    statements: 'scope.write.statements',
  },
}

/**
 * What the read or write user may do beyond the table access, with the statements that limit
 * it to it, so the database refuses the rest itself.
 */
export function UserScopePanel(props: { connectionId: string; purpose: UserScope['purpose'] }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const scope = useQuery({
    queryKey: ['admin', 'connection', props.connectionId, 'scope', props.purpose],
    queryFn: () =>
      api<UserScope>(
        'GET',
        `/internal/admin/connections/${props.connectionId}/${props.purpose}-scope`,
      ),
  })
  const data = scope.data
  if (data === undefined) return null
  const label = texts[data.purpose]
  const findings =
    data.unexposedReadable.length +
    data.excludedReadable.length +
    data.excludedWritable.length +
    data.writableBeyondCeiling.length
  const text = data.statements.join('\n')
  return (
    <div className={styles.grants}>
      <p className={styles.blockTitle}>{t(label.title)}</p>
      {findings === 0 && data.notes.length === 0 && <p className={styles.ok}>{t(label.ok)}</p>}
      {findings > 0 && (
        <ul className={styles.warnings}>
          {data.unexposedReadable.length > 0 && (
            <li>{t('scope.unexposed', { objects: data.unexposedReadable.join(', ') })}</li>
          )}
          {data.excludedReadable.length > 0 && (
            <li>
              {t('scope.excluded', {
                columns: data.excludedReadable
                  .flatMap((entry) => entry.columns.map((column) => `${entry.object}.${column}`))
                  .join(', '),
              })}
            </li>
          )}
          {data.excludedWritable.length > 0 && (
            <li>
              {t('scope.write.excluded', {
                columns: data.excludedWritable
                  .flatMap((entry) => entry.columns.map((column) => `${entry.object}.${column}`))
                  .join(', '),
              })}
            </li>
          )}
          {data.writableBeyondCeiling.length > 0 && (
            <li>
              {t('scope.write.beyond', {
                objects: data.writableBeyondCeiling
                  .map(
                    (entry) =>
                      `${entry.object} (${entry.ops.map((op) => t(opLabels[op])).join(', ')})`,
                  )
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
          <p className={styles.muted}>{t(label.hint)}</p>
          <pre className={styles.statements} aria-label={t(label.statements)}>
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
