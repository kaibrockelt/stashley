// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FilterOptions, RenderPage } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { ComboBox, Input, Label, ListBox, ListBoxItem, Popover } from 'react-aria-components'
import { api } from '../../api/client.ts'
import { useT } from '../../i18n/use-t.ts'
import { Button } from '../../ui/controls.tsx'
import controls from '../../ui/controls.module.css'
import { modeFields, usePageContext } from './page-context.tsx'
import styles from './workspace.module.css'

type Filter = RenderPage['filters'][number]

function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

function TextFilter(props: { filter: Filter; value: unknown; onChange: (value: unknown) => void }) {
  const id = useId()
  const [text, setText] = useState(typeof props.value === 'string' ? props.value : '')
  const debounced = useDebounced(text)
  const { onChange, value } = props
  useEffect(() => {
    if (debounced !== (typeof value === 'string' ? value : ''))
      onChange(debounced === '' ? undefined : debounced)
  }, [debounced, onChange, value])
  return (
    <div className={styles.filter}>
      <label htmlFor={id}>{props.filter.label}</label>
      <input
        id={id}
        className={styles.nativeInput}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  )
}

function DateFilter(props: { filter: Filter; value: unknown; onChange: (value: unknown) => void }) {
  const t = useT()
  const id = useId()
  const filter = props.filter
  if (filter.kind === 'date' && filter.range) {
    const range = (typeof props.value === 'object' && props.value !== null ? props.value : {}) as {
      from?: string
      to?: string
    }
    const set = (key: 'from' | 'to', value: string) => {
      const next = { ...range, [key]: value === '' ? undefined : value }
      props.onChange(next.from === undefined && next.to === undefined ? undefined : next)
    }
    return (
      <fieldset className={styles.filter}>
        <legend>{filter.label}</legend>
        <div className={styles.range}>
          <input
            aria-label={t('filter.from')}
            className={styles.nativeInput}
            type="date"
            value={range.from ?? ''}
            onChange={(event) => set('from', event.target.value)}
          />
          <span aria-hidden="true">–</span>
          <input
            aria-label={t('filter.to')}
            className={styles.nativeInput}
            type="date"
            value={range.to ?? ''}
            onChange={(event) => set('to', event.target.value)}
          />
        </div>
      </fieldset>
    )
  }
  return (
    <div className={styles.filter}>
      <label htmlFor={id}>{filter.label}</label>
      <input
        id={id}
        className={styles.nativeInput}
        type="date"
        value={typeof props.value === 'string' ? props.value : ''}
        onChange={(event) =>
          props.onChange(event.target.value === '' ? undefined : event.target.value)
        }
      />
    </div>
  )
}

/** Searchable like a foreign key list: from one character, server-side, paged (§13.6). */
function SelectFilter(props: {
  filter: Filter
  value: unknown
  onChange: (value: unknown) => void
}) {
  const t = useT()
  const context = usePageContext()
  const filter = props.filter
  const multiple = filter.kind === 'select' && filter.multiple
  const selected: unknown[] = multiple
    ? Array.isArray(props.value)
      ? props.value
      : []
    : props.value === undefined
      ? []
      : [props.value]
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const options = useQuery({
    queryKey: [
      'workspace',
      'filter-options',
      context.page.id,
      filter.id,
      context.mode,
      context.roles,
      debounced,
    ],
    queryFn: () =>
      api<FilterOptions>(
        'POST',
        `/internal/pages/${context.page.id}/filters/${filter.id}/options`,
        {
          ...modeFields(context),
          ...(debounced !== '' && { search: debounced }),
        },
      ),
  })
  const items = (options.data?.options ?? []).map((option) => ({
    id: JSON.stringify(option.value),
    value: option.value,
    label: option.label,
  }))
  const labelOf = (value: unknown) => labels[JSON.stringify(value)] ?? String(value)
  const choose = (key: string) => {
    const item = items.find((entry) => entry.id === key)
    if (item === undefined) return
    setLabels((current) => ({ ...current, [item.id]: item.label }))
    if (multiple) {
      if (!selected.some((value) => JSON.stringify(value) === key))
        props.onChange([...selected, item.value])
      setSearch('')
    } else {
      props.onChange(item.value)
      setSearch(item.label)
    }
  }
  return (
    <div className={styles.filter}>
      <ComboBox
        className={controls.field}
        inputValue={search}
        onInputChange={setSearch}
        onSelectionChange={(key) => {
          if (key !== null) choose(String(key))
        }}
        defaultFilter={() => true}
        allowsEmptyCollection
        menuTrigger="input"
      >
        <Label className={controls.label}>{filter.label}</Label>
        <Input
          className={controls.input}
          placeholder={
            multiple || selected.length === 0 ? t('filter.search') : labelOf(selected[0])
          }
        />
        <Popover className={controls.popover}>
          <ListBox
            className={controls.listbox}
            renderEmptyState={() => <p className={controls.description}>{t('filter.noOptions')}</p>}
          >
            {items.map((item) => (
              <ListBoxItem
                key={item.id}
                id={item.id}
                className={controls.option}
                textValue={item.label}
              >
                {item.label}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </ComboBox>
      {selected.length > 0 && (
        <div className={styles.range}>
          {multiple &&
            selected.map((value) => (
              <Button
                key={JSON.stringify(value)}
                variant="ghost"
                aria-label={t('filter.remove', { value: labelOf(value) })}
                onPress={() =>
                  props.onChange(
                    selected.filter((entry) => entry !== value).length === 0
                      ? undefined
                      : selected.filter((entry) => entry !== value),
                  )
                }
              >
                {labelOf(value)} ×
              </Button>
            ))}
          {!multiple && (
            <Button
              variant="ghost"
              onPress={() => {
                setSearch('')
                props.onChange(undefined)
              }}
            >
              {t('filter.clear')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The page filters; their values live in the URL as `f.<id>` (§13.6). */
export function PageFilters(props: { onChange: (id: string, value: unknown) => void }) {
  const t = useT()
  const context = usePageContext()
  if (context.page.filters.length === 0) return null
  return (
    <div className={styles.filters} role="group" aria-label={t('filter.label')}>
      {context.page.filters.map((filter) => {
        const value = context.filters[filter.id]
        const onChange = (next: unknown) => props.onChange(filter.id, next)
        if (filter.kind === 'text')
          return <TextFilter key={filter.id} filter={filter} value={value} onChange={onChange} />
        if (filter.kind === 'date')
          return <DateFilter key={filter.id} filter={filter} value={value} onChange={onChange} />
        return <SelectFilter key={filter.id} filter={filter} value={value} onChange={onChange} />
      })}
    </div>
  )
}
