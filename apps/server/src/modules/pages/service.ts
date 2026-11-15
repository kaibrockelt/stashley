// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PageDetail,
  PageDocument,
  PageIssue,
  PageSummary,
  PageVersionDetail,
  PageVersionSummary,
  navigationOrder,
  Query,
  Section,
  pageCreate,
  pageUpdate,
  sectionUpdate,
} from '@stashley/shared'
import { componentsOf, emptyPage, pageDocument } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, PagesTable } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'
import type { PageInput } from '../access/compile.ts'
import type { QueriesService } from '../queries/service.ts'
import type { VariablesService } from '../variables/service.ts'

/** Published versions kept per page (§ Navigation und Seiten). */
export const keptVersions = 20

/** Checks a document against the current configuration (§8.6). */
export type PageChecker = (input: PageInput) => Promise<PageIssue[]>

export interface PagesDeps {
  db: Kysely<Database>
  audit: AuditLog
  events: EventBus
  queries: QueriesService
  variables: VariablesService
  clock?: Clock
}

function parseDocument(text: string): PageDocument {
  return pageDocument.parse(JSON.parse(text))
}

/** Every query a document uses, with its position. */
function queryRefs(document: PageDocument) {
  const refs: { queryId: string; version?: number | undefined }[] = []
  for (const filter of document.filters) if (filter.kind === 'select') refs.push(filter.source)
  for (const { component } of componentsOf(document)) {
    if (component.type !== 'text' && component.source.kind === 'query') refs.push(component.source)
  }
  return refs
}

/**
 * Sections and pages with drafts and published versions (§13.2). The page editor (M5)
 * builds on this API; M4 needs it so that page and component rights can be enforced.
 */
export class PagesService {
  private readonly deps: PagesDeps
  private readonly clock: Clock
  private checker: PageChecker = () => Promise.resolve([])

  constructor(deps: PagesDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    deps.queries.setUsage((queryId) => this.queryUsage(queryId))
    deps.variables.addUsage((name) => this.variableUsage(name))
  }

  setChecker(checker: PageChecker): void {
    this.checker = checker
  }

  // Sections

  async sections(): Promise<Section[]> {
    return this.deps.db
      .selectFrom('sections')
      .select(['id', 'name', 'position'])
      .orderBy('position')
      .orderBy('name')
      .execute()
  }

  async createSection(actor: Actor, name: string): Promise<Section> {
    const last = await this.deps.db
      .selectFrom('sections')
      .select((eb) => eb.fn.max<number>('position').as('position'))
      .executeTakeFirst()
    const section = { id: uuidv7(), name, position: (last?.position ?? -1) + 1 }
    const now = this.clock()
    await this.deps.db
      .insertInto('sections')
      .values({ ...section, created_at: now, updated_at: now })
      .execute()
    await this.deps.audit.record(actor, {
      action: 'section.created',
      subject: { kind: 'section', id: section.id, label: name },
    })
    return section
  }

  async updateSection(
    actor: Actor,
    id: string,
    input: z.infer<typeof sectionUpdate>,
  ): Promise<Section> {
    const before = (await this.sections()).find((section) => section.id === id)
    if (before === undefined) throw new AppError('not_found')
    await this.deps.db
      .updateTable('sections')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.position !== undefined && { position: input.position }),
        updated_at: this.clock(),
      })
      .where('id', '=', id)
      .execute()
    const changes: Record<string, [unknown, unknown]> = {}
    if (input.name !== undefined && input.name !== before.name)
      changes.name = [before.name, input.name]
    if (input.position !== undefined && input.position !== before.position) {
      changes.position = [before.position, input.position]
    }
    if (Object.keys(changes).length > 0) {
      await this.deps.audit.record(actor, {
        action: 'section.updated',
        subject: { kind: 'section', id, label: input.name ?? before.name },
        changes,
      })
    }
    return {
      ...before,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.position !== undefined && { position: input.position }),
    }
  }

  async removeSection(actor: Actor, id: string): Promise<void> {
    const section = (await this.sections()).find((entry) => entry.id === id)
    if (section === undefined) throw new AppError('not_found')
    const used = await this.deps.db
      .selectFrom('pages')
      .select('id')
      .where('section_id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst()
    if (used !== undefined) throw new AppError('in_use')
    await this.deps.db.deleteFrom('sections').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'section.deleted',
      subject: { kind: 'section', id, label: section.name },
    })
  }

  // Pages

  private async row(id: string): Promise<PagesTable> {
    const row = await this.deps.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    return row
  }

  private summary(row: PagesTable): PageSummary {
    const draft = parseDocument(row.draft)
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      title: draft.title,
      sectionId: row.section_id,
      position: row.position,
      draftRevision: row.draft_revision,
      draftUpdatedAt: new Date(row.draft_updated_at).toISOString(),
      publishedVersion: row.published_version,
    }
  }

  private input(row: PagesTable, document: PageDocument, version: number | null): PageInput {
    return {
      pageId: row.id,
      slug: row.slug,
      sectionId: row.section_id,
      position: row.position,
      version,
      revision: row.draft_revision,
      document,
    }
  }

  async list(): Promise<PageSummary[]> {
    const rows = await this.deps.db
      .selectFrom('pages')
      .selectAll()
      .where('archived_at', 'is', null)
      .orderBy('position')
      .orderBy('slug')
      .execute()
    return rows.map((row) => this.summary(row))
  }

  async get(id: string): Promise<PageDetail> {
    const row = await this.row(id)
    const draft = parseDocument(row.draft)
    return {
      ...this.summary(row),
      draft,
      issues: await this.checker(this.input(row, draft, null)),
    }
  }

  private async ensureSlugFree(slug: string, id?: string): Promise<void> {
    let query = this.deps.db.selectFrom('pages').select('id').where('slug', '=', slug)
    if (id !== undefined) query = query.where('id', '!=', id)
    if ((await query.executeTakeFirst()) !== undefined) throw fieldError('slug', 'taken')
  }

  private async ensureSection(sectionId: string | null): Promise<void> {
    if (sectionId === null) return
    const section = await this.deps.db
      .selectFrom('sections')
      .select('id')
      .where('id', '=', sectionId)
      .executeTakeFirst()
    if (section === undefined) throw fieldError('sectionId', 'not_found')
  }

  async create(actor: Actor, input: z.infer<typeof pageCreate>): Promise<PageDetail> {
    await this.ensureSlugFree(input.slug)
    await this.ensureSection(input.sectionId)
    const last = await this.deps.db
      .selectFrom('pages')
      .select((eb) => eb.fn.max<number>('position').as('position'))
      .executeTakeFirst()
    const id = uuidv7()
    const now = this.clock()
    await this.deps.db
      .insertInto('pages')
      .values({
        id,
        section_id: input.sectionId,
        position: (last?.position ?? -1) + 1,
        kind: input.kind,
        slug: input.slug,
        draft: JSON.stringify(emptyPage(input.kind, input.title)),
        draft_revision: 1,
        draft_updated_by: actor.id,
        draft_updated_at: now,
        published_version: null,
        created_at: now,
        archived_at: null,
      })
      .execute()
    await this.deps.audit.record(actor, {
      action: 'page.created',
      subject: { kind: 'page', id, label: input.title },
      pageId: id,
      details: { kind: input.kind, slug: input.slug },
    })
    return this.get(id)
  }

  async update(actor: Actor, id: string, input: z.infer<typeof pageUpdate>): Promise<PageDetail> {
    const row = await this.row(id)
    if (input.slug !== undefined) await this.ensureSlugFree(input.slug, id)
    if (input.sectionId !== undefined) await this.ensureSection(input.sectionId)
    const changes: Record<string, [unknown, unknown]> = {}
    if (input.slug !== undefined && input.slug !== row.slug) changes.slug = [row.slug, input.slug]
    if (input.sectionId !== undefined && input.sectionId !== row.section_id) {
      changes.sectionId = [row.section_id, input.sectionId]
    }
    if (input.position !== undefined && input.position !== row.position) {
      changes.position = [row.position, input.position]
    }
    if (Object.keys(changes).length === 0) return this.get(id)
    await this.deps.db
      .updateTable('pages')
      .set({
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.sectionId !== undefined && { section_id: input.sectionId }),
        ...(input.position !== undefined && { position: input.position }),
      })
      .where('id', '=', id)
      .execute()
    await this.deps.audit.record(actor, {
      action: 'page.updated',
      subject: { kind: 'page', id, label: parseDocument(row.draft).title },
      pageId: id,
      changes,
    })
    this.deps.events.emit('page.changed', { pageId: id })
    return this.get(id)
  }

  private async rejectErrors(row: PagesTable, document: PageDocument): Promise<void> {
    const issues = await this.checker(this.input(row, document, null))
    const errors = issues.filter((issue) => issue.severity === 'error')
    if (errors.length > 0) {
      throw new AppError('validation_failed', {
        errors: errors.map((issue) => ({
          field: issue.path,
          code: issue.code,
          ...(issue.params !== undefined && { params: issue.params }),
        })),
      })
    }
  }

  /**
   * Saves the draft if `revision` is the current one; otherwise `409` with the current draft,
   * so nothing is overwritten silently (§13.2). Every save is audited (D11).
   */
  async saveDraft(
    actor: Actor,
    id: string,
    revision: number,
    document: PageDocument,
  ): Promise<PageDetail> {
    const row = await this.row(id)
    if (row.draft_revision !== revision) throw new DraftConflict(await this.get(id))
    if (document.kind !== row.kind) throw fieldError('kind', 'immutable')
    await this.rejectErrors(row, document)
    const result = await this.deps.db
      .updateTable('pages')
      .set({
        draft: JSON.stringify(document),
        draft_revision: revision + 1,
        draft_updated_by: actor.id,
        draft_updated_at: this.clock(),
      })
      .where('id', '=', id)
      .where('draft_revision', '=', revision)
      .executeTakeFirst()
    if (Number(result.numUpdatedRows) === 0) throw new DraftConflict(await this.get(id))
    await this.deps.audit.record(actor, {
      action: 'page.draft_saved',
      subject: { kind: 'page', id, label: document.title },
      pageId: id,
      details: { revision: revision + 1 },
    })
    this.deps.events.emit('page.changed', { pageId: id })
    return this.get(id)
  }

  /**
   * Publishes the draft (§13.2): validates it, pins the current version of every query it
   * uses, stores version n + 1 and keeps the last 20.
   */
  async publish(actor: Actor, id: string, revision?: number): Promise<PageDetail> {
    const row = await this.row(id)
    if (revision !== undefined && row.draft_revision !== revision) {
      throw new DraftConflict(await this.get(id))
    }
    const draft = parseDocument(row.draft)
    // Settings are checked against the result columns; learn the missing ones first.
    for (const ref of queryRefs(draft)) {
      const stored = await this.deps.queries.stored(ref.queryId)
      if (stored !== undefined && stored.resultColumns === null) {
        await this.deps.queries.describe(ref.queryId, stored.version)
      }
    }
    await this.rejectErrors(row, draft)
    const pinned = structuredClone(draft)
    for (const ref of queryRefs(pinned)) {
      const stored = await this.deps.queries.stored(ref.queryId)
      if (stored === undefined) throw fieldError('draft', 'query_missing')
      ref.version = stored.version
    }
    const version = (row.published_version ?? 0) + 1
    const now = this.clock()
    const raced = await writeTransaction(this.deps.db, async (trx) => {
      // Another publish since this one read the page would take the same version number.
      const latest = await trx
        .selectFrom('pages')
        .select('published_version')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      if (latest.published_version !== row.published_version) return true
      await trx
        .insertInto('page_versions')
        .values({
          page_id: id,
          version,
          document: JSON.stringify(pinned),
          source_revision: row.draft_revision,
          published_by: actor.id,
          published_at: now,
        })
        .execute()
      await trx
        .updateTable('pages')
        .set({ published_version: version })
        .where('id', '=', id)
        .execute()
      await trx
        .deleteFrom('page_versions')
        .where('page_id', '=', id)
        .where('version', '<=', version - keptVersions)
        .execute()
      return false
    })
    if (raced) throw new DraftConflict(await this.get(id))
    await this.deps.audit.record(actor, {
      action: 'page.published',
      subject: { kind: 'page', id, label: draft.title },
      pageId: id,
      details: { version, revision: row.draft_revision },
    })
    this.deps.events.emit('page.published', { pageId: id })
    return this.get(id)
  }

  /** The kept published versions, newest first (§13.2). */
  async versions(id: string): Promise<PageVersionSummary[]> {
    const row = await this.row(id)
    const versions = await this.deps.db
      .selectFrom('page_versions')
      .leftJoin('users', 'users.id', 'page_versions.published_by')
      .select([
        'page_versions.version',
        'page_versions.published_at',
        'page_versions.source_revision',
        'users.email',
      ])
      .where('page_versions.page_id', '=', id)
      .orderBy('page_versions.version', 'desc')
      .execute()
    return versions.map((entry) => ({
      version: entry.version,
      publishedAt: new Date(entry.published_at).toISOString(),
      publishedBy: entry.email ?? null,
      sourceRevision: entry.source_revision,
      current: entry.version === row.published_version,
    }))
  }

  async version(id: string, version: number): Promise<PageVersionDetail> {
    const summary = (await this.versions(id)).find((entry) => entry.version === version)
    if (summary === undefined) throw new AppError('not_found')
    const stored = await this.deps.db
      .selectFrom('page_versions')
      .select('document')
      .where('page_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirstOrThrow()
    return { ...summary, document: parseDocument(stored.document) }
  }

  /**
   * Copies a published version into the draft as a new revision (§13.2). It takes effect only
   * when the page is published again. Pinned query versions are dropped, so the draft uses
   * the current versions like any other draft.
   */
  async restore(actor: Actor, id: string, version: number, revision: number): Promise<PageDetail> {
    const { document } = await this.version(id, version)
    for (const ref of queryRefs(document)) delete ref.version
    const saved = await this.saveDraft(actor, id, revision, document)
    await this.deps.audit.record(actor, {
      action: 'page.restored',
      subject: { kind: 'page', id, label: document.title },
      pageId: id,
      details: { version, revision: saved.draftRevision },
    })
    return saved
  }

  /**
   * Sets the order of sections and pages at once, as the navigation editor shows them.
   * Every section and page must be listed exactly once.
   */
  async reorder(actor: Actor, order: z.infer<typeof navigationOrder>): Promise<void> {
    const sections = await this.sections()
    const pages = await this.deps.db
      .selectFrom('pages')
      .select(['id', 'section_id', 'position'])
      .where('archived_at', 'is', null)
      .execute()
    const sameSet = (a: string[], b: string[]) =>
      a.length === b.length && new Set(a).size === a.length && b.every((id) => a.includes(id))
    if (
      !sameSet(
        order.sections,
        sections.map((section) => section.id),
      )
    ) {
      throw fieldError('sections', 'incomplete')
    }
    if (
      !sameSet(
        order.pages.map((page) => page.id),
        pages.map((page) => page.id),
      )
    ) {
      throw fieldError('pages', 'incomplete')
    }
    const known = new Set(order.sections)
    order.pages.forEach((page, index) => {
      if (page.sectionId !== null && !known.has(page.sectionId)) {
        throw fieldError(`pages.${index}.sectionId`, 'not_found')
      }
    })
    const now = this.clock()
    await writeTransaction(this.deps.db, async (trx) => {
      for (const [position, sectionId] of order.sections.entries()) {
        await trx
          .updateTable('sections')
          .set({ position, updated_at: now })
          .where('id', '=', sectionId)
          .execute()
      }
      for (const [position, page] of order.pages.entries()) {
        await trx
          .updateTable('pages')
          .set({ position, section_id: page.sectionId })
          .where('id', '=', page.id)
          .execute()
      }
    })
    await this.deps.audit.record(actor, {
      action: 'navigation.reordered',
      subject: { kind: 'navigation', id: null, label: null },
      changes: {
        sections: [sections.map((section) => section.id), order.sections],
        pages: [
          pages
            .toSorted((a, b) => a.position - b.position)
            .map((page) => ({ id: page.id, sectionId: page.section_id })),
          order.pages,
        ],
      },
    })
    for (const page of order.pages) this.deps.events.emit('page.changed', { pageId: page.id })
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const row = await this.row(id)
    await this.deps.db
      .updateTable('pages')
      .set({ archived_at: this.clock() })
      .where('id', '=', id)
      .execute()
    await this.deps.db
      .updateTable('roles')
      .set({ home_page_id: null })
      .where('home_page_id', '=', id)
      .execute()
    await this.deps.audit.record(actor, {
      action: 'page.deleted',
      subject: { kind: 'page', id, label: parseDocument(row.draft).title },
      pageId: id,
    })
    this.deps.events.emit('page.published', { pageId: id })
  }

  /** Published pages with their documents, for navigation and access (§13.5). */
  async published(): Promise<{ row: PagesTable; document: PageDocument; version: number }[]> {
    const rows = await this.deps.db
      .selectFrom('pages')
      .innerJoin('page_versions', (join) =>
        join
          .onRef('page_versions.page_id', '=', 'pages.id')
          .onRef('page_versions.version', '=', 'pages.published_version'),
      )
      .selectAll('pages')
      .select('page_versions.document')
      .where('pages.archived_at', 'is', null)
      .orderBy('pages.position')
      .orderBy('pages.slug')
      .execute()
    return rows.map((row) => ({
      row,
      document: parseDocument(row.document),
      version: row.published_version as number,
    }))
  }

  /** A page by ID or slug, with its draft and published document. */
  async find(
    lookup: { id: string } | { slug: string },
  ): Promise<
    { row: PagesTable; draft: PageDocument; published: PageDocument | undefined } | undefined
  > {
    let query = this.deps.db.selectFrom('pages').selectAll().where('archived_at', 'is', null)
    query =
      'id' in lookup ? query.where('id', '=', lookup.id) : query.where('slug', '=', lookup.slug)
    const row = await query.executeTakeFirst()
    if (row === undefined) return undefined
    let published: PageDocument | undefined
    if (row.published_version !== null) {
      const version = await this.deps.db
        .selectFrom('page_versions')
        .select('document')
        .where('page_id', '=', row.id)
        .where('version', '=', row.published_version)
        .executeTakeFirst()
      if (version !== undefined) published = parseDocument(version.document)
    }
    return { row, draft: parseDocument(row.draft), published }
  }

  pageInput(row: PagesTable, document: PageDocument, version: number | null): PageInput {
    return this.input(row, document, version)
  }

  /** Pages whose draft or published version use a query (§10.1). */
  private async queryUsage(queryId: string): Promise<Query['usedBy']> {
    const needle = `%"queryId":"${queryId}"%`
    const drafts = await this.deps.db
      .selectFrom('pages')
      .select(['id', 'draft', 'published_version'])
      .where('archived_at', 'is', null)
      .where('draft', 'like', needle)
      .execute()
    const published = await this.deps.db
      .selectFrom('page_versions')
      .innerJoin('pages', (join) =>
        join
          .onRef('pages.id', '=', 'page_versions.page_id')
          .onRef('pages.published_version', '=', 'page_versions.version'),
      )
      .select(['pages.id', 'pages.draft', 'pages.published_version'])
      .where('pages.archived_at', 'is', null)
      .where('page_versions.document', 'like', needle)
      .execute()
    const pages = new Map<string, Query['usedBy'][number]>()
    for (const row of [...drafts, ...published]) {
      pages.set(row.id, {
        pageId: row.id,
        title: parseDocument(row.draft).title,
        publishedVersion: row.published_version,
      })
    }
    return [...pages.values()]
  }

  /** Whether a base filter of a draft or published page uses the variable. */
  private async variableUsage(name: string): Promise<boolean> {
    const needle = `%"kind":"variable","name":"${name}"%`
    const draft = await this.deps.db
      .selectFrom('pages')
      .select('id')
      .where('archived_at', 'is', null)
      .where('draft', 'like', needle)
      .executeTakeFirst()
    if (draft !== undefined) return true
    const published = await this.deps.db
      .selectFrom('page_versions')
      .innerJoin('pages', (join) =>
        join
          .onRef('pages.id', '=', 'page_versions.page_id')
          .onRef('pages.published_version', '=', 'page_versions.version'),
      )
      .select('pages.id')
      .where('pages.archived_at', 'is', null)
      .where('page_versions.document', 'like', needle)
      .executeTakeFirst()
    return published !== undefined
  }
}

/** The draft changed since the caller loaded it; carries the current one (§13.2). */
export class DraftConflict extends AppError {
  readonly current: PageDetail

  constructor(current: PageDetail) {
    super('conflict')
    this.current = current
  }
}
