// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Engine } from '@stashley/shared'

/** Versions with vendor support that CI tests against (LTS releases). */
const supported: Record<Engine, string[]> = {
  mariadb: ['10.11', '11.4', '11.8', '12.3'],
  mysql: ['8.4', '9.7'],
}

export interface ServerVersion {
  engine: Engine
  version: string
  supported: boolean
}

export function isSupportedVersion(engine: Engine, version: string): boolean {
  const number = /^(\d+)\.(\d+)/.exec(version)
  return number !== null && supported[engine].includes(`${number[1]}.${number[2]}`)
}

/** Reads `SELECT VERSION(), @@version_comment`. */
export function parseServerVersion(version: string, comment: string): ServerVersion {
  const engine: Engine = /mariadb/i.test(`${version} ${comment}`) ? 'mariadb' : 'mysql'
  const number = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  const clean = number === null ? version : `${number[1]}.${number[2]}.${number[3]}`
  const series = number === null ? '' : `${number[1]}.${number[2]}`
  return { engine, version: clean, supported: supported[engine].includes(series) }
}
