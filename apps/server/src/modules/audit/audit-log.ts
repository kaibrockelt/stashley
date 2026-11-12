// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEvent, Page } from '@stashley/shared'
import { sql, type Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { AuditEventsTable, Database } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import { csvRow } from '../../platform/csv.ts'

export interface Actor {
  kind: AuditEventsTable['actor_kind']
  id: string | null
  label: string | null
  ip: string | null
}

export const systemActor: Actor = { kind: 'system', id: null, label: null, ip: null }
export const cliActor: Actor = { kind: 'cli', id: null, label: null, ip: null }

export interface AuditInput {
  action: string
  subject?: { kind: string; id: string | null; label: string | null }
  changes?: Record<string, [unknown, unknown]>
  details?: Record<string, unknown>
  pageId?: string
  componentId?: string
  connectionId?: string
  objectName?: string
  rowKey?: string
}

export interface AuditFilter {
  from?: number
  to?: number
  action?: string
  actor?: string
}

function encodeCursor(occurredAt: number, id: string): string {
  return Buffer.from(`${occurredAt}:${id}`).toString('base64url')
}

function decodeCursor(cursor: string): { occurredAt: number; id: string } | undefined {
  const [time, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':')
  const occurredAt = Number(time)
  return Number.isFinite(occurredAt) && id !== undefined ? { occurredAt, id } : undefined
}

/** Append-only audit log. There is no update path; deletion happens only through retention. */
export class AuditLog {
  private readonly db: Kysely<Database>
  private readonly clock: Clock

  constructor(db: Kysely<Database>, clock: Clock = systemClock) {
    this.db = db
    this.clock = clock
  }

  async record(actor: Actor, input: AuditInput): Promise<void> {
    await this.db
      .insertInto('audit_events')
      .values({
        id: uuidv7(),
        occurred_at: this.clock(),
        actor_kind: actor.kind,
        actor_id: actor.id,
        actor_label: actor.label,
        action: input.action,
        ip: actor.ip,
        subject_kind: input.subject?.kind ?? null,
        subject_id: input.subject?.id ?? null,
        subject_label: input.subject?.label ?? null,
        page_id: input.pageId ?? null,
        component_id: input.componentId ?? null,
        connection_id: input.connectionId ?? null,
        object_name: input.objectName ?? null,
        row_key: input.rowKey ?? null,
        changes: input.changes === undefined ? null : JSON.stringify(input.changes),
        details: input.details === undefined ? null : JSON.stringify(input.details),
      })
      .execute()
  }

  private filtered(filter: AuditFilter) {
    let query = this.db.selectFrom('audit_events').selectAll()
    if (filter.from !== undefined) query = query.where('occurred_at', '>=', filter.from)
    if (filter.to !== undefined) query = query.where('occurred_at', '<=', filter.to)
    if (filter.action !== undefined && filter.action !== '') {
      query = query.where(
        sql<boolean>`action like ${`${filter.action.replace(/[%_\\]/g, '\\$&')}%`} escape '\\'`,
      )
    }
    if (filter.actor !== undefined && filter.actor !== '') {
      const actor = filter.actor
      query = query.where((eb) =>
        eb.or([eb('actor_id', '=', actor), eb('actor_label', '=', actor)]),
      )
    }
    return query
  }

  async query(filter: AuditFilter, limit: number, cursor?: string): Promise<Page<AuditEvent>> {
    let query = this.filtered(filter)
    const position = cursor === undefined ? undefined : decodeCursor(cursor)
    if (position !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb('occurred_at', '<', position.occurredAt),
          eb.and([eb('occurred_at', '=', position.occurredAt), eb('id', '<', position.id)]),
        ]),
      )
    }
    const rows = await query
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      data: page.map(toAuditEvent),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.occurred_at, last.id) : null,
    }
  }

  /** Streams matching events as CSV, newest first. */
  async *exportCsv(filter: AuditFilter): AsyncGenerator<string> {
    yield csvRow(['time', 'actor_kind', 'actor', 'action', 'subject', 'ip', 'changes', 'details'])
    let cursor: string | undefined
    do {
      const page = await this.query(filter, 500, cursor)
      for (const event of page.data) {
        yield csvRow([
          event.occurredAt,
          event.actorKind,
          event.actorLabel ?? event.actorId,
          event.action,
          event.subjectLabel ?? event.subjectId,
          event.ip,
          event.changes,
          event.details,
        ])
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
  }

  async deleteOlderThan(cutoff: number): Promise<number> {
    const result = await this.db
      .deleteFrom('audit_events')
      .where('occurred_at', '<', cutoff)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }
}

function toAuditEvent(row: AuditEventsTable): AuditEvent {
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    ip: row.ip,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    changes: row.changes === null ? null : (JSON.parse(row.changes) as AuditEvent['changes']),
    details: row.details === null ? null : (JSON.parse(row.details) as AuditEvent['details']),
  }
}
