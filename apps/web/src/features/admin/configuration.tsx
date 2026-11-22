// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ConfigConflictCode,
  ConfigFile,
  ConfigImportItem,
  ConfigImportPlan,
  ConfigItemKind,
  Connection,
} from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, ApiError } from '../../api/client.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useFormatDateTime } from '../../i18n/format.ts'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Badge,
  Button,
  Notice,
  PageHeader,
  Section,
  SelectField,
} from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'

const kindLabels: Record<ConfigItemKind, MessageId> = {
  section: 'config.kind.section',
  role: 'config.kind.role',
  variable: 'config.kind.variable',
  relation: 'config.kind.relation',
  display_template: 'config.kind.displayTemplate',
  query: 'config.kind.query',
  page: 'config.kind.page',
}

const statusLabels: Record<
  ConfigImportItem['status'],
  { id: MessageId; tone: 'neutral' | 'accent' | 'danger' | 'success' }
> = {
  new: { id: 'config.status.new', tone: 'success' },
  changed: { id: 'config.status.changed', tone: 'accent' },
  unchanged: { id: 'config.status.unchanged', tone: 'neutral' },
  conflict: { id: 'config.status.conflict', tone: 'danger' },
}

const conflictLabels: Record<ConfigConflictCode, MessageId> = {
  connection_unmapped: 'config.conflict.connectionUnmapped',
  table_access_missing: 'config.conflict.tableAccessMissing',
  table_unknown: 'config.conflict.tableUnknown',
  name_taken: 'config.conflict.nameTaken',
  archived: 'config.conflict.archived',
  connection_differs: 'config.conflict.connectionDiffers',
  version_differs: 'config.conflict.versionDiffers',
  query_invalid: 'config.conflict.queryInvalid',
  type_differs: 'config.conflict.typeDiffers',
  kind_differs: 'config.conflict.kindDiffers',
  relation_invalid: 'config.conflict.relationInvalid',
  relation_differs: 'config.conflict.relationDiffers',
  template_invalid: 'config.conflict.templateInvalid',
  reference_missing: 'config.conflict.referenceMissing',
}

const unmapped = '__none'

function saveFile(name: string, text: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

function ExportSection() {
  const t = useT()
  const errors = useErrorText()
  const run = useMutation({
    mutationFn: () => api<ConfigFile>('GET', '/internal/admin/config/export'),
    onSuccess: (file) => {
      saveFile(
        `stashley-config-${file.exportedAt.slice(0, 10)}.json`,
        `${JSON.stringify(file, null, 2)}\n`,
      )
    },
  })
  return (
    <Section title={t('config.export.title')}>
      <p className={table.muted}>{t('config.export.hint')}</p>
      {run.error !== null && <Notice tone="error">{errors.message(run.error)}</Notice>}
      <Actions>
        <Button onPress={() => run.mutate()} isDisabled={run.isPending}>
          {t('config.export.action')}
        </Button>
      </Actions>
    </Section>
  )
}

function ImportSection() {
  const t = useT()
  const errors = useErrorText()
  const formatDate = useFormatDateTime()
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; content: ConfigFile } | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const connections = useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: () => api<{ data: Connection[] }>('GET', '/internal/admin/connections'),
  })
  const body = () => ({
    file: file?.content,
    connections: Object.fromEntries(
      Object.entries(mapping).filter(([, connectionId]) => connectionId !== unmapped),
    ),
  })
  const preview = useMutation({
    mutationFn: () =>
      api<ConfigImportPlan>('POST', '/internal/admin/config/import/preview', body()),
  })
  const apply = useMutation({
    mutationFn: (plan: ConfigImportPlan) =>
      api<ConfigImportPlan>('POST', '/internal/admin/config/import', {
        ...body(),
        fingerprint: plan.fingerprint,
      }),
    onSuccess: async () => {
      // Pages, queries, roles and variables all may have changed.
      await client.invalidateQueries()
    },
    onError: () => preview.mutate(),
  })

  const choose = async (chosen: File) => {
    preview.reset()
    apply.reset()
    setInvalid(false)
    let content: ConfigFile
    try {
      content = JSON.parse(await chosen.text()) as ConfigFile
      if (content.format !== 'stashley-config' || !Array.isArray(content.connections)) {
        throw new Error('format')
      }
    } catch {
      setFile(null)
      setInvalid(true)
      return
    }
    setFile({ name: chosen.name, content })
    // Connections with the same name are mapped already.
    const available = connections.data?.data ?? []
    setMapping(
      Object.fromEntries(
        content.connections.map(({ ref }) => [
          ref,
          available.find((connection) => connection.name === ref)?.id ?? unmapped,
        ]),
      ),
    )
  }

  const plan = preview.data
  const outdated = apply.error instanceof ApiError && apply.error.body.detail === 'preview_outdated'
  const options = [
    { id: unmapped, label: t('config.import.unmapped') },
    ...(connections.data?.data ?? []).map((connection) => ({
      id: connection.id,
      label: connection.name,
    })),
  ]

  return (
    <Section title={t('config.import.title')}>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0]
          if (chosen !== undefined) void choose(chosen)
          event.target.value = ''
        }}
      />
      <Actions>
        <Button onPress={() => input.current?.click()}>{t('config.import.choose')}</Button>
      </Actions>
      {invalid && <Notice tone="error">{t('config.import.invalidFile')}</Notice>}
      {file !== null && (
        <>
          <p className={table.muted}>
            {t('config.import.source', {
              name: file.name,
              appVersion: file.content.appVersion,
              exportedAt: formatDate(file.content.exportedAt),
            })}
          </p>
          {file.content.connections.map(({ ref }) => (
            <SelectField
              key={ref}
              label={t('config.import.connection', { ref })}
              value={mapping[ref] ?? unmapped}
              onChange={(value) => {
                setMapping((current) => ({ ...current, [ref]: value }))
                preview.reset()
              }}
              options={options}
            />
          ))}
          {preview.error !== null && (
            <Notice tone="error">
              {preview.error instanceof ApiError && preview.error.code === 'validation_failed'
                ? t('config.import.invalidFile')
                : errors.message(preview.error)}
            </Notice>
          )}
          <Actions>
            <Button onPress={() => preview.mutate()} isDisabled={preview.isPending}>
              {t('config.import.preview')}
            </Button>
            {plan !== undefined && plan.counts.conflict === 0 && !apply.isSuccess && (
              <Button
                variant="primary"
                onPress={() => apply.mutate(plan)}
                isDisabled={apply.isPending || plan.counts.new + plan.counts.changed === 0}
              >
                {t('config.import.apply')}
              </Button>
            )}
          </Actions>
        </>
      )}
      {apply.isSuccess && <Notice tone="success">{t('config.import.done')}</Notice>}
      {apply.error !== null && (
        <Notice tone="error">
          {outdated ? t('config.import.outdated') : errors.message(apply.error)}
        </Notice>
      )}
      {plan !== undefined && (
        <>
          <p aria-live="polite">{t('config.import.summary', plan.counts)}</p>
          {plan.counts.conflict > 0 && <Notice tone="info">{t('config.import.blocked')}</Notice>}
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col">{t('config.column.kind')}</th>
                  <th scope="col">{t('config.column.item')}</th>
                  <th scope="col">{t('config.column.status')}</th>
                  <th scope="col">{t('config.column.conflicts')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={`${item.kind}:${item.key}`}>
                    <td>{t(kindLabels[item.kind])}</td>
                    <td>{item.label}</td>
                    <td>
                      <Badge tone={statusLabels[item.status].tone}>
                        {t(statusLabels[item.status].id)}
                      </Badge>
                    </td>
                    <td>
                      {item.conflicts.map((conflict) => (
                        <div key={`${conflict.code}:${conflict.detail ?? ''}`}>
                          {t(conflictLabels[conflict.code])}
                          {conflict.detail !== undefined && (
                            <span className={table.mono}> {conflict.detail}</span>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  )
}

/** Configuration export and import (§24). */
export function ConfigurationPage() {
  const t = useT()
  return (
    <>
      <PageHeader title={t('config.title')} />
      <ExportSection />
      <ImportSection />
    </>
  )
}
