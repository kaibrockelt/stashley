// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { statfs } from 'node:fs/promises'

/** Filesystem magic numbers (statfs f_type) of network filesystems unsuitable for SQLite. */
const networkFilesystems = new Map<number, string>([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0xfe534d42, 'SMB2'],
])

/** Returns the network filesystem name when `dir` is on one, otherwise undefined. */
export async function detectNetworkFilesystem(dir: string): Promise<string | undefined> {
  try {
    const stats = await statfs(dir)
    return networkFilesystems.get(Number(stats.type) >>> 0)
  } catch {
    return undefined
  }
}
