// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceVariable, ParamType, variableCreate, variableUpdate } from '@stashley/shared'
import { checkParamValue, isUserContextParam } from '@stashley/shared'
import type { Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import type { Database, InstanceVariablesTable } from '../../metastore/schema.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'

export interface VariablesDeps {
  db: Kysely<Database>
  audit: AuditLog
  events: EventBus
  clock?: Clock
}

/** The current value of a variable, as queries and base filters bind it. */
export interface VariableValue {
  type: ParamType
  value: string | number | boolean
}

/** Tells whether queries or pages still refer to a variable. */
export type VariableUsage = (name: string) => Promise<boolean>

/**
 * Instance variables (§ Parameter): named, typed values for the whole instance, such as
 * `current_event_id`. A change evicts every cache entry that used the variable (§12).
 */
export class VariablesService {
  private readonly deps: VariablesDeps
  private readonly clock: Clock
  private readonly usages: VariableUsage[] = []
  private values: Promise<Map<string, VariableValue>> | undefined

  constructor(deps: VariablesDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  addUsage(usage: VariableUsage): void {
    this.usages.push(usage)
  }

  async list(): Promise<InstanceVariable[]> {
    const rows = await this.deps.db
      .selectFrom('instance_variables')
      .leftJoin('users', 'users.id', 'instance_variables.updated_by')
      .select([
        'instance_variables.id',
        'instance_variables.name',
        'instance_variables.type',
        'instance_variables.value',
        'instance_variables.description',
        'instance_variables.updated_at',
        'users.email as updated_by',
      ])
      .orderBy('instance_variables.name')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      value: JSON.parse(row.value) as InstanceVariable['value'],
      description: row.description,
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by ?? null,
    }))
  }

  /** Current values by name; held in memory and reloaded after a change. */
  current(): Promise<Map<string, VariableValue>> {
    this.values ??= this.deps.db
      .selectFrom('instance_variables')
      .select(['name', 'type', 'value'])
      .execute()
      .then(
        (rows) =>
          new Map(
            rows.map((row) => [
              row.name,
              { type: row.type, value: JSON.parse(row.value) as VariableValue['value'] },
            ]),
          ),
      )
      .catch((error: unknown) => {
        this.values = undefined
        throw error
      })
    return this.values
  }

  private async row(id: string): Promise<InstanceVariablesTable> {
    const row = await this.deps.db
      .selectFrom('instance_variables')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (row === undefined) throw new AppError('not_found')
    return row
  }

  private checked(type: ParamType, value: unknown): string | number | boolean {
    const result = checkParamValue(type, value)
    if (!result.ok) throw fieldError('value', result.code)
    return result.value
  }

  /** Drops the held values after a change written elsewhere (the configuration import). */
  changed(name: string): void {
    this.values = undefined
    this.deps.events.emit('variable.changed', { name })
  }

  async create(actor: Actor, input: z.infer<typeof variableCreate>): Promise<InstanceVariable> {
    if (isUserContextParam(input.name)) throw fieldError('name', 'reserved')
    const value = this.checked(input.type, input.value)
    const existing = await this.deps.db
      .selectFrom('instance_variables')
      .select('id')
      .where('name', '=', input.name)
      .executeTakeFirst()
    if (existing !== undefined) throw fieldError('name', 'taken')
    const id = uuidv7()
    const now = this.clock()
    await this.deps.db
      .insertInto('instance_variables')
      .values({
        id,
        name: input.name,
        type: input.type,
        value: JSON.stringify(value),
        description: input.description,
        updated_by: actor.id,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await this.deps.audit.record(actor, {
      action: 'variable.created',
      subject: { kind: 'variable', id, label: input.name },
      details: { type: input.type, value },
    })
    this.changed(input.name)
    return this.get(id)
  }

  async get(id: string): Promise<InstanceVariable> {
    const variable = (await this.list()).find((entry) => entry.id === id)
    if (variable === undefined) throw new AppError('not_found')
    return variable
  }

  async update(
    actor: Actor,
    id: string,
    input: z.infer<typeof variableUpdate>,
  ): Promise<InstanceVariable> {
    const row = await this.row(id)
    const type = input.type ?? row.type
    const before = JSON.parse(row.value) as unknown
    const value = this.checked(type, input.value ?? before)
    const changes: Record<string, [unknown, unknown]> = {}
    if (type !== row.type) changes.type = [row.type, type]
    if (JSON.stringify(value) !== row.value) changes.value = [before, value]
    if (input.description !== undefined && input.description !== row.description) {
      changes.description = [row.description, input.description]
    }
    if (Object.keys(changes).length === 0) return this.get(id)
    await this.deps.db
      .updateTable('instance_variables')
      .set({
        type,
        value: JSON.stringify(value),
        description: input.description ?? row.description,
        updated_by: actor.id,
        updated_at: this.clock(),
      })
      .where('id', '=', id)
      .execute()
    await this.deps.audit.record(actor, {
      action: 'variable.updated',
      subject: { kind: 'variable', id, label: row.name },
      changes,
    })
    if (changes.type !== undefined || changes.value !== undefined) this.changed(row.name)
    return this.get(id)
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const row = await this.row(id)
    for (const usage of this.usages) {
      if (await usage(row.name)) throw new AppError('in_use')
    }
    await this.deps.db.deleteFrom('instance_variables').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'variable.deleted',
      subject: { kind: 'variable', id, label: row.name },
      details: { type: row.type, value: JSON.parse(row.value) as unknown },
    })
    this.changed(row.name)
  }
}
