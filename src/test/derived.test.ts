/**
 * Tests for the merge trail: which entries a memory was built from.
 *
 * The property that matters is that the trail survives — a consolidation that
 * folds three memories into one archives the sources, so the list on the
 * survivor is the only record of what it replaced. Everything here checks that
 * the list is written, carried through rewrites, and never allowed to name an
 * id nobody can open.
 *
 * @module dsh-memories/test/derived.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore, formatEntry, parseEntry } from '../storage.js'
import { parsePlan } from '../consolidate.js'
import type { MemoryEntry } from '../types.js'

/** Create a temporary memories directory. */
async function tempStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-derived-'))
  return { store: new MemoryStore(dir), dir }
}

/** One entry with every required field. */
function entry(extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'merged',
    scope: 'global',
    kind: 'fact',
    title: '合并后的记忆',
    body: '三条记忆合并成的一条。',
    tags: [],
    keys: [],
    createdAt: 1,
    updatedAt: 1,
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...extra,
  }
}

test('the merge trail round-trips through the file format', () => {
  const text = formatEntry(entry({ derivedFrom: ['alpha', 'beta'] }))
  assert.match(text, /^derivedFrom: alpha, beta$/mu)
  const parsed = parseEntry(text, 'global', 'merged')
  assert.deepEqual(parsed?.derivedFrom, ['alpha', 'beta'])
})

test('an entry with no merge trail carries no field and parses without one', () => {
  const text = formatEntry(entry())
  assert.ok(!text.includes('derivedFrom'))
  assert.equal(parseEntry(text, 'global', 'merged')?.derivedFrom, undefined)
})

test('a rewrite keeps the trail it was given and gains the entry it supersedes', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', title: '甲', body: '第一条。', tags: [], keys: [] }, undefined, 'auto')
    await store.upsert({ scope: 'global', title: '乙', body: '第二条。', tags: [], keys: [] }, undefined, 'auto')
    const first = await store.upsert(
      { scope: 'global', title: '合并后的记忆', body: '甲和乙合起来。', tags: [], keys: [], derivedFrom: ['乙'] },
      undefined,
      'auto',
    )
    assert.deepEqual(first.entry.derivedFrom, ['乙'], 'an explicit trail is stored')
    const kept = first.entry.id

    // A later rewrite that says nothing about provenance must not erase it.
    const second = await store.upsert(
      { scope: 'global', title: '合并后的记忆', body: '甲和乙合成的，措辞更紧。', tags: [], keys: [] },
      undefined,
      'auto',
      Date.now(),
      kept,
    )
    assert.deepEqual(second.entry.derivedFrom, ['乙'], 'the trail survives a rewrite that omits it')

    // A supersede is itself evidence: the entry it replaces was one of its sources.
    const third = await store.upsert(
      { scope: 'global', title: '合并后的记忆', body: '再次改写。', tags: [], keys: [], supersedes: '甲' },
      undefined,
      'auto',
      Date.now(),
      kept,
    )
    assert.deepEqual(third.entry.derivedFrom, ['乙', '甲'])
    assert.ok(!third.entry.derivedFrom?.includes(kept), 'an entry is never its own source')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the plan parser keeps only ids the store can resolve, and never the entry itself', () => {
  const known = new Set(['alpha', 'beta', 'merged'])
  const reply = JSON.stringify({
    memories: [{
      id: 'merged',
      scope: 'global',
      kind: 'fact',
      title: '合并后的记忆',
      body: '内容。',
      appliesTo: '任何时候',
      derivedFrom: ['alpha', 'alpha', 'ghost', 'merged', 'beta'],
    }],
    retire: ['alpha', 'beta'],
    notes: 'merged',
  })
  const plan = parsePlan(reply, known, 10)
  assert.ok(plan !== undefined)
  assert.deepEqual(plan.upserts[0]?.derivedFrom, ['alpha', 'beta'])
})

test('a plan with no derivedFrom leaves the field off entirely', () => {
  const reply = JSON.stringify({
    memories: [{ id: null, scope: 'global', kind: 'fact', title: '新条目', body: '内容。', appliesTo: '任何时候' }],
    notes: 'added',
  })
  const plan = parsePlan(reply, new Set(['alpha']), 10)
  assert.ok(plan !== undefined)
  assert.equal(plan.upserts[0]?.derivedFrom, undefined)
})

test('a merge trail naming only unknown ids is dropped rather than stored as a dead reference', () => {
  const reply = JSON.stringify({
    memories: [{ id: 'merged', scope: 'global', kind: 'fact', title: '合并后的记忆', body: '内容。', appliesTo: '任何时候', derivedFrom: ['ghost'] }],
    notes: 'merged',
  })
  const plan = parsePlan(reply, new Set(['merged']), 10)
  assert.ok(plan !== undefined)
  assert.equal(plan.upserts[0]?.derivedFrom, undefined)
})
