// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Block,
  ComponentKind,
  DetailTable,
  ComponentRestriction,
  OpMask,
  PageDocument,
  PageFilter,
  ParameterBinding,
  ResultColumn,
  SettingsBlockType,
  SourceKey,
  StaticLimits,
  TableOp,
} from '@stashley/shared'
import {
  authenticatedPrincipal,
  detailRecordParameter as recordParameter,
  capabilityOf,
  componentKindOf,
  componentsOf,
  grantsAboveCeiling,
  hasOp,
  isUserContextParam,
  noOps,
  opBits,
  queryCeiling,
  querySource,
  restrictionsAbovePage,
  settingsProblems,
  tableSource,
  toOps,
} from '@stashley/shared'
import type { CacheDependencies } from '../cache/query-cache.ts'
import { buildTableModel, ModelError, type TableModel } from '../execution/sql/table-model.ts'
import type { QueriesService, StoredVersion } from '../queries/service.ts'
import { AccessFacts, type ConnectionFacts, type ObjectFacts } from './facts.ts'
import { buildWriteModel, type WriteInput, type WriteModel } from './write-model.ts'

/**
 * Compiled pages (§13.3): a published or draft document resolved against the current
 * table access, catalog and query versions. They hold the static part of the access
 * formula per component; per request only the principals' union remains (§8.3).
 */

/** A derived configuration problem (§8.6). Errors block saving and publishing. */
export interface PageIssue {
  path: string
  code: string
  severity: 'error' | 'warning'
  params?: Record<string, string | number>
}

export interface CompiledQuerySource {
  kind: 'query'
  stored: StoredVersion
  connection: ConnectionFacts
  dependencies: CacheDependencies
  bindings: readonly ParameterBinding[]
}

export interface CompiledTableSource {
  kind: 'table'
  connection: ConnectionFacts
  object: ObjectFacts
  /** What it reads; for forms the record with the form's fields and base filter. */
  model: TableModel | null
  /** Forms and editable tables: what writes may do (§11). */
  write: WriteModel | null
  dependencies: CacheDependencies
  cacheTtlSeconds: number
}

export interface CompiledComponent {
  id: string
  path: string
  block: Block
  kind: ComponentKind
  sourceKey: SourceKey | undefined
  restrictions: readonly ComponentRestriction[]
  /** Capability, ceiling and database grants; zero ceiling when the source is broken. */
  limits: StaticLimits
  source: CompiledQuerySource | CompiledTableSource | undefined
}

export interface CompiledFilter {
  filter: PageFilter
  source: CompiledQuerySource | undefined
  limits: StaticLimits
}

export interface CompiledPage {
  pageId: string
  slug: string
  sectionId: string | null
  position: number
  /** The published version, or null for a draft. */
  version: number | null
  revision: number
  document: PageDocument
  components: ReadonlyMap<string, CompiledComponent>
  filters: ReadonlyMap<string, CompiledFilter>
  issues: PageIssue[]
}

export interface PageInput {
  pageId: string
  slug: string
  sectionId: string | null
  position: number
  version: number | null
  revision: number
  document: PageDocument
}

export interface CompileDeps {
  /** The access facts; the configuration import passes a view with its pending changes. */
  facts: Pick<AccessFacts, 'connection' | 'table'>
  queries: Pick<QueriesService, 'stored'>
  roleIds: ReadonlySet<string>
}

const read = opBits.read

class PageCompiler {
  readonly issues: PageIssue[] = []
  private readonly deps: CompileDeps
  private readonly draft: boolean
  /** Ceilings of the page's sources, for checking grants. */
  readonly ceilings = new Map<SourceKey, OpMask>()

  constructor(deps: CompileDeps, draft: boolean) {
    this.deps = deps
    this.draft = draft
  }

  issue(path: string, code: string, params?: Record<string, string | number>, warning = false) {
    this.issues.push({
      path,
      code,
      severity: warning ? 'warning' : 'error',
      ...(params !== undefined && { params }),
    })
  }

  async query(
    path: string,
    ref: { queryId: string; version?: number | undefined },
    bindings: readonly ParameterBinding[],
    page: PageDocument,
  ): Promise<{ source: CompiledQuerySource; ceiling: OpMask; dbGrants: OpMask } | undefined> {
    if (!this.draft && ref.version === undefined) {
      this.issue(`${path}.source.version`, 'version_missing')
      return undefined
    }
    const stored = await this.deps.queries.stored(ref.queryId, this.draft ? undefined : ref.version)
    if (stored === undefined) {
      this.issue(`${path}.source`, 'query_missing')
      return undefined
    }
    const connection = await this.deps.facts.connection(stored.connectionId)
    // The analysis is checked against the current table access (§10.2).
    const ceiling = queryCeiling(stored.analysis, (name) => connection.objects.get(name))
    if (ceiling === noOps) this.issue(`${path}.source`, 'query_not_readable')
    const granted = stored.analysis.objects.every((name) =>
      hasOp(connection.objects.get(name)?.dbGrants ?? noOps, 'read'),
    )
    if (!granted) this.issue(`${path}.source`, 'grant_missing', undefined, true)
    const selectable = new Set(stored.parameters.map((parameter) => parameter.name))
    bindings.forEach((binding, index) => {
      const at = `${path}.bindings.${index}`
      if (!selectable.has(binding.parameter) || isUserContextParam(binding.parameter)) {
        this.issue(`${at}.parameter`, 'parameter_not_bindable')
      }
      const from = binding.from
      const known =
        from.kind === 'filter'
          ? page.filters.some((filter) => filter.id === from.filterId)
          : page.parameters.some((parameter) => parameter.name === from.name)
      if (!known) this.issue(`${at}.from`, 'unknown_input')
    })
    const deps = AccessFacts.dependencies(connection, stored.analysis.objects)
    return {
      source: {
        kind: 'query',
        stored,
        connection,
        dependencies: {
          connectionId: connection.connectionId,
          tables: deps.tables,
          allTables: deps.allTables || stored.analysis.unknownDependencies,
          variables: stored.analysis.variables,
        },
        bindings,
      },
      ceiling,
      dbGrants: granted ? read : noOps,
    }
  }

  async table(
    path: string,
    ref: { tableAccessId: string; cacheTtlSeconds: number },
    config: Parameters<typeof buildTableModel>[1] | null,
    page: PageDocument,
  ): Promise<{ source: CompiledTableSource; ceiling: OpMask; dbGrants: OpMask } | undefined> {
    const found = await this.deps.facts.table(ref.tableAccessId)
    if (found === undefined || !found.object.active) {
      this.issue(`${path}.source`, 'object_not_exposed')
      return undefined
    }
    const { connection, object } = found
    let model: TableModel | null = null
    let ceiling = object.ceiling
    let dbGrants = object.dbGrants
    if (config !== null) {
      try {
        model = buildTableModel(object.objectName, config, connection, `${path}.table`)
      } catch (error) {
        if (!(error instanceof ModelError)) throw error
        for (const problem of error.errors) {
          this.issue(problem.field === 'source' ? `${path}.source` : problem.field, problem.code)
        }
        ceiling = noOps
      }
      if (model !== null) {
        for (const name of model.objects) {
          if (!hasOp(connection.objects.get(name)?.dbGrants ?? noOps, 'read')) dbGrants &= ~read
        }
        model.bindings.forEach((binding, index) => {
          const from = binding.from
          const known =
            from.kind === 'filter'
              ? page.filters.some((filter) => filter.id === from.filterId)
              : page.parameters.some((parameter) => parameter.name === from.name)
          // The record binding of detail tables comes from the page's own URL (§13.1).
          if (!known && !(from.kind === 'url' && from.name === recordParameter)) {
            this.issue(`${path}.table.bindings.${index}.from`, 'unknown_input')
          }
        })
      }
    }
    if (!hasOp(dbGrants, 'read')) this.issue(`${path}.source`, 'grant_missing', undefined, true)
    const deps = AccessFacts.dependencies(connection, model?.objects ?? [object.objectName])
    return {
      source: {
        kind: 'table',
        connection,
        object,
        model,
        write: null,
        dependencies: {
          connectionId: connection.connectionId,
          tables: deps.tables,
          allTables: deps.allTables,
          variables: (model?.baseFilter ?? []).flatMap((condition) =>
            condition.value?.kind === 'variable' ? [condition.value.name] : [],
          ),
        },
        cacheTtlSeconds: ref.cacheTtlSeconds,
      },
      ceiling,
      dbGrants,
    }
  }

  /**
   * The write model of a form or an editable table. Its record model replaces a form's empty
   * one; missing column grants withhold operations, errors leave the component without writes.
   */
  async write(
    compiled: { source: CompiledTableSource; ceiling: OpMask; dbGrants: OpMask },
    input: WriteInput,
  ): Promise<{ ok: boolean }> {
    const source = compiled.source
    const built = buildWriteModel(source.connection, source.object, input, (...args) =>
      this.issue(...args),
    )
    compiled.dbGrants &= ~built.withheld
    for (const { index, reference } of built.queries) {
      const query = reference.query
      if (query === undefined) continue
      const at = `${input.fieldsPath}.${index}.reference.query`
      const resolved = await this.query(at, query.ref, query.bindings, input.document)
      if (resolved === undefined || resolved.ceiling === noOps) {
        built.model = undefined
        continue
      }
      const columns = resolved.source.stored.resultColumns
      for (const name of ['valueColumn', 'labelColumn'] as const) {
        if (columns !== null && !columns.some((column) => column.name === query[name])) {
          this.issue(`${at}.${name}`, 'unknown_column')
          built.model = undefined
        }
      }
      query.source = resolved.source
    }
    if (built.model === undefined) return { ok: false }
    source.write = built.model
    if (source.model === null) {
      source.model = built.model.row
      const deps = AccessFacts.dependencies(source.connection, built.model.row.objects)
      source.dependencies = {
        ...source.dependencies,
        tables: deps.tables,
        allTables: deps.allTables,
      }
    }
    return { ok: true }
  }

  principal(path: string, principal: string): void {
    if (principal !== authenticatedPrincipal && !this.deps.roleIds.has(principal)) {
      // D15: grants to deleted roles stay in the document but take no effect. A warning, so
      // the draft can still be saved and the role removed in the editor.
      this.issue(path, 'unknown_role', { role: principal }, true)
    }
  }
}

/** Compiles a document; problems become issues and zero the affected component's rights. */
export async function compilePage(input: PageInput, deps: CompileDeps): Promise<CompiledPage> {
  const document = input.document
  const compiler = new PageCompiler(deps, input.version === null)
  const ids = new Set<string>()

  const filters = new Map<string, CompiledFilter>()
  for (const [index, filter] of document.filters.entries()) {
    const path = `filters.${index}`
    if (ids.has(filter.id)) compiler.issue(`${path}.id`, 'duplicate')
    ids.add(filter.id)
    if (filter.kind !== 'select') {
      filters.set(filter.id, {
        filter,
        source: undefined,
        limits: { capability: 0, ceiling: 0, dbGrants: 0 },
      })
      continue
    }
    const compiled = await compiler.query(path, filter.source, [], document)
    filters.set(filter.id, {
      filter,
      source: compiled?.source,
      limits: {
        capability: read,
        ceiling: compiled?.ceiling ?? noOps,
        dbGrants: compiled?.dbGrants ?? noOps,
      },
    })
  }
  const names = new Set<string>()
  document.parameters.forEach((parameter, index) => {
    if (names.has(parameter.name)) compiler.issue(`parameters.${index}.name`, 'duplicate')
    if (isUserContextParam(parameter.name) || parameter.name === recordParameter) {
      compiler.issue(`parameters.${index}.name`, 'reserved')
    }
    names.add(parameter.name)
  })

  const components = new Map<string, CompiledComponent>()
  for (const { component: block, path } of componentsOf(document)) {
    if (ids.has(block.id)) compiler.issue(`${path}.id`, 'duplicate')
    ids.add(block.id)
    const kind = componentKindOf(block)
    const capability = capabilityOf(kind)
    let compiled:
      | { source: CompiledQuerySource | CompiledTableSource; ceiling: OpMask; dbGrants: OpMask }
      | undefined
    let limitedCapability = capability
    let sourceKey: SourceKey | undefined
    if (block.type === 'text') {
      components.set(block.id, {
        id: block.id,
        path,
        block,
        kind,
        sourceKey: undefined,
        restrictions: block.restrictions,
        limits: { capability, ceiling: noOps, dbGrants: noOps },
        source: undefined,
      })
      continue
    }
    if (block.source.kind === 'query') {
      sourceKey = querySource(block.source.queryId)
      const bindings = 'bindings' in block ? block.bindings : []
      compiled = await compiler.query(path, block.source, bindings, document)
    } else {
      sourceKey = tableSource(block.source.tableAccessId)
      let config = block.type === 'table' ? block.table : null
      // A related table of the detail view reads the rows that refer to the shown record.
      const link = 'link' in block ? (block as DetailTable).link : undefined
      if (link !== undefined && config !== null) {
        const main = document.table
        const mainAccess =
          main?.source.kind === 'table'
            ? await deps.facts.table(main.source.tableAccessId)
            : undefined
        const own = await deps.facts.table(block.source.tableAccessId)
        const relation = own?.connection.relations.find(
          (entry) =>
            entry.sourceObject === own.object.objectName &&
            entry.sourceColumn === link.column &&
            entry.targetObject === mainAccess?.object.objectName &&
            entry.targetColumn === mainAccess.object.keyColumn,
        )
        if (relation === undefined) compiler.issue(`${path}.link.column`, 'unknown_relation')
        config = {
          ...config,
          bindings: [
            ...config.bindings,
            {
              from: { kind: 'url', name: recordParameter },
              column: { path: [], column: link.column },
              operator: 'eq',
            },
          ],
        }
      }
      compiled = await compiler.table(path, block.source, config, document)
      const table =
        compiled?.source.kind === 'table'
          ? (compiled as typeof compiled & { source: CompiledTableSource })
          : undefined
      if (block.type === 'form' && table !== undefined) {
        if (table.source.object.objectType === 'view') {
          compiler.issue(`${path}.source`, 'view_read_only')
        } else {
          const result = await compiler.write(table, {
            path,
            fieldsPath: `${path}.fields`,
            fields: block.fields,
            mode: block.mode,
            ops: {
              create: block.mode !== 'edit',
              update: block.mode !== 'create',
            },
            upsertKey: block.upsertKey,
            baseFilter: block.baseFilter,
            document,
          })
          // A broken form is not delivered; its grants stay valid against the ceiling.
          if (!result.ok) limitedCapability = noOps
        }
        if (block.mode === 'edit') {
          const from = block.record?.from
          if (from === undefined) compiler.issue(`${path}.record`, 'record_missing')
          else if (
            from.kind === 'filter'
              ? !document.filters.some((filter) => filter.id === from.filterId)
              : !document.parameters.some((parameter) => parameter.name === from.name)
          ) {
            compiler.issue(`${path}.record.from`, 'unknown_input')
          }
        } else if (block.record !== null) {
          compiler.issue(`${path}.record`, 'not_allowed')
        }
        if (block.mode !== 'upsert' && block.upsertKey !== null) {
          compiler.issue(`${path}.upsertKey`, 'not_allowed')
        }
      }
      const tableConfig = block.type === 'table' ? block.table : null
      const editing = tableConfig?.editing
      if (editing !== undefined && editing !== null && table !== undefined) {
        const at = `${path}.table.editing`
        if (table.source.object.objectType === 'view') {
          compiler.issue(at, 'view_read_only')
          limitedCapability = read
        } else {
          if (editing.inline && !editing.ops.includes('update')) {
            compiler.issue(`${at}.inline`, 'inline_without_update')
          }
          const writes = editing.ops.includes('create') || editing.ops.includes('update')
          if (writes) {
            const result = await compiler.write(table, {
              path,
              fieldsPath: `${at}.fields`,
              fields: editing.fields,
              mode: 'table',
              ops: {
                create: editing.ops.includes('create'),
                update: editing.ops.includes('update'),
              },
              upsertKey: null,
              baseFilter: tableConfig?.baseFilter ?? [],
              document,
            })
            // A broken write model leaves the table readable.
            if (!result.ok) limitedCapability = read | (capability & opBits.delete)
          } else if (editing.fields.length > 0) {
            compiler.issue(`${at}.fields`, 'not_allowed')
          }
        }
      }
    }
    if (block.type === 'table' && block.source.kind === 'query' && block.table?.editing) {
      compiler.issue(`${path}.table.editing`, 'not_allowed')
    }
    if (block.type !== 'form') {
      const columns =
        compiled?.source.kind === 'query' ? compiled.source.stored.resultColumns : null
      checkSettings(compiler, path, block.type, block.settings, columns)
      // Without the result columns the mapping cannot be checked; say so instead of passing.
      if (compiled?.source.kind === 'query' && columns === null && block.settings !== undefined) {
        compiler.issue(`${path}.settings`, 'columns_unknown', undefined, true)
      }
    }
    // A source used twice must have one ceiling; the stricter one wins.
    const ceiling = compiled?.ceiling ?? noOps
    compiler.ceilings.set(sourceKey, (compiler.ceilings.get(sourceKey) ?? ceiling) & ceiling)
    components.set(block.id, {
      id: block.id,
      path,
      block,
      kind,
      sourceKey,
      restrictions: block.restrictions,
      limits: { capability: limitedCapability, ceiling, dbGrants: compiled?.dbGrants ?? noOps },
      source: compiled?.source,
    })
    const problems = restrictionsAbovePage(document.access, block.restrictions, sourceKey)
    for (const problem of problems) {
      compiler.issue(`${path}.restrictions.${problem.index}`, 'restriction_widens', {
        ops: problem.ops.join(','),
      })
    }
    block.restrictions.forEach((restriction, index) =>
      compiler.principal(`${path}.restrictions.${index}.principal`, restriction.principal),
    )
  }

  // Grants above the ceiling and grants for sources the page does not use (§8.6).
  for (const problem of grantsAboveCeiling(
    document.access,
    (source) => compiler.ceilings.get(source) ?? noOps,
  )) {
    const grant = document.access.grants[problem.index]
    const unknown = grant !== undefined && !compiler.ceilings.has(grant.source)
    compiler.issue(
      `access.grants.${problem.index}`,
      unknown ? 'unknown_source' : 'exceeds_ceiling',
      {
        ops: problem.ops.join(','),
      },
    )
  }
  document.access.view.forEach((principal, index) =>
    compiler.principal(`access.view.${index}`, principal),
  )
  document.access.grants.forEach((grant, index) =>
    compiler.principal(`access.grants.${index}.principal`, grant.principal),
  )

  return {
    pageId: input.pageId,
    slug: input.slug,
    sectionId: input.sectionId,
    position: input.position,
    version: input.version,
    revision: input.revision,
    document,
    components,
    filters,
    issues: compiler.issues,
  }
}

/** Operations as the API shows them. */
export function opsOf(mask: OpMask): TableOp[] {
  return toOps(mask)
}

/**
 * Display settings against the stored result columns of the query (§10.8). Metrics and
 * charts without settings are not configured yet, a warning; settings that do not parse or
 * map to missing or unsuitable columns are errors, and users see a neutral error state.
 */
function checkSettings(
  compiler: PageCompiler,
  path: string,
  type: SettingsBlockType,
  settings: unknown,
  columns: readonly ResultColumn[] | null,
): void {
  if (settings === undefined && (type === 'metric' || type === 'chart')) {
    compiler.issue(`${path}.settings`, 'settings_missing', undefined, true)
    return
  }
  for (const problem of settingsProblems(type, settings, columns)) {
    if (problem.code === 'settings_invalid') {
      compiler.issue(`${path}.settings`, problem.code, { field: problem.path })
    } else {
      compiler.issue(`${path}.settings`, problem.code, {
        column: problem.column,
        ...('expected' in problem && { expected: problem.expected }),
      })
    }
  }
}
