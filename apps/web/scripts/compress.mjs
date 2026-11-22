// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Writes Brotli and gzip variants next to the built assets, which the server sends to
// browsers that accept them (`preCompressed`). Compressing once at build time keeps the
// server's CPU for requests: the JavaScript shrinks to about a third on the wire.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const root = path.join(import.meta.dirname, '..', 'dist')
const compressible = /\.(js|css|svg|json|webmanifest|txt)$/

function* files(directory) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry)
    if (statSync(file).isDirectory()) yield* files(file)
    else yield file
  }
}

let count = 0
for (const file of files(root)) {
  if (!compressible.test(file)) continue
  const content = readFileSync(file)
  if (content.length < 1024) continue
  writeFileSync(
    `${file}.br`,
    brotliCompressSync(content, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: content.length,
      },
    }),
  )
  writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }))
  count += 1
}
process.stdout.write(`compressed ${String(count)} files\n`)
