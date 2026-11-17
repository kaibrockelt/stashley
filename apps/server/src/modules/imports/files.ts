// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pipeline as connect, Transform } from 'node:stream'
import type { ImportParseOptions } from '@stashley/shared'
import { importDelimiters } from '@stashley/shared'
import { parse } from 'csv-parse'
import iconv from 'iconv-lite'
import { AppError } from '../../platform/http/problem.ts'

/**
 * Uploaded CSV files (§17 steps 1–2, D1): streamed to `/data/uploads/<id>.csv` with their
 * SHA-256, read as UTF-8 (BOM or strict) or Windows-1252, with the delimiter and the header
 * row guessed from the first lines.
 */

export interface StoredUpload {
  file: string
  size: number
  sha256: string
}

export function uploadPath(dataDir: string, id: string): string {
  return path.join(dataDir, 'uploads', `${id}.csv`)
}

/** Streams a request body to disk, refusing it beyond `maxBytes`. */
export async function saveUpload(
  body: Readable,
  file: string,
  maxBytes: number,
): Promise<StoredUpload> {
  await mkdir(path.dirname(file), { recursive: true })
  const hash = createHash('sha256')
  let size = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > maxBytes) {
        done(new AppError('payload_too_large'))
        return
      }
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await pipeline(body, counter, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
  if (size === 0) {
    await rm(file, { force: true })
    throw new AppError('validation_failed', { errors: [{ field: 'file', code: 'empty' }] })
  }
  return { file, size, sha256: hash.digest('hex') }
}

export async function removeUpload(file: string): Promise<void> {
  await rm(file, { force: true })
}

/** UTF-8 when the file starts with a BOM or decodes strictly as UTF-8, else Windows-1252. */
export async function detectEncoding(file: string): Promise<'utf-8' | 'windows-1252'> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let first = true
  try {
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      if (first && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) return 'utf-8'
      first = false
      decoder.decode(chunk, { stream: true })
    }
    decoder.decode()
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

/** The decoded start of a file, for detection and the preview. */
export async function readStart(
  file: string,
  encoding: ImportParseOptions['encoding'],
  bytes = 256 * 1024,
): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const text = iconv.decode(buffer.subarray(0, bytesRead), encoding)
    // A cut multi-byte character or line at the end must not count.
    const end = text.lastIndexOf('\n')
    return bytesRead < bytes || end < 0 ? text : text.slice(0, end)
  } finally {
    await handle.close()
  }
}

/** Counts of a character per line outside quotes. */
function countsPerLine(text: string, char: string, lines: number): number[] {
  const counts: number[] = []
  let count = 0
  let quoted = false
  for (let index = 0; index < text.length && counts.length < lines; index++) {
    const current = text[index]
    if (current === '"') quoted = !quoted
    else if (!quoted && current === char) count++
    else if (!quoted && current === '\n') {
      counts.push(count)
      count = 0
    }
  }
  if (counts.length < lines && count > 0) counts.push(count)
  return counts
}

/**
 * The delimiter by frequency outside quotes (§17): the candidate found on most of the first
 * lines with the same count wins; ties go to the higher count.
 */
export function detectDelimiter(text: string): ImportParseOptions['delimiter'] {
  let best: { delimiter: ImportParseOptions['delimiter']; score: number; count: number } = {
    delimiter: ',',
    score: 0,
    count: 0,
  }
  for (const delimiter of importDelimiters) {
    const counts = countsPerLine(text.replace(/^\uFEFF/, ''), delimiter, 20).filter(
      (count, index, all) => count > 0 || index < all.length - 1,
    )
    if (counts.length === 0) continue
    const first = counts[0] ?? 0
    if (first === 0) continue
    const consistent = counts.filter((count) => count === first).length / counts.length
    const score = consistent * counts.length
    if (score > best.score || (score === best.score && first > best.count)) {
      best = { delimiter, score, count: first }
    }
  }
  return best.delimiter
}

const looksLikeValue = /^\s*([+-]?[\d.,' ]+|\d{1,4}[./-]\d{1,2}[./-]\d{1,4}.*|true|false)\s*$/i

/** Whether the first row names the columns: every cell filled, unique and no value. */
export function detectHeader(rows: readonly (readonly string[])[]): boolean {
  const [first] = rows
  if (first === undefined || first.length === 0) return true
  const names = first.map((cell) => cell.trim().toLowerCase())
  if (names.some((name) => name === '') || new Set(names).size !== names.length) return false
  return !first.some((cell) => looksLikeValue.test(cell))
}

export interface CsvRecord {
  /** Line number in the file, from 1. */
  line: number
  cells: string[]
}

/** The records of a file, decoded and parsed with the options, as a stream. */
export async function* records(
  file: string,
  options: Pick<ImportParseOptions, 'encoding' | 'delimiter'>,
): AsyncGenerator<CsvRecord> {
  const parser = parse({
    delimiter: options.delimiter,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
    raw: true,
    max_record_size: 1024 * 1024,
  })
  // `pipeline` destroys every stream when one fails or the reader stops early (a preview,
  // a cancelled import), so the file is closed then too; `.pipe()` would leave it open.
  const source = connect(
    createReadStream(file),
    iconv.decodeStream(options.encoding),
    parser,
    () => undefined,
  )
  // Lines are counted from the raw text, so a record names the line it starts on even when
  // a quoted field spans lines; empty lines are skipped but counted.
  let line = 1
  for await (const entry of source as AsyncIterable<{ record: string[]; raw: string }>) {
    const start = line
    // The raw text keeps a `\n` record end but not the `\n` of a `\r\n` one.
    line += (entry.raw.match(/\n/g)?.length ?? 0) + (entry.raw.endsWith('\n') ? 0 : 1)
    if (entry.record.length === 1 && entry.record[0] === '') continue
    yield { line: start, cells: entry.record }
  }
}

/** The first records of a file. */
export async function firstRecords(
  file: string,
  options: Pick<ImportParseOptions, 'encoding' | 'delimiter'>,
  count: number,
): Promise<CsvRecord[]> {
  const out: CsvRecord[] = []
  for await (const record of records(file, options)) {
    out.push(record)
    if (out.length >= count) break
  }
  return out
}
