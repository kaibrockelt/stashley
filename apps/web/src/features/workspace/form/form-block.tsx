// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError, RenderComponent, RenderField, RowWriteResult } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useIntl } from 'react-intl'
import { api, ApiError } from '../../../api/client.ts'
import { useSession } from '../../../api/session.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Actions, Button, Form, Notice } from '../../../ui/controls.tsx'
import { useNavigation } from '../api.ts'
import { BlockFrame, BlockState } from '../blocks/block-frame.tsx'
import { modeFields, usePageContext } from '../page-context.tsx'
import { FieldInput } from './field-input.tsx'
import styles from './form.module.css'
import { useWriteErrors } from './write-errors.ts'
import {
  buildPayload,
  initialValues,
  toInput,
  type FormatContext,
  type InputValue,
} from './values.ts'

/** The record of a loaded row by column, from the values the server keyed by field ID. */
export function inputsOf(
  fields: readonly RenderField[],
  values: Readonly<Record<string, unknown>>,
  format: FormatContext,
): Record<string, InputValue> {
  return Object.fromEntries(
    fields.map((field) => [field.column, toInput(field, values[field.id] ?? null, format)]),
  )
}

/** Fields a user sees: hidden prefills and automatic keys are not shown. */
export function visibleFields(fields: readonly RenderField[]): RenderField[] {
  return fields.filter((field) => !field.hidden && field.generator?.kind !== 'auto_increment')
}

export function useFormat(): FormatContext {
  const intl = useIntl()
  const { instance } = useSession()
  return { locale: intl.locale, timeZone: instance.timeZone }
}

/** Slug of a page by ID, for "open a page after saving". */
function usePageSlug(pageId: string | undefined): string | undefined {
  const navigation = useNavigation()
  if (pageId === undefined) return undefined
  for (const section of navigation.data?.sections ?? []) {
    const page = section.pages.find((entry) => entry.id === pageId)
    if (page !== undefined) return page.slug
  }
  return navigation.data?.pages.find((entry) => entry.id === pageId)?.slug
}

/**
 * A form on one table (§ Formulare): create, edit or create-or-update. The client checks the
 * payload with the same row schema as the server; the server decides. Edit mode loads the
 * record named by a page filter or URL parameter, with its version token.
 */
export function FormBlock(props: { component: RenderComponent }) {
  const t = useT()
  const context = usePageContext()
  const client = useQueryClient()
  const navigate = useNavigate()
  const format = useFormat()
  const errorText = useWriteErrors()
  const component = props.component
  const form = component.form
  const mode = component.formMode ?? 'create'
  const fields = form?.fields ?? []
  const fresh = () =>
    initialValues(
      fields,
      { filters: context.filters, params: context.params, now: Date.now() },
      format,
    )
  const [inputs, setInputs] = useState<Record<string, InputValue>>(fresh)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'info'
    text: string
  } | null>(null)
  const [conflict, setConflict] = useState<RowWriteResult | null>(null)
  const [saved, setSaved] = useState<Record<string, InputValue> | null>(null)
  const targetSlug = usePageSlug(
    form?.afterSave.action === 'navigate' ? form.afterSave.pageId : undefined,
  )

  const record =
    form?.record === undefined
      ? undefined
      : form.record.kind === 'filter'
        ? context.filters[form.record.filterId]
        : context.params[form.record.name]
  const recordKey =
    typeof record === 'string' || typeof record === 'number'
      ? String(record) || undefined
      : undefined
  const base = `/internal/pages/${context.page.id}/components/${component.id}/rows`
  const loaded = useQuery({
    queryKey: [
      'workspace',
      'record',
      context.page.id,
      component.id,
      recordKey,
      context.mode,
      context.roles,
    ],
    queryFn: async () => {
      const query = new URLSearchParams({
        ...(context.mode !== 'runtime' && { mode: context.mode }),
        ...(context.roles.length > 0 && { roles: context.roles.join(',') }),
      })
      const row = await api<RowWriteResult>(
        'GET',
        `${base}/${encodeURIComponent(recordKey ?? '')}/edit?${query}`,
      )
      setInputs(inputsOf(fields, row.values ?? {}, format))
      setErrors([])
      setConflict(null)
      return row
    },
    enabled: mode === 'edit' && recordKey !== undefined,
    retry: false,
  })
  const loadedInputs =
    loaded.data === undefined ? undefined : inputsOf(fields, loaded.data.values ?? {}, format)

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      const body = {
        ...modeFields(context),
        values,
        filters: context.filters,
        params: context.params,
      }
      return mode === 'edit'
        ? api<RowWriteResult>('PATCH', `${base}/${encodeURIComponent(recordKey ?? '')}`, {
            ...body,
            version: loaded.data?.version,
          })
        : api<RowWriteResult>('POST', base, body)
    },
    onSuccess: async (result) => {
      setErrors([])
      setConflict(null)
      // Tables and charts of the page show the change at once (§12).
      await client.invalidateQueries({ queryKey: ['workspace', 'component', context.page.id] })
      await client.invalidateQueries({ queryKey: ['workspace', 'count', context.page.id] })
      if (result.simulated === true) {
        setMessage({ tone: 'info', text: t('form.simulated') })
        return
      }
      if (mode === 'edit') {
        await loaded.refetch()
        setMessage({
          tone: 'success',
          text: result.unchanged === true ? t('form.unchanged') : t('form.saved'),
        })
        return
      }
      const action = form?.afterSave
      if (action?.action === 'navigate' && targetSlug !== undefined) {
        void navigate({
          to: '/pages/$slug',
          params: { slug: targetSlug },
          search: { [action.parameter]: String(result.key) },
        })
        return
      }
      if (action?.action === 'show') setSaved(inputs)
      setInputs(fresh())
      setMessage({
        tone: 'success',
        text: result.created === false ? t('form.updated') : t('form.created'),
      })
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.code === 'version_conflict') {
          setConflict((error.body.current as RowWriteResult | undefined) ?? null)
          setMessage({ tone: 'error', text: t('form.conflict') })
          return
        }
        setErrors(error.errors.filter((entry) => entry.field !== '_'))
        const general = errorText.message(error)
        setMessage(general === undefined ? null : { tone: 'error', text: general })
        return
      }
      setMessage({ tone: 'error', text: t('error.title') })
    },
  })

  if (form === undefined) {
    return (
      <BlockFrame component={component}>
        <BlockState kind="unconfigured" />
      </BlockFrame>
    )
  }
  if (mode === 'edit' && recordKey === undefined) {
    return (
      <BlockFrame component={component}>
        <p className={styles.hint}>{t('form.noRecord')}</p>
      </BlockFrame>
    )
  }
  if (loaded.isError) {
    return (
      <BlockFrame component={component}>
        <BlockState kind="error" />
      </BlockFrame>
    )
  }

  const submit = () => {
    setMessage(null)
    const payload = buildPayload(
      fields,
      inputs,
      mode === 'edit' ? 'update' : 'create',
      format,
      loadedInputs,
    )
    if (payload.errors.length > 0) {
      setErrors(payload.errors)
      return
    }
    save.mutate(payload.values)
  }
  const fieldError = (field: RenderField) => {
    const error = errors.find((entry) => entry.field === field.column)
    return error === undefined ? undefined : errorText.field(error)
  }
  const shown = visibleFields(fields)
  const operation = mode === 'edit' ? 'update' : 'create'

  return (
    <BlockFrame component={component}>
      <Form onSubmit={submit} className={styles.form}>
        {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}
        {conflict !== null && (
          <div className={styles.conflict}>
            <p>{t('form.conflict.hint')}</p>
            <Button
              onPress={() => {
                setConflict(null)
                setMessage(null)
                void loaded.refetch()
              }}
            >
              {t('form.conflict.load')}
            </Button>
          </div>
        )}
        {shown.map((field, index) => {
          const label = field.label ?? field.column
          const writable = operation === 'create' ? field.create : field.update
          if (field.generator?.kind === 'date' && !field.generator.editable) {
            return (
              <p key={field.id} className={styles.generated}>
                <span>{label}</span>{' '}
                {t('form.generated', { expression: field.generator.expression })}
              </p>
            )
          }
          return (
            <FieldInput
              key={field.id}
              field={field}
              label={label}
              value={inputs[field.column] ?? null}
              onChange={(value) => {
                setInputs((current) => ({ ...current, [field.column]: value }))
                setErrors((current) => current.filter((entry) => entry.field !== field.column))
              }}
              error={fieldError(field)}
              componentId={component.id}
              isReadOnly={!writable}
              autoFocus={index === 0 && mode !== 'edit'}
            />
          )
        })}
        <Actions>
          {mode !== 'edit' && (
            <Button
              onPress={() => {
                setInputs(fresh())
                setErrors([])
                setMessage(null)
              }}
            >
              {t('form.clear')}
            </Button>
          )}
          <Button type="submit" variant="primary" isDisabled={save.isPending || loaded.isFetching}>
            {form.submitLabel ?? t('form.save')}
          </Button>
        </Actions>
        {saved !== null && (
          <dl className={styles.extras} aria-label={t('form.lastSaved')}>
            {shown.map((field) => (
              <div key={field.id}>
                <dt>{field.label ?? field.column}</dt>
                <dd>{formatSaved(saved[field.column])}</dd>
              </div>
            ))}
          </dl>
        )}
      </Form>
    </BlockFrame>
  )
}

function formatSaved(value: InputValue | undefined): string {
  if (value === null || value === undefined || value === '') return '–'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? '✓' : '–'
  return value
}
