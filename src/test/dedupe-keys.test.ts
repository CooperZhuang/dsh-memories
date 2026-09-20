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
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
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
  // The predecessor is archived for the same reason a merged loser is: an
  // explicit rewrite is not a better reason to destroy a memory than a guess is.
  assert.deepEqual((await store.listArchived('global', undefined)).map((entry) => entry.id), [first.entry.id])
})

test('Chinese memories are comparable, so a paraphrase is recognised', () => {
  const left = { title: '规格型号比对只比实质内容', body: '去空格、去全半角标点、转大写之后再比较。' }
  const same = { title: '规格型号比较只比实质内容', body: '去空格、去全半角标点、转大写之后再比较。' }
  const other = { title: '未支付轮询分档', body: '未支付订单的轮询改成两档加抖动。' }
  // Splitting CJK on non-letters left a whole sentence as one token, which made
  // every pair of Chinese memories incomparable. Character shingles fix that.
  assert.equal(isNearDuplicate(left, same, 0.7), true)
  assert.equal(isNearDuplicate(left, other, 0.7), false)
})

test('one title is one memory, and the loser is archived rather than deleted', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  store.similarityLimit = () => 0.7

  // Character-for-character identical titles with bodies in different languages:
  // measured on a real store this pair survived for months, because the body
  // check vetoed the merge that the titles were asking for.
  const first = await store.upsert({
    scope: 'global',
    title: '手写摘取规则',
    body: '同形归一必须带左侧词边界，否则机打税号会被抢走。形态闸门不能要求成本中心是固定位数。',
    tags: [],
  }, undefined, 'auto', 1_000)
  const second = await store.upsert({
    scope: 'global',
    title: '手写摘取规则',
    body: 'Lookalike normalization needs a left word boundary, or printed tax ids are hijacked.',
    tags: [],
  }, undefined, 'auto', 2_000, 'handwriting-crop-third')

  assert.notEqual(first.entry.id, second.entry.id, 'two files exist to begin with')
  const listed = await store.list('global', undefined, { fresh: true })
  assert.equal(listed.length, 1, 'one title is one memory')

  // A judgement made without a model's help must be reversible: the loser is
  // archived, so `/memories restore` can bring back a false merge.
  const archived = await store.listArchived('global', undefined)
  assert.equal(archived.length, 1, 'the loser is archived, not destroyed')
})

test('an id that ends in a dash is still addressable', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const created = await store.upsert({
    scope: 'global',
    title: 'Dashed entry',
    body: 'A body.',
    tags: [],
  }, undefined, 'auto', 1_000)

  // A collision suffix can leave a trailing `-`, which slugify strips — so the
  // canonical spelling does not exist and every id-addressed call misses it.
  await rename(join(dir, 'entries', `${created.entry.id}.md`), join(dir, 'entries', `${created.entry.id}-.md`))
  const dashed = `${created.entry.id}-`
  assert.ok(await store.read('global', undefined, dashed) !== undefined, 'the exact file name is found')
  // A rewrite must land in that same file, not beside it: writing `${id}.md`
  // would silently turn an update into a duplicate.
  await store.upsert({
    scope: 'global',
    title: 'Dashed entry renamed',
    body: 'A rewritten body.',
    tags: [],
  }, undefined, 'auto', 2_000, dashed)
  const names = (await readdir(join(dir, 'entries'))).filter((name) => name.endsWith('.md'))
  assert.deepEqual(names, [`${created.entry.id}-.md`], 'one file, updated in place')
  assert.equal(await store.archive('global', undefined, dashed), true, 'and it can be archived')
  assert.equal((await store.list('global', undefined, { fresh: true })).length, 0)
  assert.equal((await store.listArchived('global', undefined)).length, 1)
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

test('a rewrite that omits appliesTo keeps the existing one', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = await store.upsert({
    scope: 'global',
    title: 'Alpha fact',
    body: 'The first body.',
    tags: [],
    appliesTo: '准备推送代码之前',
  }, undefined, 'auto', 1_000)
  assert.equal(first.entry.appliesTo, '准备推送代码之前')

  // A consolidation rewrite often returns only title/body. Dropping the trigger
  // phrase silently removes the field on-demand recall gates on, and nothing
  // downstream can tell that from a deliberate removal.
  const rewritten = await store.upsert({
    scope: 'global',
    title: 'Alpha fact',
    body: 'A sharper body.',
    tags: [],
  }, undefined, 'auto', 2_000, 'alpha-fact')
  assert.equal(rewritten.entry.appliesTo, '准备推送代码之前', 'an omitted appliesTo is carried over')

  const cleared = await store.upsert({
    scope: 'global',
    title: 'Alpha fact',
    body: 'A sharper body still.',
    tags: [],
    appliesTo: '',
  }, undefined, 'auto', 3_000, 'alpha-fact')
  assert.equal(cleared.entry.appliesTo, undefined, 'an explicit empty string removes it')
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
