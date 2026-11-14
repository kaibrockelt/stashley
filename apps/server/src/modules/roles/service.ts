// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Role, RoleInput, roleUpdate } from '@stashley/shared'
import { sql, type Kysely } from 'kysely'
import { v7 as uuidv7 } from 'uuid'
import type { z } from 'zod'
import { writeTransaction } from '../../metastore/db.ts'
import type { Database, RolesTable, SystemRole } from '../../metastore/schema.ts'
import type { SettingsRepository } from '../../metastore/settings.ts'
import { systemClock, type Clock } from '../../platform/clock.ts'
import type { EventBus } from '../../platform/events.ts'
import { AppError } from '../../platform/http/problem.ts'
import { fieldError } from '../../platform/http/validation.ts'
import type { Actor, AuditLog } from '../audit/audit-log.ts'

export interface RolesDeps {
  db: Kysely<Database>
  settings: SettingsRepository
  audit: AuditLog
  events: EventBus
  clock?: Clock
}

/**
 * Roles (Fachrollen): managers create them and grant rights to them; only admins assign users
 * (§ Systemrollen). Admins can turn off role creation by managers; then only admins create,
 * rename or delete roles, while managers still grant rights to existing ones (D14).
 */
export class RolesService {
  private readonly deps: RolesDeps
  private readonly clock: Clock

  constructor(deps: RolesDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  async list(): Promise<Role[]> {
    const rows = await this.deps.db
      .selectFrom('roles')
      .leftJoin('user_roles', 'user_roles.role_id', 'roles.id')
      .select([
        'roles.id',
        'roles.name',
        'roles.description',
        'roles.home_page_id',
        'roles.position',
        'roles.created_at',
        'roles.updated_at',
        (eb) => eb.fn.count<number>('user_roles.user_id').as('user_count'),
      ])
      .groupBy('roles.id')
      .orderBy('roles.position')
      .orderBy('roles.name')
      .execute()
    return rows.map((row) => toRole(row, Number(row.user_count)))
  }

  async get(id: string): Promise<Role> {
    const role = (await this.list()).find((entry) => entry.id === id)
    if (role === undefined) throw new AppError('not_found')
    return role
  }

  /** IDs of all existing roles, for checking grants. */
  async ids(): Promise<Set<string>> {
    const rows = await this.deps.db.selectFrom('roles').select('id').execute()
    return new Set(rows.map((row) => row.id))
  }

  private async mayManage(systemRole: SystemRole): Promise<void> {
    if (systemRole === 'admin') return
    const setting = await this.deps.settings.get('roles.managerCreation')
    if (systemRole !== 'manager' || !setting.enabled) throw new AppError('forbidden')
  }

  private async ensureNameFree(name: string, id?: string): Promise<void> {
    let query = this.deps.db
      .selectFrom('roles')
      .select('id')
      .where(sql<boolean>`lower(name) = ${name.toLowerCase()}`)
    if (id !== undefined) query = query.where('id', '!=', id)
    if ((await query.executeTakeFirst()) !== undefined) throw fieldError('name', 'taken')
  }

  private async ensurePage(pageId: string | null): Promise<void> {
    if (pageId === null) return
    const page = await this.deps.db
      .selectFrom('pages')
      .select('id')
      .where('id', '=', pageId)
      .where('archived_at', 'is', null)
      .executeTakeFirst()
    if (page === undefined) throw fieldError('homePageId', 'not_found')
  }

  async create(actor: Actor, systemRole: SystemRole, input: RoleInput): Promise<Role> {
    await this.mayManage(systemRole)
    await this.ensureNameFree(input.name)
    await this.ensurePage(input.homePageId)
    const last = await this.deps.db
      .selectFrom('roles')
      .select((eb) => eb.fn.max<number>('position').as('position'))
      .executeTakeFirst()
    const id = uuidv7()
    const now = this.clock()
    await this.deps.db
      .insertInto('roles')
      .values({
        id,
        name: input.name,
        description: input.description,
        home_page_id: input.homePageId,
        position: (last?.position ?? -1) + 1,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await this.deps.audit.record(actor, {
      action: 'role.created',
      subject: { kind: 'role', id, label: input.name },
      details: { description: input.description, homePageId: input.homePageId },
    })
    this.deps.events.emit('roles.changed', {})
    return this.get(id)
  }

  /** Name and description need the right to manage roles; the home page is design work. */
  async update(
    actor: Actor,
    systemRole: SystemRole,
    id: string,
    input: z.infer<typeof roleUpdate>,
  ): Promise<Role> {
    const before = await this.get(id)
    const renames =
      (input.name !== undefined && input.name !== before.name) ||
      (input.description !== undefined && input.description !== before.description)
    if (renames) await this.mayManage(systemRole)
    else if (systemRole !== 'admin' && systemRole !== 'manager') throw new AppError('forbidden')
    if (input.name !== undefined) await this.ensureNameFree(input.name, id)
    if (input.homePageId !== undefined) await this.ensurePage(input.homePageId)
    const changes: Record<string, [unknown, unknown]> = {}
    for (const key of ['name', 'description', 'homePageId'] as const) {
      const next = input[key]
      if (next !== undefined && next !== before[key]) changes[key] = [before[key], next]
    }
    if (Object.keys(changes).length === 0) return before
    await this.deps.db
      .updateTable('roles')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.homePageId !== undefined && { home_page_id: input.homePageId }),
        updated_at: this.clock(),
      })
      .where('id', '=', id)
      .execute()
    await this.deps.audit.record(actor, {
      action: 'role.updated',
      subject: { kind: 'role', id, label: input.name ?? before.name },
      changes,
    })
    this.deps.events.emit('roles.changed', {})
    return this.get(id)
  }

  /**
   * Deleting a role removes its assignments. Grants on pages that name it stay in the stored
   * documents but no longer take effect, and the pages show an issue (D15).
   */
  async remove(actor: Actor, systemRole: SystemRole, id: string): Promise<void> {
    await this.mayManage(systemRole)
    const role = await this.get(id)
    await this.deps.db.deleteFrom('roles').where('id', '=', id).execute()
    await this.deps.audit.record(actor, {
      action: 'role.deleted',
      subject: { kind: 'role', id, label: role.name },
      details: { users: role.userCount },
    })
    this.deps.events.emit('roles.changed', {})
  }

  /** Replaces the roles of a user (admins only, checked by the route). */
  async assign(actor: Actor, userId: string, roleIds: string[]): Promise<string[]> {
    const user = await this.deps.db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('id', '=', userId)
      .executeTakeFirst()
    if (user === undefined) throw new AppError('not_found')
    const wanted = [...new Set(roleIds)]
    const known = await this.ids()
    const unknown = wanted.findIndex((roleId) => !known.has(roleId))
    if (unknown !== -1) throw fieldError(`roleIds.${unknown}`, 'not_found')
    const names = new Map((await this.list()).map((role) => [role.id, role.name]))
    const before = await writeTransaction(this.deps.db, async (trx) => {
      const current = await trx
        .selectFrom('user_roles')
        .select('role_id')
        .where('user_id', '=', userId)
        .execute()
      await trx.deleteFrom('user_roles').where('user_id', '=', userId).execute()
      if (wanted.length > 0) {
        await trx
          .insertInto('user_roles')
          .values(wanted.map((roleId) => ({ user_id: userId, role_id: roleId })))
          .execute()
      }
      return current.map((row) => row.role_id)
    })
    const label = (ids: string[]) => ids.map((roleId) => names.get(roleId) ?? roleId).sort()
    if (JSON.stringify(label(before)) !== JSON.stringify(label(wanted))) {
      await this.deps.audit.record(actor, {
        action: 'user.roles_changed',
        subject: { kind: 'user', id: userId, label: user.email },
        changes: { roles: [label(before), label(wanted)] },
      })
    }
    this.deps.events.emit('user.changed', { userId })
    return wanted
  }

  /** Role IDs of a user; read on every request, so a change applies to the next one. */
  async ofUser(userId: string): Promise<string[]> {
    const rows = await this.deps.db
      .selectFrom('user_roles')
      .select('role_id')
      .where('user_id', '=', userId)
      .execute()
    return rows.map((row) => row.role_id)
  }

  /** Roles in their configured order, with home pages, for the start page (§13.5). */
  async ordered(): Promise<Pick<RolesTable, 'id' | 'home_page_id'>[]> {
    return this.deps.db
      .selectFrom('roles')
      .select(['id', 'home_page_id'])
      .orderBy('position')
      .orderBy('name')
      .execute()
  }
}

function toRole(
  row: Pick<
    RolesTable,
    'id' | 'name' | 'description' | 'home_page_id' | 'position' | 'created_at' | 'updated_at'
  >,
  userCount: number,
): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    homePageId: row.home_page_id,
    position: row.position,
    userCount,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}
