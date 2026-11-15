// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Block, PageDetail, PageDocument, RenderComponent, RenderPage } from '@stashley/shared'
import { componentsOf } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { api, ApiError } from '../../api/client.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import { Actions, Badge, Button, Dialog, Notice, SelectField } from '../../ui/controls.tsx'
import { SortableList } from '../../ui/sortable.tsx'
import { StateView } from '../../ui/state.tsx'
import { designKeys, useQueries } from '../design/design-api.ts'
import { navigationKey } from '../workspace/api.ts'
import { Block as BlockView } from '../workspace/blocks/block.tsx'
import { layoutsFor, rowSpans } from '../workspace/grid-layout.ts'
import workspace from '../workspace/workspace.module.css'
import { BlockDialog, blockTypeLabels, unsetId } from './block-dialog.tsx'
import { ConflictDialog } from './conflict-dialog.tsx'
import {
  addBlock,
  addRow,
  moveBlock,
  newId,
  removeBlock,
  removeRow,
  reorderBlocks,
  reorderRows,
  replaceBlock,
  setRowLayout,
} from './document-ops.ts'
import styles from './editor.module.css'
import { IssueList, issuesAt } from './issues.tsx'
import { PageSettingsDialog } from './page-settings-dialog.tsx'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type Editing = { block: Block; isNew: boolean; rowId: string | null } | undefined

function newBlock(document: PageDocument): Block {
  return {
    id: newId(document, 'b'),
    type: 'chart',
    title: '',
    restrictions: [],
    source: { kind: 'query', queryId: unsetId },
    bindings: [],
  }
}

export function usePageDetail(id: string) {
  return useQuery({
    queryKey: designKeys.page(id),
    queryFn: () => api<PageDetail>('GET', `/internal/design/pages/${id}`),
  })
}

/** Lists the queries the draft uses; publishing pins their current versions (§10.1). */
function PublishDialog(props: {
  document: PageDocument
  onPublish: () => void
  onClose: () => void
  busy: boolean
  error: unknown
}) {
  const t = useT()
  const errors = useErrorText()
  const queries = useQueries()
  const ids = new Set<string>()
  for (const { component } of componentsOf(props.document)) {
    if (component.type !== 'text' && component.source.kind === 'query')
      ids.add(component.source.queryId)
  }
  for (const filter of props.document.filters)
    if (filter.kind === 'select') ids.add(filter.source.queryId)
  return (
    <Dialog
      title={t('editor.publish.title')}
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
    >
      {errors.message(props.error) !== undefined && (
        <Notice tone="error">{errors.message(props.error)}</Notice>
      )}
      <p>{t('editor.publish.text')}</p>
      {ids.size > 0 && (
        <ul>
          {[...ids].map((id) => {
            const query = queries.data?.find((entry) => entry.id === id)
            return (
              <li key={id}>
                {query === undefined
                  ? id
                  : t('editor.publish.query', { name: query.name, version: query.latestVersion })}
              </li>
            )
          })}
        </ul>
      )}
      <Actions>
        <Button onPress={props.onClose}>{t('action.cancel')}</Button>
        <Button variant="primary" onPress={props.onPublish} isDisabled={props.busy}>
          {t('editor.publish')}
        </Button>
      </Actions>
    </Dialog>
  )
}

/** One block in edit mode: tools, issues, and a live preview of the saved draft. */
function EditCard(props: {
  block: Block
  rendered: RenderComponent | undefined
  saved: Block | undefined
  issues: ReturnType<typeof issuesAt>
  handle: ReactNode
  rows: { id: string; label: string; full: boolean }[]
  rowId: string | null
  onEdit: () => void
  onRemove: () => void
  onMove: (target: string | null) => void
}) {
  const t = useT()
  const unchanged = props.saved !== undefined && same(props.saved, props.block)
  return (
    <div className={styles.editCard}>
      <div className={styles.editTools}>
        {props.handle}
        <Badge>{t(blockTypeLabels[props.block.type])}</Badge>
        <span className={styles.editTitle}>{props.block.title || t('editor.untitled')}</span>
        {!unchanged && <Badge tone="warning">{t('editor.unsaved')}</Badge>}
        {props.rowId !== null && (
          <SelectField
            label={t('editor.moveTo', { title: props.block.title || props.block.id })}
            isLabelHidden
            value={props.rowId}
            onChange={(target) => props.onMove(target === 'new' ? null : target)}
            options={[
              ...props.rows
                .filter((row) => row.id === props.rowId || !row.full)
                .map((row) => ({ id: row.id, label: row.label })),
              { id: 'new', label: t('editor.newRow') },
            ]}
          />
        )}
        <Button variant="ghost" onPress={props.onEdit}>
          {t('action.edit')}
        </Button>
        <Button
          variant="ghost"
          onPress={props.onRemove}
          aria-label={t('editor.removeBlock', { title: props.block.title || props.block.id })}
        >
          {t('action.delete')}
        </Button>
      </div>
      <IssueList issues={props.issues} />
      {unchanged && props.rendered !== undefined ? (
        <BlockView component={props.rendered} />
      ) : (
        <p className={styles.previewHint}>{t('editor.saveToPreview')}</p>
      )}
    </div>
  )
}

/**
 * The page editor (§ Oberfläche und Bereiche: pages are edited in place). The local draft is
 * saved explicitly (D11) against the loaded revision; a conflict opens the comparison (E2).
 * Previews show the saved draft in edit mode, with the ceiling as the limit (§8.5).
 */
export function PageEditor(props: { page: RenderPage; toolbar: ReactNode }) {
  const t = useT()
  const detail = usePageDetail(props.page.id)
  if (detail.isError) return <StateView title={t('error.title')} />
  if (detail.data === undefined) return <StateView title={t('block.loading')} mascot={false} />
  return (
    <EditorBody
      key={props.page.id}
      page={props.page}
      toolbar={props.toolbar}
      initial={detail.data}
    />
  )
}

function EditorBody(props: { page: RenderPage; toolbar: ReactNode; initial: PageDetail }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const detail = usePageDetail(props.page.id)
  const [document, setDocument] = useState<PageDocument>(props.initial.draft)
  const [revision, setRevision] = useState(props.initial.draftRevision)
  const [editing, setEditing] = useState<Editing>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [conflict, setConflict] = useState<PageDetail>()
  const [published, setPublished] = useState(false)

  const refreshAll = async (saved: PageDetail) => {
    client.setQueryData(designKeys.page(saved.id), saved)
    setRevision(saved.draftRevision)
    await client.invalidateQueries({ queryKey: ['workspace', 'page', props.page.slug] })
    await client.invalidateQueries({ queryKey: ['workspace', 'component', props.page.id] })
    await client.invalidateQueries({ queryKey: designKeys.pages })
    await client.invalidateQueries({ queryKey: navigationKey })
  }
  const save = useMutation({
    mutationFn: (input: { document: PageDocument; revision: number }) =>
      api<PageDetail>('PUT', `/internal/design/pages/${props.page.id}/draft`, input.document, {
        'if-match': `"${input.revision}"`,
      }),
    onSuccess: async (saved) => {
      setConflict(undefined)
      setDocument(saved.draft)
      await refreshAll(saved)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409)
        setConflict(error.body.current as PageDetail)
    },
  })
  const publish = useMutation({
    mutationFn: () =>
      api<PageDetail>('POST', `/internal/design/pages/${props.page.id}/publish`, undefined, {
        'if-match': `"${revision}"`,
      }),
    onSuccess: async (saved) => {
      setPublishing(false)
      setPublished(true)
      await refreshAll(saved)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPublishing(false)
        setConflict(error.body.current as PageDetail)
      }
    },
  })

  const saved = detail.data ?? props.initial
  const dirty = !same(saved.draft, document)
  const issues = saved.issues
  const renderedById = new Map<string, RenderComponent>()
  for (const row of props.page.rows)
    for (const component of row.components) renderedById.set(component.id, component)
  if (props.page.table !== null) renderedById.set(props.page.table.id, props.page.table)
  const savedById = new Map(
    componentsOf(saved.draft).map(({ component, path }) => [component.id, { component, path }]),
  )
  const rowLabels = document.rows.map((row, index) => ({
    id: row.id,
    label: t('editor.rowN', { n: index + 1 }),
    full: row.blocks.length >= 4,
  }))
  const pageIssues = issues.filter(
    (issue) => !issue.path.startsWith('rows.') && !issue.path.startsWith('table'),
  )

  const applyBlock = (block: Block, next: PageDocument) => {
    if (editing === undefined) return
    let result: PageDocument
    if (!editing.isNew) result = replaceBlock(next, block, editing.block.id)
    else if (next.kind === 'table') result = { ...next, table: block as PageDocument['table'] }
    else if (editing.rowId === null) result = addRow(next, block)
    else result = addBlock(next, editing.rowId, block)
    setDocument(result)
    setEditing(undefined)
  }
  const card = (block: Block, rowId: string | null, handle: ReactNode) => {
    const savedEntry = savedById.get(block.id)
    return (
      <EditCard
        block={block}
        rendered={renderedById.get(block.id)}
        saved={savedEntry?.component}
        issues={savedEntry === undefined ? [] : issuesAt(issues, savedEntry.path)}
        handle={handle}
        rows={rowLabels}
        rowId={rowId}
        onEdit={() => setEditing({ block, isNew: false, rowId })}
        onRemove={() =>
          setDocument(
            document.kind === 'table'
              ? { ...document, table: null }
              : removeBlock(document, block.id),
          )
        }
        onMove={(target) => setDocument(moveBlock(document, block.id, target))}
      />
    )
  }

  return (
    <div className={workspace.page}>
      <header className={workspace.header}>
        <div>
          <h1 className={workspace.title}>{document.title}</h1>
          <p className={workspace.description}>
            {t('editor.revision', { revision })} ·{' '}
            {saved.publishedVersion === null
              ? t('pages.state.draft')
              : t('pages.state.published', { version: saved.publishedVersion })}
          </p>
        </div>
        <div className={styles.toolbar} role="toolbar" aria-label={t('editor.toolbar')}>
          <Button onPress={() => setSettingsOpen(true)}>{t('editor.pageSettings')}</Button>
          {props.toolbar}
          <Button isDisabled={!dirty} onPress={() => setDocument(saved.draft)}>
            {t('editor.discard')}
          </Button>
          <Button
            variant="primary"
            isDisabled={!dirty || save.isPending}
            onPress={() => save.mutate({ document, revision })}
          >
            {t('editor.save')}
          </Button>
          <Button
            isDisabled={dirty || issues.some((issue) => issue.severity === 'error')}
            onPress={() => setPublishing(true)}
          >
            {t('editor.publish')}
          </Button>
          <Button
            variant="ghost"
            isDisabled={dirty}
            onPress={() => void navigate({ to: '.', search: {} })}
          >
            {t('editor.done')}
          </Button>
        </div>
      </header>
      <div role="status">
        {dirty && <Notice tone="info">{t('editor.dirty')}</Notice>}
        {published && !dirty && <Notice tone="success">{t('editor.published')}</Notice>}
      </div>
      {save.error !== null && !(save.error instanceof ApiError && save.error.status === 409) && (
        <Notice tone="error">
          {errors.message(save.error) ?? t('error.generic')}
          {save.error instanceof ApiError && save.error.errors.length > 0 && (
            <ul className={styles.issues}>
              {save.error.errors.map((error, index) => (
                <li key={index}>
                  <code>{error.field}</code>: {error.code}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      <IssueList issues={pageIssues} />

      {document.kind === 'table' ? (
        document.table === null ? (
          <Button
            variant="primary"
            onPress={() =>
              setEditing({
                block: { ...newBlock(document), type: 'table', table: null } as Block,
                isNew: true,
                rowId: null,
              })
            }
          >
            {t('editor.addTable')}
          </Button>
        ) : (
          card(document.table, null, null)
        )
      ) : (
        <>
          <SortableList
            items={document.rows}
            label={(row) => rowLabels.find((entry) => entry.id === row.id)?.label ?? row.id}
            onReorder={(rows) =>
              setDocument(
                reorderRows(
                  document,
                  rows.map((row) => row.id),
                ),
              )
            }
          >
            {(row, handle) => {
              const spans = rowSpans(row.layout, row.blocks.length)
              const label = rowLabels.find((entry) => entry.id === row.id)?.label ?? row.id
              return (
                <section className={styles.editRow} aria-label={label}>
                  <div className={styles.editTools}>
                    {handle}
                    <strong>{label}</strong>
                    <SelectField
                      label={t('editor.layoutOf', { row: label })}
                      isLabelHidden
                      value={row.layout}
                      onChange={(layout) => setDocument(setRowLayout(document, row.id, layout))}
                      options={layoutsFor(row.blocks.length).map((id) => ({
                        id,
                        label: id.replaceAll('-', ' + '),
                      }))}
                    />
                    {row.blocks.length < 4 && (
                      <Button
                        variant="ghost"
                        onPress={() =>
                          setEditing({ block: newBlock(document), isNew: true, rowId: row.id })
                        }
                      >
                        {t('editor.addBlock')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onPress={() => setDocument(removeRow(document, row.id))}
                    >
                      {t('editor.removeRow')}
                    </Button>
                  </div>
                  <div className={workspace.row}>
                    <SortableList
                      items={row.blocks}
                      direction="horizontal"
                      className={styles.blockList}
                      label={(block) => block.title || block.id}
                      onReorder={(blocks) =>
                        setDocument(
                          reorderBlocks(
                            document,
                            row.id,
                            blocks.map((block) => block.id),
                          ),
                        )
                      }
                    >
                      {(block, blockHandle) => (
                        <div
                          className={styles.blockCell}
                          data-span={spans[row.blocks.indexOf(block)] ?? 12}
                        >
                          {card(block, row.id, blockHandle)}
                        </div>
                      )}
                    </SortableList>
                  </div>
                </section>
              )
            }}
          </SortableList>
          {document.rows.length < 100 && (
            <Button
              variant="primary"
              onPress={() => setEditing({ block: newBlock(document), isNew: true, rowId: null })}
            >
              {t('editor.addRow')}
            </Button>
          )}
        </>
      )}

      {editing !== undefined && (
        <BlockDialog
          document={document}
          block={editing.block}
          isNew={editing.isNew}
          onSave={applyBlock}
          onClose={() => setEditing(undefined)}
        />
      )}
      {settingsOpen && (
        <PageSettingsDialog
          document={document}
          onSave={(next) => {
            setDocument(next)
            setSettingsOpen(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {publishing && (
        <PublishDialog
          document={document}
          busy={publish.isPending}
          error={publish.error}
          onPublish={() => publish.mutate()}
          onClose={() => setPublishing(false)}
        />
      )}
      {conflict !== undefined && (
        <ConflictDialog
          current={conflict}
          mine={document}
          busy={save.isPending}
          onTakeCurrent={() => {
            setDocument(conflict.draft)
            client.setQueryData(designKeys.page(conflict.id), conflict)
            setRevision(conflict.draftRevision)
            setConflict(undefined)
          }}
          onKeepMine={() => save.mutate({ document, revision: conflict.draftRevision })}
          onClose={() => setConflict(undefined)}
        />
      )}
    </div>
  )
}
