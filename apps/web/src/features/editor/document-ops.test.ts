// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  emptyPage,
  formDefaults,
  tableConfigDefaults,
  type Block,
  type PageDocument,
} from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import {
  addBlock,
  addRow,
  grantOf,
  moveBlock,
  newId,
  offeredOps,
  removeBlock,
  removeRow,
  reorderBlocks,
  reorderRows,
  replaceBlock,
  setGrant,
  setRowLayout,
  setViewers,
  unknownPrincipals,
  withoutPrincipals,
} from './document-ops.ts'

const queryId = '0196f3a4-1111-7000-8000-000000000001'
const text = (id: string): Block => ({
  id,
  type: 'text',
  title: id,
  restrictions: [],
  markdown: '',
})
const chart = (id: string): Block => ({
  id,
  type: 'chart',
  title: id,
  restrictions: [],
  source: { kind: 'query', queryId },
  bindings: [],
})

function layout(document: PageDocument) {
  return document.rows.map((row) => [row.id, row.layout, row.blocks.map((block) => block.id)])
}

describe('editor document operations', () => {
  it('adds rows and blocks with fitting layouts and unique IDs', () => {
    let doc = emptyPage('dashboard', 'Overview')
    doc = addRow(doc, text('b1'))
    expect(newId(doc, 'b')).toBe('b2')
    expect(newId(doc, 'r')).toBe('r2')
    doc = addBlock(doc, 'r1', text('b2'))
    doc = addBlock(doc, 'r1', text('b3'))
    doc = addBlock(doc, 'r1', text('b4'))
    doc = addBlock(doc, 'r1', text('b5'))
    expect(layout(doc)).toEqual([['r1', '3-3-3-3', ['b1', 'b2', 'b3', 'b4']]])
  })

  it('changes layouts only to ones with the same block count', () => {
    let doc = addBlock(addRow(emptyPage('dashboard', 'x'), text('a')), 'r1', text('b'))
    doc = setRowLayout(doc, 'r1', '8-4')
    expect(doc.rows[0]?.layout).toBe('8-4')
    expect(setRowLayout(doc, 'r1', '4-4-4').rows[0]?.layout).toBe('8-4')
    // Swapping the blocks of 8-4 keeps each block's width.
    expect(reorderBlocks(doc, 'r1', ['b', 'a']).rows[0]).toMatchObject({
      layout: '4-8',
      blocks: [{ id: 'b' }, { id: 'a' }],
    })
    expect(reorderBlocks(doc, 'r1', ['a', 'b']).rows[0]?.layout).toBe('8-4')
  })

  it('moves blocks between rows and into new rows', () => {
    let doc = addRow(
      addBlock(addRow(emptyPage('dashboard', 'x'), text('a')), 'r1', text('b')),
      text('c'),
    )
    doc = moveBlock(doc, 'b', 'r2')
    expect(layout(doc)).toEqual([
      ['r1', '12', ['a']],
      ['r2', '6-6', ['c', 'b']],
    ])
    doc = moveBlock(doc, 'a', null)
    expect(layout(doc)).toEqual([
      ['r2', '6-6', ['c', 'b']],
      ['r1', '12', ['a']],
    ])
    expect(moveBlock(doc, 'zz', null)).toBe(doc)
    expect(moveBlock(doc, 'c', 'r2')).toBe(doc)
    expect(layout(reorderRows(doc, ['r1', 'r2', 'gone']))).toEqual([
      ['r1', '12', ['a']],
      ['r2', '6-6', ['c', 'b']],
    ])
  })

  it('removes blocks and empty rows and drops grants of unused sources', () => {
    let doc = addBlock(addRow(emptyPage('dashboard', 'x'), chart('a')), 'r1', text('b'))
    doc = setViewers(doc, ['authenticated'])
    doc = setGrant(doc, 'authenticated', `query:${queryId}`, ['read'])
    expect(grantOf(doc, 'authenticated', `query:${queryId}`)).toEqual(['read'])
    doc = removeBlock(doc, 'a')
    expect(layout(doc)).toEqual([['r1', '12', ['b']]])
    expect(doc.access.grants).toEqual([])
    expect(removeRow(doc, 'r1').rows).toEqual([])
  })

  it('replaces blocks, also under a new ID and as the table of a table page', () => {
    const doc = addRow(emptyPage('dashboard', 'x'), text('a'))
    expect(layout(replaceBlock(doc, text('z'), 'a'))).toEqual([['r1', '12', ['z']]])
    const tablePage: PageDocument = {
      ...emptyPage('table', 'x'),
      table: { ...chart('t'), type: 'table', table: null } as never,
    }
    expect(
      replaceBlock(tablePage, { ...chart('t'), title: 'new', type: 'table', table: null } as never)
        .table?.title,
    ).toBe('new')
  })

  it('sets grants and viewers', () => {
    let doc = setViewers(emptyPage('dashboard', 'x'), ['authenticated', 'r-role'])
    doc = addRow(doc, chart('a'))
    doc = setGrant(doc, 'r-role', `query:${queryId}`, ['read'])
    doc = setGrant(doc, 'authenticated', `query:${queryId}`, ['read'])
    doc = setGrant(doc, 'authenticated', `query:${queryId}`, [])
    expect(doc.access.grants).toEqual([
      { principal: 'r-role', source: `query:${queryId}`, ops: ['read'] },
    ])
    doc = setViewers(doc, ['authenticated'])
    expect(doc.access).toEqual({ view: ['authenticated'], grants: [] })
  })
})

describe('deleted roles (D15)', () => {
  const kept = '0196f3a4-2222-7000-8000-000000000001'
  const gone = '0196f3a4-2222-7000-8000-000000000002'
  const source = `query:${queryId}`
  const page = (): PageDocument => {
    const base = addRow(emptyPage('dashboard', 'Kasse'), {
      ...chart('b1'),
      restrictions: [
        { principal: gone, ops: [] },
        { principal: kept, ops: [] },
      ],
    })
    return {
      ...base,
      access: {
        view: ['authenticated', kept, gone] as never,
        grants: [
          { principal: kept, source: source, ops: ['read'] },
          { principal: gone, source: source, ops: ['read'] },
        ],
      },
    }
  }

  it('finds principals that are no known role', () => {
    expect(unknownPrincipals(page(), [kept])).toEqual([gone])
    expect(unknownPrincipals(page(), [kept, gone])).toEqual([])
  })

  it('removes them from viewers, grants and restrictions', () => {
    const clean = withoutPrincipals(page(), [gone])
    expect(clean.access.view).toEqual(['authenticated', kept])
    expect(clean.access.grants.map((grant) => grant.principal)).toEqual([kept])
    expect(clean.rows[0]?.blocks[0]?.restrictions).toEqual([{ principal: kept, ops: [] }])
  })
})

describe('offered rights (§8.2)', () => {
  const tableAccessId = '0196f3a4-3333-7000-8000-000000000001'
  const form = (id: string, mode: 'create' | 'edit'): Block => ({
    id,
    type: 'form',
    title: id,
    restrictions: [],
    source: { kind: 'table', tableAccessId, cacheTtlSeconds: 0 },
    mode,
    ...formDefaults(),
  })
  const record = (id: string): Block => ({
    id,
    type: 'table',
    title: id,
    restrictions: [],
    source: { kind: 'table', tableAccessId, cacheTtlSeconds: 0 },
    bindings: [],
    table: {
      columns: [],
      sort: null,
      searchColumns: [],
      baseFilter: [],
      ...tableConfigDefaults,
      bindings: [],
      pageSize: 50,
    },
  })

  it('offers what the blocks on the source can do, within the ceiling', () => {
    const page = addRow(emptyPage('dashboard', 'Ehrung'), record('b1'))
    expect(offeredOps(page, record('b1'), undefined)).toEqual(['read'])
    // The edited block replaces its saved version and adds its own capability.
    expect(offeredOps(page, form('b2', 'edit'), undefined)).toEqual(['read', 'update'])
    expect(offeredOps(page, form('b2', 'create'), ['read', 'update'])).toEqual(['read'])
    expect(offeredOps(page, form('b1', 'create'), undefined)).toEqual(['create'])
    expect(offeredOps(page, chart('b3'), undefined)).toEqual(['read'])
    expect(offeredOps(page, text('b4'), undefined)).toEqual([])
  })
})
