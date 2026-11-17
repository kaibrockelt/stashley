// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiOperation } from '@stashley/shared'
import type { ResourceColumn, ResourceModel } from '../access/service.ts'
import { apiFilterOperators, defaultLimit, maxInValues, maxLimit } from './query.ts'

/**
 * The OpenAPI 3.1 document of the public API (§16), generated from table access, the
 * catalog and the enabled endpoints. With a token it lists only what that token can use; it
 * never names a real table.
 */

type Schema = Record<string, unknown>

export interface DocumentedResource {
  resource: ResourceModel
  operations: readonly ApiOperation[]
}

const problemRef = { $ref: '#/components/schemas/Problem' }

function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: problemRef } } }
}

const errorResponses = {
  '400': problemResponse('Malformed request, unknown parameter, operator or column'),
  '401': problemResponse('Missing, invalid, expired or revoked token'),
  '403': problemResponse('The token may not use this operation, or its address is not allowed'),
  '404': problemResponse('Unknown resource, disabled endpoint or unknown row'),
  '429': problemResponse('Rate limit of the token reached; see Retry-After'),
  '503': problemResponse('Database unavailable'),
}

/** The JSON form of a column's values (§9.5). */
export function columnSchema(column: ResourceColumn): Schema {
  const spec = column.spec
  let schema: Schema
  switch (column.kind) {
    case 'boolean':
      schema = { type: 'boolean' }
      break
    case 'integer':
    case 'year':
      schema = { type: 'integer' }
      break
    case 'bigint':
      schema = { type: 'string', pattern: '^-?\\d+$', description: 'BIGINT as text' }
      break
    case 'decimal':
      schema = {
        type: 'string',
        pattern: '^-?\\d+(\\.\\d+)?$',
        description: `DECIMAL as text${spec.precision === null ? '' : ` (${spec.precision},${spec.scale ?? 0})`}`,
      }
      break
    case 'float':
      schema = { type: 'number' }
      break
    case 'date':
      schema = { type: 'string', format: 'date' }
      break
    case 'datetime':
    case 'timestamp':
      schema = { type: 'string', format: 'date-time', description: 'Instant in UTC' }
      break
    case 'time':
      schema = { type: 'string', pattern: '^-?\\d{1,3}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?$' }
      break
    case 'enum':
      schema = { type: 'string', enum: spec.enumValues ?? [] }
      break
    case 'set':
      schema = {
        type: 'array',
        items: { type: 'string', enum: spec.enumValues ?? [] },
        uniqueItems: true,
      }
      break
    case 'json':
      schema = { type: 'string', description: 'JSON as text (read-only)' }
      break
    default:
      schema = { type: 'string', ...(spec.maxLength !== null && { maxLength: spec.maxLength }) }
  }
  if (column.nullable) {
    const type = schema.type as string
    schema = { ...schema, type: [type, 'null'] }
    if (Array.isArray(schema.enum))
      schema = { ...schema, enum: [...(schema.enum as unknown[]), null] }
  }
  return schema
}

function rowSchemas(resource: ResourceModel): Record<string, Schema> {
  const name = schemaName(resource.alias)
  const properties = (columns: ResourceColumn[]) =>
    Object.fromEntries(columns.map((column) => [column.name, columnSchema(column)]))
  const insertable = resource.columns.filter((column) => column.insertable)
  const updatable = resource.columns.filter((column) => column.updatable)
  return {
    [name]: {
      type: 'object',
      properties: properties(resource.columns),
      additionalProperties: false,
    },
    [`${name}Create`]: {
      type: 'object',
      properties: properties(insertable),
      required: insertable.filter((column) => column.spec.required).map((column) => column.name),
      additionalProperties: false,
    },
    [`${name}Update`]: {
      type: 'object',
      properties: properties(updatable),
      additionalProperties: false,
    },
  }
}

/** A component name from an alias: `hotel-bookings` → `HotelBookings`. */
function schemaName(alias: string): string {
  return alias
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('')
}

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` }
}

function json(schema: Schema) {
  return { 'application/json': { schema } }
}

const etagHeader = {
  ETag: { description: 'Version of the row, for If-Match', schema: { type: 'string' } },
}
const ifMatch = {
  name: 'If-Match',
  in: 'header',
  required: false,
  description: 'Optional (D6). The ETag of the row as read, or `*`; a mismatch answers 412.',
  schema: { type: 'string' },
}

function filterParameter(resource: ResourceModel) {
  return {
    name: 'filter',
    in: 'query',
    required: false,
    style: 'deepObject',
    explode: true,
    description:
      `\`filter[column][operator]=value\` with ${apiFilterOperators.map((op) => `\`${op}\``).join(', ')}. ` +
      `\`in\` takes up to ${maxInValues} comma-separated values, \`like\` a pattern with \`%\` and \`_\`, ` +
      '`null` `true` or `false`. Columns: ' +
      resource.columns.map((column) => `\`${column.name}\``).join(', '),
    schema: { type: 'object', additionalProperties: true },
  }
}

function paths(entry: DocumentedResource): Record<string, Schema> {
  const { resource, operations } = entry
  const name = schemaName(resource.alias)
  const has = (operation: ApiOperation) => operations.includes(operation)
  const tag = resource.alias
  const collection: Schema = {}
  const item: Schema = {}
  const idParameter = {
    name: 'id',
    in: 'path',
    required: true,
    description: `The value of \`${resource.keyColumn}\`. The IDs \`count\` and \`schema\` cannot be fetched.`,
    schema: { type: 'string' },
  }
  const sortable = resource.columns.flatMap((column) => [column.name, `-${column.name}`])

  if (has('list')) {
    collection.get = {
      operationId: `list${name}`,
      tags: [tag],
      summary: `List ${resource.alias}`,
      parameters: [
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: maxLimit, default: defaultLimit },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: sortable } },
        {
          name: 'fields',
          in: 'query',
          description: 'Comma-separated columns to return',
          schema: { type: 'string' },
        },
        filterParameter(resource),
      ],
      responses: {
        '200': {
          description: 'One page of rows',
          content: json({
            type: 'object',
            properties: {
              data: { type: 'array', items: ref(name) },
              next_cursor: { type: ['string', 'null'] },
            },
            required: ['data', 'next_cursor'],
          }),
        },
        ...errorResponses,
      },
    }
  }
  if (has('create')) {
    collection.post = {
      operationId: `create${name}`,
      tags: [tag],
      summary: `Create one row of ${resource.alias}; never updates`,
      requestBody: { required: true, content: json(ref(`${name}Create`)) },
      responses: {
        '201': {
          description: 'Created. The row when the token may read it, otherwise its key.',
          headers: etagHeader,
          content: json(ref(name)),
        },
        '409': problemResponse('Row locked'),
        '422': problemResponse('Validation failed, duplicate key or missing referenced row'),
        ...errorResponses,
      },
    }
  }
  if (has('upsert')) {
    collection.put = {
      operationId: `upsert${name}`,
      tags: [tag],
      summary: `Create or update one row of ${resource.alias} by a unique key (idempotent)`,
      parameters: [
        {
          name: 'on',
          in: 'query',
          required: true,
          schema: { type: 'string', enum: resource.upsertColumns },
        },
      ],
      requestBody: { required: true, content: json(ref(`${name}Create`)) },
      responses: {
        '200': {
          description: 'Updated or unchanged',
          headers: etagHeader,
          content: json(ref(name)),
        },
        '201': { description: 'Created', headers: etagHeader, content: json(ref(name)) },
        '422': problemResponse('Validation failed'),
        ...errorResponses,
      },
    }
  }
  if (has('get')) {
    item.get = {
      operationId: `get${name}`,
      tags: [tag],
      summary: `One row of ${resource.alias}`,
      parameters: [idParameter],
      responses: {
        '200': { description: 'The row', headers: etagHeader, content: json(ref(name)) },
        ...errorResponses,
      },
    }
  }
  const updateResponses = {
    '200': {
      description: 'The row after the change',
      headers: etagHeader,
      content: json(ref(name)),
    },
    '412': problemResponse('The row changed since the ETag was read'),
    '422': problemResponse('Validation failed'),
    ...errorResponses,
  }
  if (has('update')) {
    item.patch = {
      operationId: `update${name}`,
      tags: [tag],
      summary: `Change the given columns of one row of ${resource.alias}`,
      parameters: [idParameter, ifMatch],
      requestBody: { required: true, content: json(ref(`${name}Update`)) },
      responses: updateResponses,
    }
  }
  if (has('replace')) {
    item.put = {
      operationId: `replace${name}`,
      tags: [tag],
      summary: `Replace every writable column of one existing row of ${resource.alias}`,
      description:
        'A left-out column with a literal default returns to it, one without a default becomes null, and one with an expression default (such as CURRENT_TIMESTAMP) keeps its value. An unchanged repeat writes nothing.',
      parameters: [idParameter, ifMatch],
      requestBody: { required: true, content: json(ref(`${name}Update`)) },
      responses: updateResponses,
    }
  }
  if (has('delete')) {
    item.delete = {
      operationId: `delete${name}`,
      tags: [tag],
      summary: `Delete one row of ${resource.alias}`,
      parameters: [idParameter, ifMatch],
      responses: {
        '204': { description: 'Deleted' },
        '409': problemResponse('Still referenced by other rows'),
        '412': problemResponse('The row changed since the ETag was read'),
        ...errorResponses,
      },
    }
  }

  const out: Record<string, Schema> = {}
  const base = `/${resource.alias}`
  if (Object.keys(collection).length > 0) out[base] = collection
  if (has('count')) {
    out[`${base}/count`] = {
      get: {
        operationId: `count${name}`,
        tags: [tag],
        summary: `Count rows of ${resource.alias}`,
        parameters: [filterParameter(resource)],
        responses: {
          '200': {
            description: 'The number of rows; null when a filtered count timed out',
            content: json({
              type: 'object',
              properties: {
                count: { type: ['integer', 'null'] },
                approximate: { type: 'boolean' },
              },
              required: ['count', 'approximate'],
            }),
          },
          ...errorResponses,
        },
      },
    }
  }
  if (has('schema')) {
    out[`${base}/schema`] = {
      get: {
        operationId: `schema${name}`,
        tags: [tag],
        summary: `Columns and operations of ${resource.alias}`,
        responses: {
          '200': { description: 'The resource description', content: json({ type: 'object' }) },
          ...errorResponses,
        },
      },
    }
  }
  if (Object.keys(item).length > 0) out[`${base}/{id}`] = item
  return out
}

export function openApiDocument(baseUrl: string, resources: readonly DocumentedResource[]): Schema {
  const sorted = [...resources].sort((a, b) => a.resource.alias.localeCompare(b.resource.alias))
  const schemas: Record<string, Schema> = {
    Problem: {
      type: 'object',
      description: 'RFC 9457 problem document',
      properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        code: { type: 'string' },
        detail: { type: 'string' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              code: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['field', 'code'],
          },
        },
        errorId: { type: 'string' },
      },
      required: ['type', 'title', 'status', 'code'],
    },
  }
  const allPaths: Record<string, Schema> = {}
  for (const entry of sorted) {
    if (entry.operations.length === 0) continue
    Object.assign(schemas, rowSchemas(entry.resource))
    Object.assign(allPaths, paths(entry))
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Stashley API',
      version: '1',
      description:
        'JSON only. Instants in UTC (ISO 8601), dates as YYYY-MM-DD, DECIMAL and BIGINT as text.',
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearer: [] }],
    tags: sorted
      .filter((entry) => entry.operations.length > 0)
      .map((entry) => ({ name: entry.resource.alias })),
    paths: allPaths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'An API token (stl_api_…)' },
      },
      schemas,
    },
  }
}
