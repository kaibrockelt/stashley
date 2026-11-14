// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Navigation,
  NavigationPage,
  OpMask,
  PageDocument,
  PageIssue,
  PageMode,
  PermissionEntry,
  RenderComponent,
  RenderPage,
  RowLayout,
  TableOp,
} from '@stashley/shared'
import {
  canView,
  componentOps,
  effectiveOps,
  hasOp,
  isDelivered,
  noOps,
  opBits,
  principalsOf,
  staticMask,
  toOps,
} from '@stashley/shared'
import type { PagesTable, SystemRole } from '../../metastore/schema.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import type { AuthContext } from '../auth/context.ts'
import type { PagesService } from '../pages/service.ts'
import type { QueriesService } from '../queries/service.ts'
import type { RolesService } from '../roles/service.ts'
import {
  compilePage,
  type CompiledComponent,
  type CompiledPage,
  type PageInput,
} from './compile.ts'
import type { AccessFacts } from './facts.ts'
import {
  grantComponent,
  grantFilter,
  type AuthorizedComponent,
  type AuthorizedFilter,
  type RequestUser,
} from './handles.ts'

export type { AuthorizedComponent, AuthorizedFilter, RequestUser } from './handles.ts'

/** Who is asking: the account, its system role and its roles, read for this request. */
export interface Viewer {
  user: RequestUser
  systemRole: SystemRole
  roleIds: string[]
}

export interface AccessDeps {
  facts: AccessFacts
  pages: PagesService
  queries: QueriesService
  roles: RolesService
  events: EventBus
}

const designers = new Set<SystemRole>(['admin', 'manager'])
const relayout: Record<number, RowLayout> = { 1: '12', 2: '6-6', 3: '4-4-4' }

/**
 * The only place that grants access to data (§8). Every data path passes through
 * `renderPage`, `authorizeComponent`, `authorizeFilter` or `authorizeDesign`.
 */
export class AccessService {
  private readonly deps: AccessDeps
  private readonly compiled = new Map<string, { generation: number; page: Promise<CompiledPage> }>()
  private generation = 0

  constructor(deps: AccessDeps) {
    this.deps = deps
    const bump = () => {
      this.generation++
    }
    for (const event of [
      'table-access.changed',
      'catalog.refreshed',
      'connection.changed',
      'query.changed',
      'roles.changed',
      'page.published',
      'page.changed',
    ] as const) {
      deps.events.on(event, bump)
    }
    deps.pages.setChecker((input) => this.check(input))
  }

  /** The viewer of a request; roles are read every time, so changes apply at once (§8.4). */
  async viewer(auth: AuthContext): Promise<Viewer> {
    return {
      user: { id: auth.user.id, email: auth.user.email },
      systemRole: auth.user.system_role,
      roleIds: await this.deps.roles.ofUser(auth.user.id),
    }
  }

  /** Design routes: only admins and managers (§ Systemrollen). */
  authorizeDesign(viewer: Viewer): void {
    if (!designers.has(viewer.systemRole)) throw new AppError('forbidden')
  }

  /** The configuration issues of a document, against the current state (§8.6). */
  async check(input: PageInput): Promise<PageIssue[]> {
    return (await compilePage(input, await this.compileDeps())).issues
  }

  private async compileDeps() {
    return {
      facts: this.deps.facts,
      queries: this.deps.queries,
      roleIds: await this.deps.roles.ids(),
    }
  }

  private async compile(input: PageInput): Promise<CompiledPage> {
    const key =
      input.version === null
        ? `${input.pageId}:draft:${input.revision}`
        : `${input.pageId}:${input.version}`
    const cached = this.compiled.get(key)
    const generation = this.generation + this.deps.facts.generation
    if (cached !== undefined && cached.generation === generation) return cached.page
    const page = this.compileDeps().then((deps) => compilePage(input, deps))
    page.catch(() => this.compiled.delete(key))
    this.compiled.set(key, { generation, page })
    if (this.compiled.size > 500) {
      const oldest = this.compiled.keys().next()
      if (oldest.done !== true) this.compiled.delete(oldest.value)
    }
    return page
  }

  /**
   * The page as the viewer may see it. Unknown pages, unpublished ones and pages the viewer
   * cannot see return 404, which leaves nothing to probe (D5). Edit and preview mode are
   * for designers and show the draft.
   */
  private async page(
    viewer: Viewer,
    lookup: { id: string } | { slug: string },
    mode: PageMode,
    previewRoles: readonly string[],
  ): Promise<{ page: CompiledPage; principals: string[]; visible: boolean }> {
    if (mode !== 'runtime' && !designers.has(viewer.systemRole)) throw new AppError('forbidden')
    const found = await this.deps.pages.find(lookup)
    if (found === undefined) throw new AppError('not_found')
    if (mode === 'runtime') {
      if (found.published === undefined || found.row.published_version === null) {
        throw new AppError('not_found')
      }
      const principals = principalsOf(viewer.roleIds)
      const visible = canView(found.published.access, principals)
      // Admins and managers see every published page; their data rights come from roles.
      if (!visible && !designers.has(viewer.systemRole)) throw new AppError('not_found')
      const page = await this.compile(
        this.deps.pages.pageInput(found.row, found.published, found.row.published_version),
      )
      return { page, principals, visible }
    }
    const page = await this.compile(this.deps.pages.pageInput(found.row, found.draft, null))
    const principals = mode === 'preview' ? principalsOf(previewRoles) : []
    return {
      page,
      principals,
      visible: mode === 'edit' || canView(page.document.access, principals),
    }
  }

  /** Effective operations of a component for these principals, or the edit-mode reads. */
  private ops(
    page: CompiledPage,
    component: CompiledComponent,
    mode: PageMode,
    principals: string[],
  ) {
    if (component.sourceKey === undefined) return noOps
    if (mode === 'edit') {
      // Designers see every component of the draft whose source is within the ceiling.
      return staticMask(component.limits) & opBits.read
    }
    return effectiveOps(
      {
        access: page.document.access,
        restrictions: component.restrictions,
        source: component.sourceKey,
        limits: component.limits,
      },
      principals,
    )
  }

  async renderPage(
    viewer: Viewer,
    slug: string,
    mode: PageMode,
    previewRoles: readonly string[] = [],
  ): Promise<RenderPage> {
    const { page, principals, visible } = await this.page(viewer, { slug }, mode, previewRoles)
    const document = page.document
    const render = (component: CompiledComponent): RenderComponent | undefined => {
      const ops = this.ops(page, component, mode, principals)
      const delivered = mode === 'edit' || (visible && isDelivered(component.kind, ops))
      if (!delivered) return undefined
      return this.renderComponent(page, component, ops, mode)
    }
    const rows: RenderPage['rows'] = []
    for (const row of document.rows) {
      const components = row.blocks.flatMap((block) => {
        const compiled = page.components.get(block.id)
        const rendered = compiled === undefined ? undefined : render(compiled)
        return rendered === undefined ? [] : [rendered]
      })
      if (components.length === 0) continue
      rows.push({
        id: row.id,
        // The remaining blocks of a row share its width (§13.4).
        layout:
          components.length === row.blocks.length
            ? row.layout
            : (relayout[components.length] ?? row.layout),
        components,
      })
    }
    const table = document.table === null ? undefined : page.components.get(document.table.id)
    return {
      id: page.pageId,
      slug: page.slug,
      kind: document.kind,
      title: document.title,
      ...(document.description !== undefined && { description: document.description }),
      mode,
      version: page.version,
      filters: document.filters.map((filter) =>
        filter.kind === 'select'
          ? {
              kind: 'select',
              id: filter.id,
              label: filter.label,
              multiple: filter.multiple,
              required: filter.required,
            }
          : filter,
      ),
      parameters: document.parameters.map((parameter) => ({ ...parameter })),
      rows,
      table: table === undefined ? null : (render(table) ?? null),
    }
  }

  private renderComponent(
    page: CompiledPage,
    component: CompiledComponent,
    ops: OpMask,
    mode: PageMode,
  ): RenderComponent {
    const block = component.block
    const source = component.source
    const out: RenderComponent = {
      id: block.id,
      type: block.type,
      title: block.title,
      ...(block.description !== undefined && { description: block.description }),
      ops: toOps(ops),
      sourceKind: block.type === 'text' ? null : block.source.kind,
    }
    if (block.type === 'text') out.markdown = block.markdown
    else if (block.settings !== undefined) out.settings = block.settings
    if (block.type === 'form') out.formMode = block.mode
    if (source?.kind === 'table' && source.model !== null) {
      out.table = {
        columns: source.model.columns.map((column) => ({
          id: column.id,
          label: column.label ?? null,
          kind: column.kind,
        })),
        pageSize: source.model.pageSize,
        searchable: source.model.searchColumns.length > 0,
        sort: source.model.sort,
      }
    }
    if (mode === 'edit') {
      out.readable = hasOp(ops, 'read')
      out.issues = page.issues.filter(
        (issue) => issue.path === component.path || issue.path.startsWith(`${component.path}.`),
      )
    }
    return out
  }

  /**
   * The handle for one operation on one component (§8.4). Invisible components return 404;
   * visible ones without the operation return 403 (D5).
   */
  async authorizeComponent(
    viewer: Viewer,
    pageId: string,
    componentId: string,
    op: TableOp,
    mode: PageMode,
    previewRoles: readonly string[] = [],
  ): Promise<AuthorizedComponent> {
    const { page, principals, visible } = await this.page(
      viewer,
      { id: pageId },
      mode,
      previewRoles,
    )
    const component = page.components.get(componentId)
    if (component === undefined || component.source === undefined) throw new AppError('not_found')
    const ops = this.ops(page, component, mode, principals)
    const delivered =
      mode === 'edit' ? hasOp(ops, 'read') : visible && isDelivered(component.kind, ops)
    if (!delivered) throw new AppError('not_found')
    if (!hasOp(ops, op)) throw new AppError('forbidden')
    return grantComponent({ page, component, mode, ops, user: viewer.user })
  }

  /** Options of a page filter use the page's view right (D12). */
  async authorizeFilter(
    viewer: Viewer,
    pageId: string,
    filterId: string,
    mode: PageMode,
    previewRoles: readonly string[] = [],
  ): Promise<AuthorizedFilter> {
    const { page, visible } = await this.page(viewer, { id: pageId }, mode, previewRoles)
    const filter = page.filters.get(filterId)
    if (filter?.source === undefined || !visible) throw new AppError('not_found')
    if (!hasOp(staticMask(filter.limits), 'read')) throw new AppError('forbidden')
    return grantFilter({ page, filter, mode, user: viewer.user })
  }

  /** Workspace navigation (§13.5): visible published pages, sections without them hidden. */
  async navigation(viewer: Viewer): Promise<Navigation> {
    const principals = principalsOf(viewer.roleIds)
    const designer = designers.has(viewer.systemRole)
    const published = await this.deps.pages.published()
    const visible = published.filter(
      (entry) => designer || canView(entry.document.access, principals),
    )
    const toPage = (entry: { row: PagesTable; document: PageDocument }): NavigationPage => ({
      id: entry.row.id,
      slug: entry.row.slug,
      title: entry.document.title,
      kind: entry.row.kind,
    })
    const sections = (await this.deps.pages.sections())
      .map((section) => ({
        id: section.id,
        name: section.name,
        pages: visible.filter((entry) => entry.row.section_id === section.id).map(toPage),
      }))
      .filter((section) => section.pages.length > 0)
    const loose = visible.filter((entry) => entry.row.section_id === null).map(toPage)
    const ordered = [...sections.flatMap((section) => section.pages), ...loose]
    const roles = new Set(viewer.roleIds)
    const homes = (await this.deps.roles.ordered()).filter((role) => roles.has(role.id))
    const home =
      homes
        .map((role) => ordered.find((entry) => entry.id === role.home_page_id))
        .find((entry) => entry !== undefined) ?? ordered[0]
    return { sections, pages: loose, home: home?.slug ?? null }
  }

  /** Issues of every page's draft and published version (§8.6). */
  async issues(): Promise<
    { pageId: string; title: string; draft: PageIssue[]; published: PageIssue[] }[]
  > {
    const out = []
    for (const summary of await this.deps.pages.list()) {
      const found = await this.deps.pages.find({ id: summary.id })
      if (found === undefined) continue
      const draft = await this.compile(this.deps.pages.pageInput(found.row, found.draft, null))
      const published =
        found.published === undefined || found.row.published_version === null
          ? undefined
          : await this.compile(
              this.deps.pages.pageInput(found.row, found.published, found.row.published_version),
            )
      out.push({
        pageId: summary.id,
        title: summary.title,
        draft: draft.issues,
        published: published?.issues ?? [],
      })
    }
    return out
  }

  /**
   * The permission overview (§8.7), derived with the same algebra over every published
   * page: per object, which principal may do what through which page and component.
   */
  async overview(
    filter: { object?: string; principal?: string; pageId?: string } = {},
  ): Promise<PermissionEntry[]> {
    const entries: PermissionEntry[] = []
    for (const { row, document, version } of await this.deps.pages.published()) {
      if (filter.pageId !== undefined && filter.pageId !== row.id) continue
      const page = await this.compile(this.deps.pages.pageInput(row, document, version))
      for (const component of page.components.values()) {
        const source = component.source
        if (source === undefined || component.sourceKey === undefined) continue
        const objects =
          source.kind === 'query'
            ? source.stored.analysis.objects
            : (source.model?.objects ?? [source.object.objectName])
        for (const principal of document.access.view) {
          if (filter.principal !== undefined && filter.principal !== principal) continue
          const ops =
            componentOps(document.access, component.restrictions, principal, component.sourceKey) &
            staticMask(component.limits)
          if (ops === noOps || !isDelivered(component.kind, ops)) continue
          for (const object of objects) {
            if (filter.object !== undefined && filter.object !== object) continue
            entries.push({
              connectionId: source.connection.connectionId,
              object,
              principal,
              pageId: row.id,
              pageTitle: document.title,
              componentId: component.id,
              ops: toOps(ops),
            })
          }
        }
      }
    }
    return entries
  }
}
