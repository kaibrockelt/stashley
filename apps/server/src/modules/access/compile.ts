// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Block,
  ComponentKind,
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
  /** Null for forms, whose fields come with M6. */
  model: TableModel | null
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
  facts: AccessFacts
  queries: QueriesService
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
          if (!known) this.issue(`${path}.table.bindings.${index}.from`, 'unknown_input')
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
    if (isUserContextParam(parameter.name)) compiler.issue(`parameters.${index}.name`, 'reserved')
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
      const config = block.type === 'table' ? block.table : null
      compiled = await compiler.table(path, block.source, config, document)
      if (
        block.type === 'form' &&
        compiled?.source.kind === 'table' &&
        compiled.source.object.objectType === 'view'
      ) {
        compiler.issue(`${path}.source`, 'view_read_only')
      }
    }
    if (block.type !== 'form') {
      const columns =
        compiled?.source.kind === 'query' ? compiled.source.stored.resultColumns : null
      checkSettings(compiler, path, block.type, block.settings, columns)
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
      limits: { capability, ceiling, dbGrants: compiled?.dbGrants ?? noOps },
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
