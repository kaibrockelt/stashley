// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiOperation,
  ImpactItem,
  Navigation,
  NavigationPage,
  OpMask,
  PageDocument,
  PageIssue,
  PageMode,
  PermissionEntry,
  RenderComponent,
  RenderField,
  RenderPage,
  RowLayout,
  SchemaDiff,
  TableOp,
} from '@stashley/shared'
import {
  canView,
  componentOps,
  effectiveOps,
  hasOp,
  isDelivered,
  noOps,
  principalsOf,
  serverDefault,
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
import type { VariablesService } from '../variables/service.ts'
import {
  compilePage,
  type CompiledComponent,
  type CompiledPage,
  type CompileDeps,
  type PageInput,
} from './compile.ts'
import type { AccessFacts } from './facts.ts'
import type { WriteField, WriteModel } from './write-model.ts'
import {
  grantComponent,
  grantFilter,
  grantResource,
  type AuthorizedComponent,
  type AuthorizedFilter,
  type AuthorizedResource,
  type RequestUser,
} from './handles.ts'
import { buildResourceModel, type ResourceModel } from './resource.ts'

export type {
  AuthorizedComponent,
  AuthorizedFilter,
  AuthorizedResource,
  RequestUser,
} from './handles.ts'
export type { ResourceColumn, ResourceModel } from './resource.ts'

/** What a token brings to an API request (§16). */
export interface ResourceRequest {
  alias: string
  operation: ApiOperation
  token: { id: string; name: string; grants: ReadonlyMap<string, ReadonlySet<ApiOperation>> }
  /** The enabled endpoints of a table access. */
  enabled: (tableAccessId: string) => Promise<ReadonlySet<ApiOperation>>
}

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
  variables: VariablesService
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
  private readonly resources = new Map<
    string,
    { generation: number; model: Promise<ResourceModel | undefined> }
  >()
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
      'query.described',
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

  /** The resource model of a table access, rebuilt when access facts change (§16). */
  async resourceModel(tableAccessId: string): Promise<ResourceModel | undefined> {
    const generation = this.deps.facts.generation
    const cached = this.resources.get(tableAccessId)
    if (cached !== undefined && cached.generation === generation) return cached.model
    const model = this.deps.facts
      .table(tableAccessId)
      .then((found) =>
        found === undefined
          ? undefined
          : buildResourceModel(found.connection, found.object, found.object.apiResource),
      )
    model.catch(() => this.resources.delete(tableAccessId))
    this.resources.set(tableAccessId, { generation, model })
    return model
  }

  /** The table access behind an API resource name. */
  resourceId(alias: string): Promise<string | undefined> {
    return this.deps.facts.byResource(alias)
  }

  /**
   * Authorizes one operation of a token on an API resource (§16, D5): an unknown name, a
   * disabled endpoint or an object that cannot serve answers 404; an operation the token has
   * no grant for answers 403, and so does one the ceiling or the database grants rule out.
   */
  async authorizeResource(request: ResourceRequest): Promise<AuthorizedResource> {
    const id = await this.resourceId(request.alias)
    if (id === undefined) throw new AppError('not_found')
    const enabled = await request.enabled(id)
    if (!enabled.has(request.operation)) throw new AppError('not_found')
    const model = await this.resourceModel(id)
    if (model === undefined) throw new AppError('not_found')
    if (request.token.grants.get(id)?.has(request.operation) !== true) {
      throw new AppError('forbidden')
    }
    if (!model.available.includes(request.operation)) throw new AppError('forbidden')
    // Like forms without read (§8.2), a token that cannot read gets the key only.
    const granted = request.token.grants.get(id)
    const readable = (['get', 'list'] as const).some(
      (operation) =>
        granted?.has(operation) === true &&
        enabled.has(operation) &&
        model.available.includes(operation),
    )
    return grantResource({
      resource: model,
      operation: request.operation,
      token: { id: request.token.id, name: request.token.name },
      readable,
    })
  }

  /** Design routes: only admins and managers (§ Systemrollen). */
  authorizeDesign(viewer: Viewer): void {
    if (!designers.has(viewer.systemRole)) throw new AppError('forbidden')
  }

  /** The configuration issues of a document, against the current state (§8.6). */
  async check(input: PageInput): Promise<PageIssue[]> {
    return (await compilePage(input, await this.compileDeps())).issues
  }

  /**
   * The configuration issues of a document against facts, queries and roles the caller
   * supplies: the configuration import checks pages as they will be after it (§24).
   */
  async checkWith(input: PageInput, deps: CompileDeps): Promise<PageIssue[]> {
    return (await compilePage(input, deps)).issues
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
      // Designers see every component of the draft whose source is within the ceiling, and
      // writes are simulated against the ceiling (§11.2, D10).
      return staticMask(component.limits)
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
    const variables = await this.deps.variables.current()
    const context: RenderContext = {
      variable: (name) => variables.get(name)?.value,
      user: viewer.user,
    }
    // Page filters that feed a delivered component; the others would change nothing (0.1.1).
    const fed = new Set<string>()
    const render = (component: CompiledComponent): RenderComponent | undefined => {
      const ops = this.ops(page, component, mode, principals)
      const delivered = mode === 'edit' || (visible && isDelivered(component.kind, ops))
      if (!delivered) return undefined
      for (const id of filterInputs(component)) fed.add(id)
      return this.renderComponent(page, component, ops, mode, context)
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
    const rendered = table === undefined ? null : (render(table) ?? null)
    const detail = (document.detail?.tables ?? []).flatMap((entry) => {
      const compiled = page.components.get(entry.id)
      const out = compiled === undefined ? undefined : render(compiled)
      return out === undefined ? [] : [out]
    })
    // The editor manages every filter of the draft.
    const filters =
      mode === 'edit' ? document.filters : document.filters.filter((filter) => fed.has(filter.id))
    return {
      id: page.pageId,
      slug: page.slug,
      kind: document.kind,
      title: document.title,
      ...(document.description !== undefined && { description: document.description }),
      mode,
      version: page.version,
      filters: filters.map((filter) =>
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
      table: rendered,
      detail,
      ...(mode === 'preview' && { viewable: visible }),
    }
  }

  private renderComponent(
    page: CompiledPage,
    component: CompiledComponent,
    ops: OpMask,
    mode: PageMode,
    context: RenderContext,
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
    const write = source?.kind === 'table' ? source.write : null
    if (block.type === 'form') {
      out.formMode = block.mode
      if (write !== null) {
        out.form = {
          fields: renderFields(write, context),
          afterSave: block.afterSave,
          ...(block.submitLabel !== undefined && { submitLabel: block.submitLabel }),
          ...(block.mode === 'edit' && block.record !== null && { record: block.record.from }),
          keyColumn: write.keyColumn,
        }
      }
    } else if (source?.kind === 'table' && source.model !== null) {
      const editing = block.type === 'table' ? block.table?.editing : undefined
      const editOps = (editing?.ops ?? []).filter((op) => hasOp(ops, op))
      out.table = {
        columns: source.model.columns.map((column) => {
          // A column of the row itself that has an input field can be edited inline (E11).
          const field =
            editOps.includes('update') &&
            column.expr.type === 'column' &&
            column.expr.alias === 't0'
              ? write?.fields.find(
                  (entry) =>
                    entry.column === (column.expr as { column: string }).column &&
                    write.payload.update.some((spec) => spec.column === entry.column),
                )
              : undefined
          return {
            id: column.id,
            label: column.label ?? null,
            kind: column.kind,
            ...(field !== undefined && { field: field.id }),
          }
        }),
        pageSize: source.model.pageSize,
        searchable: source.model.searchColumns.length > 0,
        sort: source.model.sort,
        csvExport: block.type === 'table' && (block.table?.csvExport ?? false),
        keyKind: source.model.key.kind,
        ...(editing !== undefined &&
          editing !== null &&
          editOps.length > 0 && {
            editing: {
              ops: editOps,
              inline: editing.inline && editOps.includes('update'),
              dialog: editing.dialog,
              fields: write === null ? [] : renderFields(write, context),
            },
          }),
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
    /** The operation, or several of which one suffices (upserts create or update). */
    op: TableOp | readonly TableOp[],
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
    const delivered = mode === 'edit' ? ops !== noOps : visible && isDelivered(component.kind, ops)
    if (!delivered) throw new AppError('not_found')
    const wanted: readonly TableOp[] = typeof op === 'string' ? [op] : op
    if (!wanted.some((entry) => hasOp(ops, entry))) throw new AppError('forbidden')
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
   * Published components that read a removed or changed object or column, for the schema
   * impact report (§9.3).
   */
  async impact(connectionId: string, diff: SchemaDiff): Promise<ImpactItem[]> {
    const removed = new Set(diff.removedObjects)
    const items: ImpactItem[] = []
    for (const { row, document, version } of await this.deps.pages.published()) {
      const page = await this.compile(this.deps.pages.pageInput(row, document, version))
      for (const component of page.components.values()) {
        const source = component.source
        if (source?.connection.connectionId !== connectionId) continue
        const objects =
          source.kind === 'query'
            ? source.stored.analysis.objects
            : (source.model?.objects ?? [source.object.objectName])
        const columns =
          source.kind === 'query'
            ? source.stored.analysis.columns
            : (source.model?.columnsUsed ?? [])
        const stars = source.kind === 'query' ? source.stored.analysis.stars : []
        const used = (object: string, column: string) =>
          columns.some(
            (entry) =>
              entry.object === object && entry.column.toLowerCase() === column.toLowerCase(),
          )
        let reason: ImpactItem['reason'] | undefined
        if (objects.some((object) => removed.has(object))) reason = 'object_removed'
        for (const change of diff.changedObjects) {
          if (reason !== undefined || !objects.includes(change.object)) continue
          if (change.typeChanged !== undefined) reason = 'type_changed'
          else if (change.removedColumns.some((column) => used(change.object, column))) {
            reason = 'column_removed'
          } else if (
            change.changedColumns.some((entry) => used(change.object, entry.column)) ||
            (stars.includes(change.object) &&
              change.addedColumns.length + change.removedColumns.length > 0)
          ) {
            reason = 'column_changed'
          }
        }
        if (reason !== undefined) {
          items.push({
            kind: 'component',
            id: `${row.id}:${component.id}`,
            label: `${document.title} / ${component.block.title}`,
            reason,
          })
        }
      }
    }
    return items
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
              componentTitle: component.block.title,
              ops: toOps(ops),
            })
          }
        }
      }
    }
    return entries
  }
}

/** IDs of the page filters a component reads: bindings, the edited record, field defaults. */
function filterInputs(component: CompiledComponent): string[] {
  const ids: string[] = []
  const source = component.source
  const bindings =
    source?.kind === 'query'
      ? source.bindings
      : source?.kind === 'table'
        ? source.model?.bindings
        : []
  for (const binding of bindings ?? []) {
    if (binding.from.kind === 'filter') ids.push(binding.from.filterId)
  }
  if (source?.kind === 'table') {
    for (const field of source.write?.fields ?? []) {
      if (field.default?.kind === 'filter') ids.push(field.default.filterId)
    }
  }
  const block = component.block
  if (block.type === 'form' && block.record?.from.kind === 'filter') {
    ids.push(block.record.from.filterId)
  }
  return ids
}

/** What render needs to show visible defaults: instance variables and the viewer. */
interface RenderContext {
  variable: (name: string) => unknown
  user: { id: string; email: string }
}

function renderField(write: WriteModel, field: WriteField, context: RenderContext): RenderField {
  const spec = field.spec
  const value = field.default
  let prefill: RenderField['default']
  if (value !== undefined) {
    if (value.kind === 'filter' || value.kind === 'url') prefill = value
    else if (value.kind === 'constant') prefill = { kind: 'value', value: value.value }
    else if (value.kind === 'variable')
      prefill = { kind: 'value', value: context.variable(value.name) ?? null }
    else
      prefill = {
        kind: 'value',
        value: value.field === 'id' ? context.user.id : context.user.email,
      }
  }
  const generator = field.generator
  return {
    id: field.id,
    column: field.column,
    label: field.label ?? null,
    help: field.help ?? null,
    input: field.kind,
    widget: field.widget,
    kind: spec.kind,
    columnType: spec.columnType,
    required: write.payload.create.some((entry) => entry.column === field.column && entry.required),
    nullable: spec.nullable,
    maxLength: spec.maxLength,
    precision: spec.precision,
    scale: spec.scale,
    ...(spec.enumValues !== undefined && { enumValues: spec.enumValues }),
    hidden: field.hidden,
    ...(prefill !== undefined && { default: prefill }),
    ...(generator !== undefined && {
      generator:
        generator.kind === 'date'
          ? {
              kind: 'date' as const,
              expression: generator.expression,
              editable: generator.editable,
            }
          : { kind: 'auto_increment' as const },
    }),
    create: write.payload.create.some((entry) => entry.column === field.column),
    update: write.payload.update.some((entry) => entry.column === field.column),
    ...(field.reference !== undefined && {
      reference: { target: field.reference.target, extras: field.reference.extras },
    }),
  }
}

/** Fields the client may see: hidden defaults the server sets are left out (§8.4). */
function renderFields(write: WriteModel, context: RenderContext): RenderField[] {
  return write.fields
    .filter(
      (field) => !(field.serverOnly && field.default !== undefined && serverDefault(field.default)),
    )
    .map((field) => renderField(write, field, context))
}
