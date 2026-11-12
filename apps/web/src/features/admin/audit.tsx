// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEvent, Page } from '@stashley/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useFormatDateTime } from '../../i18n/format.ts'
import { useT } from '../../i18n/use-t.ts'
import { Button, buttonClass, PageHeader, TextField } from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'

function describeChanges(event: AuditEvent): string {
  const parts = Object.entries(event.changes ?? {}).map(
    ([field, [before, after]]) => `${field}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  )
  if (event.details !== null) parts.push(JSON.stringify(event.details))
  return parts.join('; ')
}

export function AuditPage() {
  const t = useT()
  const formatDate = useFormatDateTime()
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const filter = new URLSearchParams({
    ...(action !== '' && { action }),
    ...(actor !== '' && { actor }),
  })
  const events = useInfiniteQuery({
    queryKey: ['admin', 'audit', action, actor],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(filter)
      if (pageParam !== undefined) params.set('cursor', pageParam)
      return api<Page<AuditEvent>>('GET', `/internal/admin/audit?${params.toString()}`)
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const rows = events.data?.pages.flatMap((page) => page.data) ?? []
  return (
    <>
      <PageHeader
        title={t('audit.title')}
        actions={
          <a
            className={buttonClass()}
            href={`/internal/admin/audit/export?${filter.toString()}`}
            download
          >
            {t('action.exportCsv')}
          </a>
        }
      />
      <div className={table.toolbar}>
        <TextField label={t('audit.action')} value={action} onChange={setAction} />
        <TextField label={t('audit.actor')} value={actor} onChange={setActor} />
      </div>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('audit.time')}</th>
              <th>{t('audit.actor')}</th>
              <th>{t('audit.action')}</th>
              <th>{t('audit.subject')}</th>
              <th>{t('audit.changes')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id}>
                <td className={table.muted}>{formatDate(event.occurredAt)}</td>
                <td>{event.actorLabel ?? event.actorKind}</td>
                <td className={table.mono}>{event.action}</td>
                <td>{event.subjectLabel ?? ''}</td>
                <td className={table.mono}>{describeChanges(event)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !events.isPending && (
          <p className={table.empty}>{t('audit.empty')}</p>
        )}
      </div>
      {events.hasNextPage && (
        <div className={table.more}>
          <Button
            onPress={() => void events.fetchNextPage()}
            isDisabled={events.isFetchingNextPage}
          >
            {t('action.loadMore')}
          </Button>
        </div>
      )}
    </>
  )
}
