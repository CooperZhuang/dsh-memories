/**
 * Tests for near-duplicate superseding and key expansion.
 *
 * Both exist to keep recall sharp as the store grows: a re-worded lesson must
 * replace its predecessor instead of competing with it, and a memory must be
 * findable by the words a future session would use, not only by the words the
 * extractor happened to write.
 *
 * @module dsh-memories/test/dedupe-keys.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore, isNearDuplicate, normalizeKey, overlap } from '../storage.js'
import { relevanceOf, searchMemories } from '../search.js'
import type { MemoryEntry } from '../types.js'

/** A store and its temporary directory. */
async function tempStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-dedupe-'))
  return { store: new MemoryStore(dir), dir }
}

test('normalizeKey lowercases, drops commas, and caps the length', () => {
  assert.equal(normalizeKey('  Monorepo  '), 'monorepo')
  assert.equal(normalizeKey('pnpm, npm'), 'pnpm npm')
  assert.equal(normalizeKey('x'.repeat(80)).length, 48)
})

test('overlap is the Jaccard ratio and is 0 when either side is empty', () => {
  assert.equal(overlap(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  assert.equal(overlap(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3)
  assert.equal(overlap(new Set(), new Set(['a'])), 0)
})

test('isNearDuplicate needs both halves to agree', () => {
  const title = 'Run tests with node test runner'
  const other = 'Run tests with node test runner'
  assert.equal(isNearDuplicate({ title, body: 'same body' }, { title: other, body: 'same body' }, 0.7), true)
  // A different body is a different lesson that happens to share a name.
  assert.equal(isNearDuplicate({ title, body: 'one body' }, { title: other, body: 'another body entirely' }, 0.7), false)
  // Overlapping but re-worded titles do not reach the threshold.
  assert.equal(isNearDuplicate({ title: 'Prefer pnpm', body: 'same' }, { title: 'Answer in Chinese', body: 'same' }, 0.7), false)
  assert.equal(isNearDuplicate({ title, body: 'same' }, { title: other, body: 'same' }, 0), false)
})

test('a re-worded memory supersedes its predecessor instead of joining it', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  store.similarityLimit = () => 0.7

  const first = await store.upsert({ scope: 'global', title: 'Run tests with node --test', body: 'The suite runs with node --test.', tags: [] }, undefined, 'auto', 1_000)
  const second = await store.upsert({ scope: 'global', title: 'Run tests with node test runner', body: 'The suite runs with node --test.', tags: [] }, undefined, 'auto', 2_000)

  assert.notEqual(first.entry.id, second.entry.id)
  assert.equal(second.entry.supersedes, first.entry.id)
  const listed = await store.list('global', undefined, { fresh: true })
  assert.deepEqual(listed.map((entry) => entry.id), [second.entry.id])
  assert.equal(await store.read('global', undefined, first.entry.id), undefined)
})

test('the near-duplicate rule is off until it is configured', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))

  // The default `similarityLimit` of 0 keeps only the exact-match rule, so two
  // entries that share most of their words but not their whole title both live.
  await store.upsert({ scope: 'global', title: 'Run tests with node --test', body: 'The suite runs with node --test.', tags: [] }, undefined, 'auto', 1_000)
  await store.upsert({ scope: 'global', title: 'Run tests with node test runner', body: 'The suite runs with node --test.', tags: [] }, undefined, 'auto', 2_000)
  const listed = await store.list('global', undefined, { fresh: true })
  assert.equal(listed.length, 2)
})

test('an explicit supersedes still wins over the similarity search', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  store.similarityLimit = () => 0.7
  await store.upsert({ scope: 'global', title: 'Alpha fact', body: 'alpha body', tags: [] }, undefined, 'auto', 1_000)
  await store.upsert({ scope: 'global', title: 'Beta fact', body: 'beta body', tags: [] }, undefined, 'auto', 2_000)
  const third = await store.upsert({ scope: 'global', title: 'Gamma fact', body: 'gamma body', tags: [], supersedes: 'alpha-fact' }, undefined, 'auto', 3_000)
  assert.equal(third.entry.supersedes, 'alpha-fact')
  assert.deepEqual((await store.list('global', undefined, { fresh: true })).map((entry) => entry.id).sort(), ['beta-fact', 'gamma-fact'])
})

test('keys round-trip through the file and are found by search', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const stored = await store.upsert({
    scope: 'global',
    title: 'Prefer pnpm workspaces',
    body: 'The repository is one pnpm workspace with several packages.',
    tags: [],
    keys: ['Monorepo', '  monorepo  ', 'workspace layout'],
  }, undefined, 'auto', 1_000)
  assert.deepEqual([...stored.entry.keys], ['monorepo', 'workspace layout'])

  const file = await readFile(join(dir, 'entries', 'prefer-pnpm-workspaces.md'), 'utf8')
  assert.match(file, /^keys: monorepo, workspace layout$/mu)

  const parsed = await store.read('global', undefined, 'prefer-pnpm-workspaces')
  assert.deepEqual([...parsed?.keys ?? []], ['monorepo', 'workspace layout'])

  // The alias is what a future session would type; it must win the ranking even
  // though the word appears nowhere in the title or body.
  const groups = [{ scope: 'global' as const, label: 'global', entries: [parsed as MemoryEntry] }]
  assert.equal(searchMemories(groups, 'monorepo')[0]?.entry.id, 'prefer-pnpm-workspaces')
  assert.ok(relevanceOf(parsed as MemoryEntry, 'monorepo') > 20, 'the alias clears the relevance floor')
})

test('memories differing only by a single-character token stay separate', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  store.similarityLimit = () => 0.7
  await store.upsert({ scope: 'global', title: 'Old fact 1', body: 'Been here for months.', tags: [] }, undefined, 'auto', 1_000)
  // Dropping one-character tokens would reduce both titles to {old, fact} and
  // make this a duplicate of the first — a merge that deletes a real memory.
  const second = await store.upsert({ scope: 'global', title: 'Old fact 2', body: 'Been here for months.', tags: [] }, undefined, 'auto', 2_000)
  assert.equal(second.entry.supersedes, undefined, 'the digit is what tells the two apart')
  assert.equal((await store.list('global', undefined, { fresh: true })).length, 2)
  assert.equal(isNearDuplicate({ title: 'Old fact 1', body: 'same' }, { title: 'Old fact 2', body: 'same' }, 0.7), false)
})

test('a numbered family of memories is not collapsed by substring containment', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  // "Old fact 19" contains "Old fact 1", and the collision rule deletes its
  // loser, so a raw substring test turned four distinct memories into two.
  for (const title of ['Old fact 1', 'Old fact 19', 'Old fact 190', 'The correction']) {
    await store.upsert({ scope: 'global', title, body: 'Been here for months.', tags: [] }, undefined, 'auto')
  }
  const listed = await store.list('global', undefined, { fresh: true })
  assert.deepEqual(listed.map((entry) => entry.id).sort(), ['old-fact-1', 'old-fact-19', 'old-fact-190', 'the-correction'])
})

test('a longer restatement still collapses into the shorter one', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await store.upsert({ scope: 'global', title: 'Use pnpm', body: 'The repo uses pnpm.', tags: [] }, undefined, 'auto', 1_000)
  await store.upsert({ scope: 'global', title: 'Use pnpm for this repo', body: 'The repo uses pnpm. Never npm.', tags: [] }, undefined, 'auto', 2_000)
  const listed = await store.list('global', undefined, { fresh: true })
  assert.deepEqual(listed.map((entry) => entry.id), ['use-pnpm-for-this-repo'], 'the fuller statement wins and the shorthand goes')
})

test('a rewrite that omits keys keeps the stored ones', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await store.upsert({ scope: 'global', title: 'Ship it', body: 'Run the release.', tags: [], keys: ['deploy'] }, undefined, 'auto', 1_000)
  const updated = await store.upsert({ scope: 'global', title: 'Ship it', body: 'Run the release twice.', tags: [] }, undefined, 'auto', 2_000)
  assert.deepEqual([...updated.entry.keys], ['deploy'])
})
