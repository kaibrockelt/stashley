// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageDetail, PageSummary, Section } from '@stashley/shared'
import type { pageKinds } from '@stashley/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useFormatDateTime } from '../../../i18n/format.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Badge,
  Button,
  Dialog,
  Form,
  Notice,
  PageHeader,
  SelectField,
  TextField,
} from '../../../ui/controls.tsx'
import { SortableList } from '../../../ui/sortable.tsx'
import { StateView } from '../../../ui/state.tsx'
import { navigationKey } from '../../workspace/api.ts'
import { designKeys, usePages, useSections } from '../design-api.ts'
import styles from './pages.module.css'

const noSection = 'none'

/** A slug from a title: lower case, ASCII, words joined by hyphens. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

function NewPageDialog(props: { sections: Section[]; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [kind, setKind] = useState<(typeof pageKinds)[number]>('dashboard')
  const [sectionId, setSectionId] = useState<string>(props.sections[0]?.id ?? noSection)
  const create = useMutation({
    mutationFn: () =>
      api<PageDetail>('POST', '/internal/design/pages', {
        title,
        slug: slugTouched ? slug : slugify(title),
        kind,
        sectionId: sectionId === noSection ? null : sectionId,
      }),
    onSuccess: async (page) => {
      await client.invalidateQueries({ queryKey: designKeys.pages })
      props.onClose()
      void navigate({ to: '/pages/$slug', params: { slug: page.slug }, search: { mode: 'edit' } })
    },
  })
  return (
    <Dialog title={t('pages.new')} isOpen onOpenChange={(open) => !open && props.onClose()}>
      <Form onSubmit={() => create.mutate()}>
        {errors.message(create.error) !== undefined && (
          <Notice tone="error">{errors.message(create.error)}</Notice>
        )}
        <TextField
          label={t('field.title')}
          value={title}
          onChange={setTitle}
          error={errors.field(create.error, 'title')}
          autoFocus
          isRequired
        />
        <TextField
          label={t('pages.slug')}
          value={slugTouched ? slug : slugify(title)}
          onChange={(value) => {
            setSlugTouched(true)
            setSlug(value)
          }}
          description={t('pages.slugHint')}
          error={errors.field(create.error, 'slug')}
          isRequired
        />
        <SelectField
          label={t('pages.kind')}
          value={kind}
          onChange={setKind}
          options={[
            { id: 'dashboard', label: t('pages.kind.dashboard') },
            { id: 'table', label: t('pages.kind.table') },
          ]}
        />
        <SelectField
          label={t('pages.section')}
          value={sectionId}
          onChange={setSectionId}
          options={[
            ...props.sections.map((section) => ({ id: section.id, label: section.name })),
            { id: noSection, label: t('pages.noSection') },
          ]}
        />
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={create.isPending}>
            {t('pages.create')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

function SectionDialog(props: { section: Section | undefined; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const [name, setName] = useState(props.section?.name ?? '')
  const [confirming, setConfirming] = useState(false)
  const done = async () => {
    await client.invalidateQueries({ queryKey: designKeys.sections })
    await client.invalidateQueries({ queryKey: navigationKey })
    props.onClose()
  }
  const save = useMutation({
    mutationFn: () =>
      props.section === undefined
        ? api('POST', '/internal/design/sections', { name })
        : api('PATCH', `/internal/design/sections/${props.section.id}`, { name }),
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/design/sections/${props.section?.id ?? ''}`),
    onSuccess: done,
  })
  const error = save.error ?? remove.error
  return (
    <Dialog
      title={props.section?.name ?? t('pages.newSection')}
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => save.mutate()}>
        {errors.message(error) !== undefined && (
          <Notice tone="error">{errors.message(error)}</Notice>
        )}
        <TextField
          label={t('field.name')}
          value={name}
          onChange={setName}
          error={errors.field(save.error, 'name')}
          autoFocus
          isRequired
        />
        {confirming && <Notice tone="info">{t('pages.section.deleteConfirm')}</Notice>}
        <Actions>
          {props.section !== undefined &&
            (confirming ? (
              <Button
                variant="danger"
                onPress={() => remove.mutate()}
                isDisabled={remove.isPending}
              >
                {t('pages.section.delete')}
              </Button>
            ) : (
              <Button variant="ghost" onPress={() => setConfirming(true)}>
                {t('action.delete')}
              </Button>
            ))}
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

function DeletePageDialog(props: { page: PageSummary; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/design/pages/${props.page.id}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: designKeys.pages })
      await client.invalidateQueries({ queryKey: navigationKey })
      props.onClose()
    },
  })
  return (
    <Dialog
      title={t('pages.delete.title', { title: props.page.title })}
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
    >
      {errors.message(remove.error) !== undefined && (
        <Notice tone="error">{errors.message(remove.error)}</Notice>
      )}
      <p>{t('pages.delete.text')}</p>
      <Actions>
        <Button onPress={props.onClose}>{t('action.cancel')}</Button>
        <Button variant="danger" onPress={() => remove.mutate()} isDisabled={remove.isPending}>
          {t('pages.delete.confirm')}
        </Button>
      </Actions>
    </Dialog>
  )
}

function PageState(props: { page: PageSummary }) {
  const t = useT()
  const formatDate = useFormatDateTime()
  return (
    <span className={styles.meta}>
      {props.page.publishedVersion === null ? (
        <Badge tone="warning">{t('pages.state.draft')}</Badge>
      ) : (
        <Badge tone="success">
          {t('pages.state.published', { version: props.page.publishedVersion })}
        </Badge>
      )}
      <span>{t('pages.state.saved', { time: formatDate(props.page.draftUpdatedAt) })}</span>
    </span>
  )
}

/** Sections and pages of the navigation, in their order (§ Navigation und Seiten). */
export function PagesListPage() {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const sections = useSections()
  const pages = usePages()
  const [creating, setCreating] = useState(false)
  const [section, setSection] = useState<Section | 'new'>()
  const [deleting, setDeleting] = useState<PageSummary>()
  const reorder = useMutation({
    mutationFn: (order: { sections: Section[]; pages: PageSummary[] }) =>
      api('PUT', '/internal/design/navigation', {
        sections: order.sections.map((entry) => entry.id),
        pages: order.pages.map((entry) => ({ id: entry.id, sectionId: entry.sectionId })),
      }),
    onMutate: (order) => {
      client.setQueryData(designKeys.sections, order.sections)
      client.setQueryData(
        designKeys.pages,
        order.pages.map((page, position) => ({ ...page, position })),
      )
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: designKeys.sections })
      await client.invalidateQueries({ queryKey: designKeys.pages })
      await client.invalidateQueries({ queryKey: navigationKey })
    },
  })
  if (sections.data === undefined || pages.data === undefined)
    return <StateView title={t('block.loading')} mascot={false} />
  const allSections = sections.data
  const allPages = pages.data
  const groups = [
    ...allSections.map((entry) => ({ id: entry.id, name: entry.name, section: entry })),
    { id: noSection, name: t('pages.noSection'), section: undefined },
  ].map((group) => ({
    ...group,
    pages: allPages.filter((page) => (page.sectionId ?? noSection) === group.id),
  }))
  // The navigation order: sections in order, each with its pages, then pages without section.
  const flatten = (list: typeof groups) => list.flatMap((group) => group.pages)
  const save = (nextSections: Section[], nextPages: PageSummary[]) =>
    reorder.mutate({ sections: nextSections, pages: nextPages })
  const moveTo = (page: PageSummary, target: string) => {
    const sectionId = target === noSection ? null : target
    const without = groups.map((group) => ({
      ...group,
      pages: group.pages.filter((entry) => entry.id !== page.id),
    }))
    const next = without.map((group) =>
      group.id === target ? { ...group, pages: [...group.pages, { ...page, sectionId }] } : group,
    )
    save(allSections, flatten(next))
  }

  const pageRow = (page: PageSummary, handle: React.ReactNode) => (
    <div className={styles.pageRow}>
      {handle}
      <div className={styles.pageMain}>
        <Link
          to="/pages/$slug"
          params={{ slug: page.slug }}
          search={{ mode: 'edit' }}
          className={styles.pageTitle}
        >
          {page.title}
        </Link>
        <span className={styles.meta}>
          <code>/{page.slug}</code> ·{' '}
          {page.kind === 'table' ? t('pages.kind.table') : t('pages.kind.dashboard')}
        </span>
        <PageState page={page} />
      </div>
      <div className={styles.pageTools}>
        <SelectField
          label={t('pages.moveTo', { title: page.title })}
          isLabelHidden
          value={page.sectionId ?? noSection}
          onChange={(target) => moveTo(page, target)}
          options={groups.map((group) => ({ id: group.id, label: group.name }))}
        />
        <Button
          variant="ghost"
          onPress={() => setDeleting(page)}
          aria-label={t('pages.delete.title', { title: page.title })}
        >
          {t('action.delete')}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <PageHeader
        title={t('pages.title')}
        actions={
          <Actions>
            <Button onPress={() => setSection('new')}>{t('pages.newSection')}</Button>
            <Button variant="primary" onPress={() => setCreating(true)}>
              {t('pages.new')}
            </Button>
          </Actions>
        }
      />
      {errors.message(reorder.error) !== undefined && (
        <Notice tone="error">{errors.message(reorder.error)}</Notice>
      )}
      <p className={styles.intro}>{t('pages.intro')}</p>
      <SortableList
        items={allSections}
        label={(entry) => entry.name}
        onReorder={(next) => {
          const order = [
            ...next.map((entry) => groups.find((group) => group.id === entry.id)),
            groups.at(-1),
          ]
          save(next, flatten(order.filter((group) => group !== undefined)))
        }}
      >
        {(entry, handle) => {
          const group = groups.find((candidate) => candidate.id === entry.id)
          return (
            <section className={styles.group} aria-label={entry.name}>
              <div className={styles.groupHead}>
                {handle}
                <h2 className={styles.groupTitle}>{entry.name}</h2>
                <Button variant="ghost" onPress={() => setSection(entry)}>
                  {t('action.edit')}
                </Button>
              </div>
              <GroupPages
                pages={group?.pages ?? []}
                onReorder={(next) =>
                  save(
                    allSections,
                    flatten(
                      groups.map((candidate) =>
                        candidate.id === entry.id ? { ...candidate, pages: next } : candidate,
                      ),
                    ),
                  )
                }
                row={pageRow}
              />
            </section>
          )
        }}
      </SortableList>
      <section className={styles.group} aria-label={t('pages.noSection')}>
        <div className={styles.groupHead}>
          <h2 className={styles.groupTitle}>{t('pages.noSection')}</h2>
        </div>
        <GroupPages
          pages={groups.at(-1)?.pages ?? []}
          onReorder={(next) =>
            save(
              allSections,
              flatten(
                groups.map((candidate) =>
                  candidate.id === noSection ? { ...candidate, pages: next } : candidate,
                ),
              ),
            )
          }
          row={pageRow}
        />
      </section>
      {creating && <NewPageDialog sections={allSections} onClose={() => setCreating(false)} />}
      {section !== undefined && (
        <SectionDialog
          section={section === 'new' ? undefined : section}
          onClose={() => setSection(undefined)}
        />
      )}
      {deleting !== undefined && (
        <DeletePageDialog page={deleting} onClose={() => setDeleting(undefined)} />
      )}
    </>
  )
}

function GroupPages(props: {
  pages: PageSummary[]
  onReorder: (pages: PageSummary[]) => void
  row: (page: PageSummary, handle: React.ReactNode) => React.ReactNode
}) {
  const t = useT()
  if (props.pages.length === 0) return <p className={styles.meta}>{t('pages.groupEmpty')}</p>
  return (
    <SortableList items={props.pages} label={(page) => page.title} onReorder={props.onReorder}>
      {props.row}
    </SortableList>
  )
}
