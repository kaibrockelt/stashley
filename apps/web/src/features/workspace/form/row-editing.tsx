// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError, RenderComponent, RenderField, RowWriteResult } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError } from '../../../api/client.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Actions, Button, Dialog, Form, Notice } from '../../../ui/controls.tsx'
import { modeFields, usePageContext, type PageContextValue } from '../page-context.tsx'
import { FieldInput } from './field-input.tsx'
import { inputsOf, useFormat, visibleFields } from './form-block.tsx'
import styles from './form.module.css'
import { useWriteErrors } from './write-errors.ts'
import { buildPayload, initialValues, type InputValue } from './values.ts'

/**
 * Editing rows of a table with a table source (§ Tabellenseiten, E11): inline per cell, in a
 * dialog, and deleting with confirmation. Every change carries the row's version token; the
 * server decides what is allowed.
 */

const keyText = (key: unknown) =>
  typeof key === 'string' || typeof key === 'number' ? String(key) : JSON.stringify(key)

function rowsUrl(context: PageContextValue, componentId: string): string {
  return `/internal/pages/${context.page.id}/components/${componentId}/rows`
}

function editQuery(context: PageContextValue): string {
  const query = new URLSearchParams({
    ...(context.mode !== 'runtime' && { mode: context.mode }),
    ...(context.roles.length > 0 && { roles: context.roles.join(',') }),
  })
  return query.size === 0 ? '' : `?${query}`
}

/** Reloads the page's tables and counts after a change (§12). */
function useRefreshPage() {
  const client = useQueryClient()
  const context = usePageContext()
  return async () => {
    await client.invalidateQueries({ queryKey: ['workspace', 'component', context.page.id] })
    await client.invalidateQueries({ queryKey: ['workspace', 'count', context.page.id] })
  }
}

/**
 * One cell edited in place: the current value and version are loaded when editing starts,
 * Enter or leaving the field saves it, Escape discards (E11).
 */
export function InlineCell(props: {
  component: RenderComponent
  field: RenderField
  rowKey: unknown
  text: string
}) {
  const t = useT()
  const context = usePageContext()
  const format = useFormat()
  const errors = useWriteErrors()
  const refresh = useRefreshPage()
  const [editing, setEditing] = useState<{
    value: InputValue
    loaded: InputValue
    version: string
  } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const base = `${rowsUrl(context, props.component.id)}/${encodeURIComponent(keyText(props.rowKey))}`
  const field = props.field

  const start = useMutation({
    mutationFn: () => api<RowWriteResult>('GET', `${base}/edit${editQuery(context)}`),
    onSuccess: (row) => {
      const value = inputsOf([field], row.values ?? {}, format)[field.column] ?? null
      setEditing({ value, loaded: value, version: row.version ?? '' })
      setProblem(null)
    },
    onError: (error) => setProblem(errors.message(error) ?? t('error.title')),
  })
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api<RowWriteResult>('PATCH', base, {
        ...modeFields(context),
        values,
        version: editing?.version,
        filters: context.filters,
        params: context.params,
      }),
    onSuccess: async () => {
      setEditing(null)
      await refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setEditing(null)
        setProblem(t('form.conflict'))
        void refresh()
        return
      }
      const fieldError =
        error instanceof ApiError
          ? error.errors.find((entry) => entry.field === field.column)
          : undefined
      setProblem(
        fieldError === undefined
          ? (errors.message(error) ?? t('error.title'))
          : errors.field(fieldError),
      )
    },
  })
  const commit = () => {
    if (editing === null || save.isPending) return
    if (JSON.stringify(editing.value) === JSON.stringify(editing.loaded)) {
      setEditing(null)
      return
    }
    const payload = buildPayload([field], { [field.column]: editing.value }, 'update', format, {
      [field.column]: editing.loaded,
    })
    if (payload.errors.length > 0) {
      setProblem(errors.field(payload.errors[0]))
      return
    }
    save.mutate(payload.values)
  }

  if (editing === null) {
    return (
      <span className={styles.cell}>
        <button
          type="button"
          className={styles.cellButton}
          onClick={() => start.mutate()}
          aria-label={t('table.editCell', {
            column: field.label ?? field.column,
            value: props.text,
          })}
        >
          {props.text}
        </button>
        {problem !== null && (
          <span role="alert" className={styles.cellError}>
            {problem}
          </span>
        )}
      </span>
    )
  }
  return (
    <span
      className={styles.cellEditor}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          setEditing(null)
          setProblem(null)
        } else if (
          event.key === 'Enter' &&
          field.widget !== 'textarea' &&
          field.widget !== 'reference'
        ) {
          event.preventDefault()
          commit()
        }
      }}
      onBlur={(event) => {
        // Leaving the editor (not moving within it, e.g. into a list of options) saves.
        if (!event.currentTarget.contains(event.relatedTarget)) commit()
      }}
    >
      <FieldInput
        field={field}
        label={field.label ?? field.column}
        value={editing.value}
        onChange={(value) =>
          setEditing((current) => (current === null ? null : { ...current, value }))
        }
        error={problem ?? undefined}
        componentId={props.component.id}
        autoFocus
      />
    </span>
  )
}

/** Creates a row or edits one in a dialog, with every field of the table's editing. */
export function RowDialog(props: {
  component: RenderComponent
  rowKey?: unknown
  onClose: () => void
}) {
  const t = useT()
  const context = usePageContext()
  const format = useFormat()
  const errorText = useWriteErrors()
  const refresh = useRefreshPage()
  const fields = props.component.table?.editing?.fields ?? []
  const editing = props.rowKey !== undefined
  const [inputs, setInputs] = useState<Record<string, InputValue>>(() =>
    initialValues(
      fields,
      { filters: context.filters, params: context.params, now: Date.now() },
      format,
    ),
  )
  const [loaded, setLoaded] = useState<{
    inputs: Record<string, InputValue>
    version: string
  } | null>(null)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const base = rowsUrl(context, props.component.id)
  const url = editing ? `${base}/${encodeURIComponent(keyText(props.rowKey))}` : base

  const load = useQuery({
    queryKey: [
      'workspace',
      'record',
      context.page.id,
      props.component.id,
      keyText(props.rowKey),
      'dialog',
    ],
    queryFn: async () => {
      const row = await api<RowWriteResult>('GET', `${url}/edit${editQuery(context)}`)
      const values = inputsOf(fields, row.values ?? {}, format)
      setInputs(values)
      setLoaded({ inputs: values, version: row.version ?? '' })
      return row
    },
    enabled: editing,
    retry: false,
    gcTime: 0,
  })

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api<RowWriteResult>(editing ? 'PATCH' : 'POST', url, {
        ...modeFields(context),
        values,
        ...(editing && { version: loaded?.version }),
        filters: context.filters,
        params: context.params,
      }),
    onSuccess: async (result) => {
      await refresh()
      if (result.simulated === true) {
        setMessage(t('form.simulated'))
        return
      }
      props.onClose()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setMessage(t('form.conflict'))
        setLoaded(null)
        void load.refetch()
        return
      }
      if (error instanceof ApiError) setErrors(error.errors.filter((entry) => entry.field !== '_'))
      setMessage(errorText.message(error) ?? null)
    },
  })
  const operation = editing ? 'update' : 'create'
  const submit = () => {
    setMessage(null)
    const payload = buildPayload(fields, inputs, operation, format, loaded?.inputs)
    if (payload.errors.length > 0) setErrors(payload.errors)
    else save.mutate(payload.values)
  }
  return (
    <Dialog
      title={editing ? t('table.editRow') : t('table.newRow')}
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={submit} className={styles.form}>
        {message !== null && <Notice tone="error">{message}</Notice>}
        {load.isError && <Notice tone="error">{errorText.message(load.error)}</Notice>}
        {visibleFields(fields)
          .filter((field) => (operation === 'create' ? field.create : true))
          .map((field, index) => {
            const error = errors.find((entry) => entry.field === field.column)
            return (
              <FieldInput
                key={field.id}
                field={field}
                label={field.label ?? field.column}
                value={inputs[field.column] ?? null}
                onChange={(value) =>
                  setInputs((current) => ({ ...current, [field.column]: value }))
                }
                error={error === undefined ? undefined : errorText.field(error)}
                componentId={props.component.id}
                isReadOnly={operation === 'update' && !field.update}
                autoFocus={index === 0}
              />
            )
          })}
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={save.isPending || (editing && loaded === null)}
          >
            {t('form.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

/** Deletes one row after confirmation; cascades follow the database's rules (E13). */
export function DeleteDialog(props: {
  component: RenderComponent
  rowKey: unknown
  label: string
  onClose: () => void
}) {
  const t = useT()
  const context = usePageContext()
  const errorText = useWriteErrors()
  const refresh = useRefreshPage()
  const remove = useMutation({
    mutationFn: () =>
      api<RowWriteResult>(
        'DELETE',
        `${rowsUrl(context, props.component.id)}/${encodeURIComponent(keyText(props.rowKey))}`,
        modeFields(context),
      ),
    onSuccess: async () => {
      await refresh()
      props.onClose()
    },
  })
  return (
    <Dialog title={t('table.deleteRow')} isOpen onOpenChange={(open) => !open && props.onClose()}>
      {remove.error !== null && <Notice tone="error">{errorText.message(remove.error)}</Notice>}
      <p>{t('table.deleteConfirm', { row: props.label })}</p>
      <Actions>
        <Button onPress={props.onClose}>{t('action.cancel')}</Button>
        <Button variant="danger" onPress={() => remove.mutate()} isDisabled={remove.isPending}>
          {t('table.delete')}
        </Button>
      </Actions>
    </Dialog>
  )
}
