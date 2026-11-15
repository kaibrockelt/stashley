// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PageDetail,
  PageDocument,
  PageVersionDetail,
  PageVersionSummary,
} from '@stashley/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useFormatDateTime } from '../../i18n/format.ts'
import { useT } from '../../i18n/use-t.ts'
import { Actions, Badge, Button, Dialog, Notice, SelectField } from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'
import { designKeys } from '../design/design-api.ts'
import { ChangeList } from './changes.tsx'
import styles from './editor.module.css'

const draft = 'draft'

function useVersion(pageId: string, version: string) {
  return useQuery({
    queryKey: [...designKeys.versions(pageId), version],
    queryFn: () =>
      api<PageVersionDetail>('GET', `/internal/design/pages/${pageId}/versions/${version}`),
    enabled: version !== draft,
  })
}

/**
 * The last 20 published versions (§ Navigation und Seiten): compare any two of them or the
 * draft, and restore one into the draft. Restoring takes effect after the next publish.
 */
export function VersionsDialog(props: {
  pageId: string
  draft: PageDocument
  revision: number
  dirty: boolean
  onRestored: (detail: PageDetail) => void
  onClose: () => void
}) {
  const t = useT()
  const errors = useErrorText()
  const formatDate = useFormatDateTime()
  const versions = useQuery({
    queryKey: designKeys.versions(props.pageId),
    queryFn: async () =>
      (
        await api<{ data: PageVersionSummary[] }>(
          'GET',
          `/internal/design/pages/${props.pageId}/versions`,
        )
      ).data,
  })
  const list = versions.data ?? []
  const [from, setFrom] = useState<string>()
  const [to, setTo] = useState<string>(draft)
  const [confirming, setConfirming] = useState<number>()
  const fromKey = from ?? (list[0] === undefined ? draft : String(list[0].version))
  const before = useVersion(props.pageId, fromKey)
  const after = useVersion(props.pageId, to)
  const restore = useMutation({
    mutationFn: (version: number) =>
      api<PageDetail>(
        'POST',
        `/internal/design/pages/${props.pageId}/versions/${version}/restore`,
        undefined,
        {
          'if-match': `"${props.revision}"`,
        },
      ),
    onSuccess: props.onRestored,
  })
  const options = [
    { id: draft, label: t('versions.draft') },
    ...list.map((entry) => ({
      id: String(entry.version),
      label: t('versions.version', { version: entry.version }),
    })),
  ]
  const documentOf = (key: string, query: typeof before) =>
    key === draft ? props.draft : query.data?.document
  const beforeDocument = documentOf(fromKey, before)
  const afterDocument = documentOf(to, after)
  return (
    <Dialog
      title={t('versions.title')}
      isOpen
      isWide
      onOpenChange={(open) => !open && props.onClose()}
    >
      {errors.message(restore.error) !== undefined && (
        <Notice tone="error">{errors.message(restore.error)}</Notice>
      )}
      {props.dirty && <Notice tone="info">{t('versions.dirty')}</Notice>}
      {list.length === 0 ? (
        <p className={styles.muted}>{t('versions.none')}</p>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th>{t('versions.column.version')}</th>
                <th>{t('versions.column.published')}</th>
                <th>{t('versions.column.by')}</th>
                <th>
                  <span className={styles.muted}>{t('versions.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((entry) => (
                <tr key={entry.version}>
                  <td>
                    {entry.version}{' '}
                    {entry.current && <Badge tone="success">{t('versions.current')}</Badge>}
                  </td>
                  <td>{formatDate(entry.publishedAt)}</td>
                  <td>{entry.publishedBy ?? '–'}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onPress={() => {
                        setFrom(String(entry.version))
                        setTo(draft)
                      }}
                    >
                      {t('versions.compareWithDraft')}
                    </Button>
                    <Button
                      variant="ghost"
                      isDisabled={props.dirty || restore.isPending}
                      onPress={() => setConfirming(entry.version)}
                    >
                      {t('versions.restore')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 0 && (
        <>
          <div className={styles.inline}>
            <SelectField
              label={t('versions.from')}
              value={fromKey}
              onChange={setFrom}
              options={options}
            />
            <SelectField label={t('versions.to')} value={to} onChange={setTo} options={options} />
          </div>
          {beforeDocument !== undefined && afterDocument !== undefined ? (
            <ChangeList before={beforeDocument} after={afterDocument} />
          ) : (
            <p className={styles.muted}>{t('block.loading')}</p>
          )}
        </>
      )}
      <Actions>
        <Button onPress={props.onClose}>{t('action.done')}</Button>
      </Actions>
      {confirming !== undefined && (
        <RestoreConfirmation
          pageId={props.pageId}
          version={confirming}
          draft={props.draft}
          busy={restore.isPending}
          onConfirm={() => {
            restore.mutate(confirming)
            setConfirming(undefined)
          }}
          onClose={() => setConfirming(undefined)}
        />
      )}
    </Dialog>
  )
}

/** Restoring replaces the saved draft, which has no history: show what is lost first. */
function RestoreConfirmation(props: {
  pageId: string
  version: number
  draft: PageDocument
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useT()
  const version = useVersion(props.pageId, String(props.version))
  return (
    <Dialog
      title={t('versions.confirm.title', { version: props.version })}
      isOpen
      isWide
      onOpenChange={(open) => !open && props.onClose()}
    >
      <p>{t('versions.confirm.text')}</p>
      {version.data === undefined ? (
        <p className={styles.muted}>{t('block.loading')}</p>
      ) : (
        <ChangeList before={props.draft} after={version.data.document} />
      )}
      <Actions>
        <Button onPress={props.onClose}>{t('action.cancel')}</Button>
        <Button
          variant="danger"
          isDisabled={props.busy || version.data === undefined}
          onPress={props.onConfirm}
        >
          {t('versions.restore')}
        </Button>
      </Actions>
    </Dialog>
  )
}
