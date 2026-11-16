// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogObject,
  ExclusionScope,
  LockSetting,
  TableAccess,
  TableOp,
} from '@stashley/shared'
import { isTextKind, tableOps } from '@stashley/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Button,
  CheckboxField,
  Dialog,
  Form,
  Notice,
  SelectField,
  SwitchField,
  TextField,
} from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import { ConsequencesNotice, consequencesOf } from '../api/consequences.tsx'
import styles from './connections.module.css'
import { AccessWarnings, opLabels } from './texts.tsx'

type Visibility = 'shown' | ExclusionScope

export function AccessDialog(props: {
  connectionId: string
  object: CatalogObject
  access: TableAccess | undefined
  onClose: () => void
}) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const { object, access } = props
  const isView = object.type === 'view'
  const textColumn = object.columns.find((column) => isTextKind(column.kind))
  const defaultTemplate = `{${textColumn?.name ?? object.primaryKey[0] ?? object.columns[0]?.name ?? ''}}`
  const [ops, setOps] = useState<TableOp[]>(access?.ops ?? (isView ? ['read'] : ['read']))
  const [keyColumn, setKeyColumn] = useState<string>(
    access?.keyColumn ??
      (isView ? (object.keyCandidates?.[0] ?? '') : (object.primaryKey[0] ?? '')),
  )
  const [template, setTemplate] = useState(access?.displayTemplate ?? '')
  const [resource, setResource] = useState(access?.apiResource ?? '')
  const [mcp, setMcp] = useState(access?.mcpEnabled ?? false)
  const [lock, setLock] = useState<LockSetting>(access?.lock ?? { mode: 'auto' })
  const [visibility, setVisibility] = useState<Record<string, Visibility>>(
    Object.fromEntries(
      object.columns.map((column) => [
        column.name,
        access?.exclusions.find((entry) => entry.column === column.name)?.scope ?? 'shown',
      ]),
    ),
  )
  // Exclusions of columns the read user no longer sees (its grants leave them out) stay.
  const hidden = (access?.exclusions ?? []).filter(
    (entry) => !object.columns.some((column) => column.name === entry.column),
  )
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['admin', 'connection', props.connectionId] })
  const body = () => ({
    ops,
    keyColumn: keyColumn === '' ? null : keyColumn,
    displayTemplate: template.trim() === '' ? null : template,
    apiResource: resource.trim() === '' ? null : resource,
    mcpEnabled: mcp,
    ...(!isView && { lock }),
    exclusions: [
      ...Object.entries(visibility)
        .filter(([, scope]) => scope !== 'shown')
        .map(([column, scope]) => ({ column, scope: scope as ExclusionScope })),
      ...hidden,
    ],
  })
  // A change that takes API endpoints or grants away is confirmed first (E15).
  const save = useMutation({
    mutationFn: (confirm: boolean) =>
      access === undefined
        ? api('POST', '/internal/admin/table-access', {
            connectionId: props.connectionId,
            objectName: object.name,
            ...body(),
          })
        : api('PUT', `/internal/admin/table-access/${access.id}`, {
            ...body(),
            ...(confirm && { confirm: true }),
          }),
    onSuccess: async () => {
      await refresh()
      props.onClose()
    },
  })
  const remove = useMutation({
    mutationFn: (confirm: boolean) =>
      api(
        'DELETE',
        `/internal/admin/table-access/${access?.id ?? ''}${confirm ? '?confirm=true' : ''}`,
      ),
    onSuccess: async () => {
      await refresh()
      props.onClose()
    },
  })
  const error = save.error ?? remove.error
  const saveConsequences = consequencesOf(save.error)
  const removeConsequences = consequencesOf(remove.error)
  const exclusionError = object.columns
    .map((_column, index) => errors.field(save.error, `exclusions.${String(index)}.column`))
    .find((message) => message !== undefined)
  const visibilityOptions = (isKey: boolean) => [
    { id: 'shown' as const, label: t('access.column.shown') },
    ...(isKey ? [] : [{ id: 'all' as const, label: t('access.column.hidden') }]),
    { id: 'mcp' as const, label: t('access.column.hiddenMcp') },
  ]

  return (
    <Dialog title={object.name} isOpen isWide onOpenChange={(open) => !open && props.onClose()}>
      <Form onSubmit={() => save.mutate(false)}>
        {saveConsequences !== undefined ? (
          <ConsequencesNotice
            consequences={saveConsequences}
            onConfirm={() => save.mutate(true)}
            onCancel={() => save.reset()}
            isPending={save.isPending}
          />
        ) : removeConsequences !== undefined ? (
          <ConsequencesNotice
            consequences={removeConsequences}
            onConfirm={() => remove.mutate(true)}
            onCancel={() => remove.reset()}
            isPending={remove.isPending}
          />
        ) : (
          error !== null &&
          errors.message(error) !== undefined && (
            <Notice tone="error">{errors.message(error)}</Notice>
          )
        )}
        {access !== undefined && <AccessWarnings warnings={access.warnings} />}
        <fieldset className={styles.block}>
          <legend className={styles.blockTitle}>{t('access.ceiling')}</legend>
          <p className={styles.muted}>
            {isView ? t('access.ceiling.view') : t('access.ceiling.hint')}
          </p>
          <div className={styles.checks}>
            {tableOps.map((op) => (
              <CheckboxField
                key={op}
                label={t(opLabels[op])}
                isSelected={ops.includes(op)}
                isDisabled={isView}
                onChange={(selected) =>
                  setOps((current) =>
                    tableOps.filter((entry) => (entry === op ? selected : current.includes(entry))),
                  )
                }
              />
            ))}
          </div>
          {errors.field(save.error, 'ops') !== undefined && (
            <p className={styles.danger}>{errors.field(save.error, 'ops')}</p>
          )}
        </fieldset>
        {isView ? (
          <SelectField
            label={t('access.keyColumn')}
            value={keyColumn}
            onChange={setKeyColumn}
            error={errors.field(save.error, 'keyColumn')}
            options={[
              { id: '', label: t('access.keyColumn.none') },
              ...object.columns.map((column) => ({
                id: column.name,
                label: object.keyCandidates?.includes(column.name)
                  ? t('access.keyColumn.suggested', { column: column.name })
                  : column.name,
              })),
            ]}
          />
        ) : (
          <TextField
            label={t('access.keyColumn')}
            value={keyColumn}
            onChange={() => undefined}
            description={t('access.keyColumn.primary')}
            isReadOnly
          />
        )}
        <TextField
          label={t('access.template')}
          value={template}
          onChange={setTemplate}
          description={t('access.template.hint', {
            example: access?.effectiveTemplate ?? defaultTemplate,
          })}
          error={errors.field(save.error, 'displayTemplate')}
        />
        <div className={styles.grid}>
          <TextField
            label={t('access.apiResource')}
            value={resource}
            onChange={setResource}
            description={t('access.apiResource.hint')}
            error={errors.field(save.error, 'apiResource')}
          />
          <SwitchField
            label={t('access.mcp')}
            description={t('access.mcp.hint')}
            isSelected={mcp}
            onChange={setMcp}
          />
        </div>
        {!isView && (
          <SelectField
            label={t('access.lock')}
            value={lock.mode === 'column' ? `column:${lock.column}` : lock.mode}
            onChange={(value) =>
              setLock(
                value.startsWith('column:')
                  ? { mode: 'column', column: value.slice('column:'.length) }
                  : { mode: value === 'none' ? 'none' : 'auto' },
              )
            }
            description={
              access === undefined
                ? t('access.lock.hint')
                : access.lockStrategy.kind === 'values'
                  ? t('access.lock.values')
                  : t('access.lock.current', { column: access.lockStrategy.column })
            }
            error={errors.field(save.error, 'lock.column') ?? errors.field(save.error, 'lock')}
            options={[
              { id: 'auto', label: t('access.lock.auto') },
              { id: 'none', label: t('access.lock.none') },
              ...object.columns
                .filter((column) =>
                  ['integer', 'bigint', 'datetime', 'timestamp'].includes(column.kind),
                )
                .map((column) => ({ id: `column:${column.name}`, label: column.name })),
            ]}
          />
        )}
        <div className={styles.block}>
          <p className={styles.blockTitle}>{t('access.columns')}</p>
          <p className={styles.muted}>{t('access.columns.hint')}</p>
          {hidden.length > 0 && (
            <p className={styles.muted}>
              {t('access.columns.hidden', {
                columns: hidden.map((entry) => entry.column).join(', '),
              })}
            </p>
          )}
          {exclusionError !== undefined && <p className={styles.danger}>{exclusionError}</p>}
          <div className={`${table.wrap} ${styles.columns}`}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th>{t('access.column')}</th>
                  <th>{t('access.columnType')}</th>
                  <th>{t('access.visibility')}</th>
                </tr>
              </thead>
              <tbody>
                {object.columns.map((column) => (
                  <tr key={column.name}>
                    <td className={table.mono}>{column.name}</td>
                    <td className={table.muted}>{column.columnType}</td>
                    <td>
                      <SelectField
                        label={t('access.visibility.of', { column: column.name })}
                        value={visibility[column.name] ?? 'shown'}
                        onChange={(scope) =>
                          setVisibility((current) => ({ ...current, [column.name]: scope }))
                        }
                        options={visibilityOptions(column.name === keyColumn)}
                        isLabelHidden
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <Actions>
          {access !== undefined && (
            <Button
              variant="danger"
              onPress={() => remove.mutate(false)}
              isDisabled={remove.isPending}
            >
              {t('access.unshare')}
            </Button>
          )}
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {access === undefined ? t('access.share') : t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}
