// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { paramNamePattern, paramTypes, type ParamType } from '../values/params.ts'

// Roles

export interface Role {
  id: string
  name: string
  description: string
  homePageId: string | null
  position: number
  userCount: number
  createdAt: string
  updatedAt: string
}

export const roleInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  homePageId: z.uuid().nullable(),
})
export const roleUpdate = roleInput.partial()
export type RoleInput = z.infer<typeof roleInput>

export const userRolesInput = z.object({ roleIds: z.array(z.uuid()).max(200) })

/** A role as the session and user lists show it. */
export interface RoleRef {
  id: string
  name: string
}

// Instance variables

export interface InstanceVariable {
  id: string
  name: string
  type: ParamType
  value: string | number | boolean
  description: string
  updatedAt: string
  updatedBy: string | null
}

const variableValue = z.union([z.string().max(1000), z.number(), z.boolean()])

export const variableCreate = z.object({
  name: z.string().regex(paramNamePattern),
  type: z.enum(paramTypes),
  value: variableValue,
  description: z.string().trim().max(500),
})
/** The name is fixed once created; queries and base filters refer to it. */
export const variableUpdate = z.object({
  type: z.enum(paramTypes).optional(),
  value: variableValue.optional(),
  description: z.string().trim().max(500).optional(),
})
