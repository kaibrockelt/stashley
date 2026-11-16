// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { ValueKind } from '../values/column-kinds.ts'
import { parseDateExpression } from '../values/date-expression.ts'
import {
  baseFilterCondition,
  columnRef,
  componentId,
  identifier,
  parameterBinding,
  paramName,
  queryRef,
  scalar,
} from './refs.ts'

/**
 * Fields of forms and of table editing (§ Formulare). A column is an input field, a generated
 * field, or not part of the form at all (absent from the list). The field kinds and generators
 * are unions, so further generated field types can be added later.
 */

/**
 * Where a default value comes from. Hidden defaults from instance variables and the user
 * context are set by the server and never taken from the client; defaults from page filters
 * and URL parameters come from the client, hidden or not, and only prefill (E10).
 */
export const fieldDefault = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('constant'),
      value: z.union([scalar, z.array(z.string().max(200)).max(64)]),
    })
    .strict(),
  z.object({ kind: z.literal('variable'), name: paramName }).strict(),
  z.object({ kind: z.literal('user'), field: z.enum(['id', 'email']) }).strict(),
  z.object({ kind: z.literal('filter'), filterId: componentId }).strict(),
  z.object({ kind: z.literal('url'), name: paramName }).strict(),
])
export type FieldDefault = z.infer<typeof fieldDefault>

/** Whether the server sets a default itself (never from the request). */
export function serverDefault(value: FieldDefault): boolean {
  return value.kind === 'constant' || value.kind === 'variable' || value.kind === 'user'
}

/**
 * Input widgets. Each column kind allows the widgets that fit it (`widgetsFor`); the first
 * one is the default.
 */
export const fieldWidgets = [
  'text',
  'textarea',
  'number',
  'switch',
  'date',
  'datetime',
  'time',
  'year',
  'select',
  'multiselect',
  'reference',
] as const
export type FieldWidget = (typeof fieldWidgets)[number]

/**
 * The widgets that fit a column (§ Formulare), the default first. Foreign keys default to a
 * searchable selection; field types change only within compatible types.
 */
export function widgetsFor(kind: ValueKind, columnType: string, reference: boolean): FieldWidget[] {
  const own: FieldWidget[] = (() => {
    switch (kind) {
      case 'boolean':
        return ['switch']
      case 'integer':
      case 'bigint':
      case 'decimal':
      case 'float':
        return ['number']
      case 'date':
        return ['date']
      case 'datetime':
      case 'timestamp':
        return ['datetime']
      case 'time':
        return ['time']
      case 'year':
        return ['year']
      case 'string':
        return /text/i.test(columnType) ? ['textarea', 'text'] : ['text', 'textarea']
      case 'enum':
        return ['select']
      case 'set':
        return ['multiselect']
      case 'json':
      case 'unsupported':
        return []
    }
  })()
  return reference && own.length > 0 ? ['reference', ...own] : own
}

/**
 * Options of a foreign key field: the records of the referenced object with their display
 * value, or the rows of a stored query that returns key and label (e.g. only paid
 * registrations that are not checked in). The server checks a saved key against the same
 * list (`value_not_allowed`). A base filter on the target narrows the records of a table
 * list for everyone, e.g. to the kontingents of one hotel; query lists narrow themselves.
 */
export const referenceOptions = z
  .object({
    /** The object the column refers to; names the relation where a column has several. */
    target: identifier,
    query: z
      .object({
        source: queryRef,
        valueColumn: identifier,
        labelColumn: identifier,
        bindings: z.array(parameterBinding).max(20),
      })
      .strict()
      .optional(),
    /** Columns of the target searched for options; empty: those of the display template. */
    searchColumns: z.array(identifier).max(10).default([]),
    /** Overrides the target's display template. */
    template: z.string().min(1).max(500).optional(),
    /** Further columns of the chosen record, shown read-only, relative to the target. */
    extras: z.array(columnRef).max(10).default([]),
    /** Fixed conditions on the target's records, relative to the target (§ Basisfilter). */
    baseFilter: z.array(baseFilterCondition).max(20).default([]),
  })
  .strict()
export type ReferenceOptions = z.infer<typeof referenceOptions>

export const dateExpression = z
  .string()
  .max(40)
  .refine((text) => parseDateExpression(text) !== undefined, { message: 'invalid_expression' })

export const fieldGenerator = z.discriminatedUnion('kind', [
  /** Detected automatically; the database assigns the value. */
  z.object({ kind: z.literal('auto_increment') }).strict(),
  /**
   * A date evaluated by the server when saving; with `editable` it is a suggestion the user
   * may change, e.g. the date a payment arrived.
   */
  z.object({ kind: z.literal('date'), expression: dateExpression, editable: z.boolean() }).strict(),
])
export type FieldGenerator = z.infer<typeof fieldGenerator>

const fieldBase = {
  id: componentId,
  column: identifier,
  label: z.string().max(200).optional(),
  help: z.string().max(500).optional(),
}

export const formField = z.discriminatedUnion('kind', [
  z
    .object({
      ...fieldBase,
      kind: z.literal('input'),
      widget: z.enum(fieldWidgets).optional(),
      /** Required on top of `NOT NULL` without default. */
      required: z.boolean().default(false),
      default: fieldDefault.optional(),
      /** Hidden fields need a default. */
      hidden: z.boolean().default(false),
      reference: referenceOptions.optional(),
    })
    .strict(),
  z
    .object({
      ...fieldBase,
      kind: z.literal('generated'),
      generator: fieldGenerator,
    })
    .strict(),
])
export type FormField = z.infer<typeof formField>
export type InputField = Extract<FormField, { kind: 'input' }>

export const fieldList = z
  .array(formField)
  .max(100)
  .superRefine((fields, context) => {
    const seen = { ids: new Set<string>(), columns: new Set<string>() }
    fields.forEach((field, index) => {
      if (seen.ids.has(field.id)) {
        context.addIssue({ code: 'custom', path: [index, 'id'], message: 'duplicate' })
      }
      if (seen.columns.has(field.column.toLowerCase())) {
        context.addIssue({ code: 'custom', path: [index, 'column'], message: 'duplicate' })
      }
      seen.ids.add(field.id)
      seen.columns.add(field.column.toLowerCase())
      if (field.kind === 'input' && field.hidden && field.default === undefined) {
        context.addIssue({ code: 'custom', path: [index, 'default'], message: 'required' })
      }
    })
  })

/** What a form does after saving. */
export const afterSave = z.discriminatedUnion('action', [
  z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('show') }).strict(),
  /** Opens a page and hands it the saved record's key as URL parameter. */
  z.object({ action: z.literal('navigate'), pageId: z.uuid(), parameter: paramName }).strict(),
])
export type AfterSave = z.infer<typeof afterSave>

export const editOps = ['create', 'update', 'delete'] as const
export type EditOp = (typeof editOps)[number]

/**
 * Editing of a table with a table source: which operations it offers (within the rights),
 * the fields of the create and edit dialog, and whether cells are edited inline (E11).
 * Inline editing covers the table's own columns that have an input field.
 */
export const tableEditing = z
  .object({
    ops: z.array(z.enum(editOps)).max(3),
    fields: fieldList,
    inline: z.boolean(),
    dialog: z.boolean(),
  })
  .strict()
export type TableEditing = z.infer<typeof tableEditing>
