// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { TableOp } from './connections.ts'
import type { QueryResult, ResultColumn } from './queries.ts'
import type { PageDocument, PageFilter, RowLayout } from '../model/page.ts'
import { pageKinds } from '../model/page.ts'
import type { ValueKind } from '../values/column-kinds.ts'

// Design: sections and pages

export interface Section {
  id: string
  name: string
  position: number
}

export const sectionInput = z.object({ name: z.string().trim().min(1).max(120) }).strict()
export const sectionUpdate = z
  .object({ name: z.string().trim().min(1).max(120), position: z.number().int().min(0) })
  .partial()
  .strict()

export const pageSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)

export const pageCreate = z
  .object({
    sectionId: z.uuid().nullable(),
    kind: z.enum(pageKinds),
    slug: pageSlug,
    title: z.string().trim().min(1).max(200),
  })
  .strict()

export const pageUpdate = z
  .object({ sectionId: z.uuid().nullable(), position: z.number().int().min(0), slug: pageSlug })
  .partial()
  .strict()

/** The order of sections and pages in the navigation (§ Navigation und Seiten). */
export const navigationOrder = z
  .object({
    sections: z.array(z.uuid()).max(500),
    pages: z.array(z.object({ id: z.uuid(), sectionId: z.uuid().nullable() }).strict()).max(2000),
  })
  .strict()

export interface PageVersionSummary {
  version: number
  publishedAt: string
  publishedBy: string | null
  /** The draft revision that was published. */
  sourceRevision: number
  current: boolean
}

export interface PageVersionDetail extends PageVersionSummary {
  document: PageDocument
}

/** A configuration problem of a page (§8.6); errors block saving and publishing. */
export interface PageIssue {
  path: string
  code: string
  severity: 'error' | 'warning'
  params?: Record<string, string | number>
}

export interface PageSummary {
  id: string
  slug: string
  kind: (typeof pageKinds)[number]
  title: string
  sectionId: string | null
  position: number
  draftRevision: number
  draftUpdatedAt: string
  publishedVersion: number | null
}

export interface PageDetail extends PageSummary {
  draft: PageDocument
  issues: PageIssue[]
}

// Workspace

export interface NavigationPage {
  id: string
  slug: string
  title: string
  kind: (typeof pageKinds)[number]
}

export interface Navigation {
  sections: { id: string; name: string; pages: NavigationPage[] }[]
  /** Pages without a section, listed after the sections. */
  pages: NavigationPage[]
  /** Slug of the start page (§13.5), or null if no page is visible. */
  home: string | null
}

export const pageModes = ['runtime', 'edit', 'preview'] as const
export type PageMode = (typeof pageModes)[number]

/** A component as the client receives it; server-only configuration is left out (§8.4). */
export interface RenderComponent {
  id: string
  type: 'metric' | 'chart' | 'record' | 'table' | 'form' | 'text'
  title: string
  description?: string
  /** Effective operations of the caller. */
  ops: TableOp[]
  sourceKind: 'query' | 'table' | null
  settings?: Record<string, unknown>
  markdown?: string
  formMode?: 'create' | 'edit' | 'upsert'
  /** Table sources: columns, page size and search. */
  table?: {
    columns: { id: string; label: string | null; kind: ValueKind }[]
    pageSize: number
    searchable: boolean
    sort: { columnId: string; direction: 'asc' | 'desc' } | null
  }
  /** Edit mode: whether the component can read, and its issues. */
  readable?: boolean
  issues?: PageIssue[]
}

export interface RenderPage {
  id: string
  slug: string
  kind: (typeof pageKinds)[number]
  title: string
  description?: string
  mode: PageMode
  /** Published version, or null in edit and preview mode (the draft). */
  version: number | null
  filters: Omit<PageFilter, 'source' | 'valueColumn' | 'labelColumn'>[]
  parameters: { name: string; type: string; list: boolean }[]
  rows: { id: string; layout: RowLayout; components: RenderComponent[] }[]
  table: RenderComponent | null
}

const modeFields = {
  mode: z.enum(pageModes).optional(),
  /** Preview: the roles whose rights apply. */
  roles: z.array(z.uuid()).max(50).optional(),
}

export const columnFilterInput = z
  .object({
    columnId: z.string().min(1).max(40),
    operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'null', 'not_null']),
    value: z.unknown().optional(),
  })
  .strict()

/** A component read: values for page filters and URL parameters, and table options. */
export const componentQuery = z
  .object({
    ...modeFields,
    filters: z.record(z.string(), z.unknown()).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    sort: z
      .object({ columnId: z.string().min(1).max(40), direction: z.enum(['asc', 'desc']) })
      .strict()
      .optional(),
    search: z.string().max(200).optional(),
    columnFilters: z.array(columnFilterInput).max(20).optional(),
    cursor: z.string().max(4096).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
  })
  .strict()

export const filterOptionsQuery = z
  .object({
    ...modeFields,
    search: z.string().max(200).optional(),
    cursor: z.string().max(4096).optional(),
  })
  .strict()

export const rowQuery = z
  .object({ mode: z.enum(pageModes).optional(), roles: z.string().max(2000).optional() })
  .strict()

/** Freshness of a component result (§12). */
export interface Freshness {
  fetchedAt: string
  /** The database was unreachable; this is the last cached state. */
  stale: boolean
  /** A live query took longer than 2 s; a cache duration is recommended. */
  hint?: { code: 'slow_live_query'; recommendedTtlSeconds: number }
  /** Not cached: the result exceeds 20 MB. */
  notCached?: 'too_large'
}

export interface ComponentResult extends QueryResult, Freshness {
  nextCursor: string | null
  prevCursor: string | null
  /** Tables over stored queries: rows after filters, for paging. */
  total?: number
}

export interface TableRow {
  key: unknown
  values: Record<string, unknown>
}

export interface TableResult extends Freshness {
  columns: { id: string; label: string | null; kind: ValueKind }[]
  rows: TableRow[]
  nextCursor: string | null
  prevCursor: string | null
  truncated: false
  invalidRows?: number[]
}

export interface CountResult extends Freshness {
  count: number | null
  approximate: boolean
}

export interface FilterOption {
  value: unknown
  label: string
}

export interface FilterOptions extends Freshness {
  options: FilterOption[]
  nextCursor: string | null
}

/** Admin overview (§8.7): who can do what on which object, through which page. */
export interface PermissionEntry {
  connectionId: string
  object: string
  principal: string
  pageId: string
  pageTitle: string
  componentId: string
  ops: TableOp[]
}

export type { ResultColumn }
