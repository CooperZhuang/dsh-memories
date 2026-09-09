/**
 * Unit tests for the memory store, search, and rendering layers.
 *
 * @module dsh-memories/test/storage.test
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore, formatEntry, parseEntry, projectSlug, slugify } from '../storage.js'
import { browseMemories, scoreEntry, searchMemories } from '../search.js'
import { rankForSummary, renderMemorySummary } from '../render.js'
import { DEFAULT_MAX_SUMMARY_BYTES, normalizeSettings, resolveConfig } from '../config.js'
import { findProjectRoot } from '../workspace.js'
import type { MemoryEntry } from '../types.js'

/** Create a temporary memories directory. */
async function tempStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-'))
  return { store: new MemoryStore(dir), dir }
}

test('slugify produces stable ids and falls back for empty input', () => {
  assert.equal(slugify('Use pnpm, not npm!'), 'use-pnpm-not-npm')
  assert.equal(slugify('   '), 'memory')
  assert.equal(slugify('中文 记忆'), '中文-记忆')
})

test('projectSlug is stable per root and distinct across roots', () => {
  const a = projectSlug('C:\\Code\\alpha')
  const b = projectSlug('C:\\Code\\beta')
  assert.equal(a, projectSlug('C:\\Code\\alpha'))
  assert.notEqual(a, b)
  assert.match(a, /^alpha-[0-9a-f]{8}$/u)
})

/** Build a complete entry from the fields a test cares about. */
function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'scope' | 'title' | 'body'>): MemoryEntry {
  return { tags: [], createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: 0, source: 'tool', ...partial }
}

test('entry files round-trip through format and parse', () => {
  const value = entry({
    id: 'prefer-pnpm',
    scope: 'global',
    title: 'Prefer pnpm',
    body: 'The user standardizes on pnpm; do not run npm install.',
    tags: ['tooling', 'packages'],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    uses: 4,
    lastUsedAt: 1_700_000_200_000,
  })
  const parsed = parseEntry(formatEntry(value), 'global', 'fallback')
  assert.deepEqual(parsed, value)
})

test('an entry with no recorded use round-trips its zero counters', () => {
  const value = entry({ id: 'fresh', scope: 'global', title: 'Fresh', body: 'Never read yet.' })
  const parsed = parseEntry(formatEntry(value), 'global', 'fallback')
  assert.equal(parsed?.uses, 0)
  assert.equal(parsed?.lastUsedAt, 0)
})

test('parseEntry rejects a non-entry file instead of throwing', () => {
  assert.equal(parseEntry('just prose', 'global', 'x'), undefined)
  assert.equal(parseEntry('---\nscope: global\n---\n\nbody', 'global', 'x'), undefined)
})

test('upsert creates, then updates in place on the same title', async () => {
  const { store, dir } = await tempStore()
  try {
    const first = await store.upsert({ scope: 'global', title: 'Build with pnpm', body: 'Use pnpm build.', tags: ['build'] }, undefined, 'tool', 1_000)
    assert.equal(first.action, 'created')
    const second = await store.upsert({ scope: 'global', title: 'Build with pnpm', body: 'Use pnpm run build.', tags: ['build', 'tooling'] }, undefined, 'auto', 2_000)
    assert.equal(second.action, 'updated')
    assert.equal(second.entry.createdAt, 1_000)
    assert.equal(second.entry.updatedAt, 2_000)
    const listed = await store.list('global', undefined, { fresh: true })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.body, 'Use pnpm run build.')
    assert.deepEqual([...listed[0]!.tags], ['build', 'tooling'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('project and global scopes stay isolated and both survive a restart', async () => {
  const { store, dir } = await tempStore()
  try {
    const root = 'C:\\Code\\alpha'
    await store.upsert({ scope: 'global', title: 'Global fact', body: 'Applies everywhere.', tags: [] }, undefined, 'tool', 1)
    await store.upsert({ scope: 'project', title: 'Project fact', body: 'Only for alpha.', tags: [] }, root, 'tool', 2)
    const reopened = new MemoryStore(dir)
    assert.deepEqual((await reopened.list('global', undefined, { fresh: true })).map((entry) => entry.title), ['Global fact'])
    assert.deepEqual((await reopened.list('project', root, { fresh: true })).map((entry) => entry.title), ['Project fact'])
    assert.deepEqual(await reopened.list('project', 'C:\\Code\\beta', { fresh: true }), [])
    const descriptor = await reopened.readProjectDescriptor(projectSlug(root))
    assert.equal(descriptor?.root, root)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupted entry file does not break the scope', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', title: 'Good', body: 'ok', tags: [] }, undefined, 'tool', 1)
    await writeFile(join(dir, 'entries', 'broken.md'), 'not an entry\n', 'utf8')
    const listed = await store.list('global', undefined, { fresh: true })
    assert.deepEqual(listed.map((entry) => entry.title), ['Good'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the index file is rewritten and stays readable', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', title: 'Indexed', body: 'body', tags: ['x'] }, undefined, 'tool', 5)
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { count: number; entries: { title: string }[] }
    assert.equal(index.count, 1)
    assert.equal(index.entries[0]?.title, 'Indexed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the same memory under a different title collapses instead of duplicating', async () => {
  const { store, dir } = await tempStore()
  try {
    const first = await store.upsert({ scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm, not npm.', tags: [] }, undefined, 'tool', 1_000)
    // A re-worded title that contains the original one, same body: the older
    // entry is retired on the next load.
    const second = await store.upsert({ scope: 'global', title: 'Prefer pnpm in this repo', body: 'Use pnpm, not npm.', tags: [] }, undefined, 'auto', 2_000)
    assert.notEqual(first.entry.id, second.entry.id)
    const listed = await store.list('global', undefined, { fresh: true })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, second.entry.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('genuinely distinct memories that share a body are both kept', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', title: 'Alpha rule', body: 'same words', tags: [] }, undefined, 'tool', 1_000)
    await store.upsert({ scope: 'global', title: 'Beta rule', body: 'same words', tags: [] }, undefined, 'tool', 2_000)
    const listed = await store.list('global', undefined, { fresh: true })
    assert.deepEqual(listed.map((entry) => entry.title).sort(), ['Alpha rule', 'Beta rule'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('remove deletes one entry and reports the truth', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', title: 'Temporary', body: 'x', tags: [] }, undefined, 'tool', 1)
    assert.equal(await store.remove('global', undefined, 'temporary'), true)
    assert.equal(await store.remove('global', undefined, 'temporary'), false)
    assert.deepEqual(await store.list('global', undefined, { fresh: true }), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the per-scope cap evicts the least recently updated entries', async () => {
  const { store, dir } = await tempStore()
  try {
    store.entryLimit = () => 2
    for (let index = 0; index < 4; index += 1) {
      await store.upsert({ scope: 'global', title: `Entry ${index}`, body: 'x', tags: [] }, undefined, 'tool', index + 1)
    }
    const listed = await store.list('global', undefined, { fresh: true })
    assert.deepEqual(listed.map((entry) => entry.title), ['Entry 3', 'Entry 2'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('search ranks a title hit above a body hit and honours filters', () => {
  const groups = [{
    scope: 'global' as const,
    label: 'global',
    entries: [
      entry({ id: 'a', scope: 'global', title: 'Use pnpm', body: 'package manager', tags: ['tooling'] }),
      entry({ id: 'b', scope: 'global', title: 'Deployment notes', body: 'we use pnpm to deploy' }),
    ],
  }]
  const hits = searchMemories(groups, 'pnpm')
  assert.equal(hits[0]?.entry.id, 'a')
  assert.ok(scoreEntry(groups[0]!.entries[0]!, 'pnpm') > scoreEntry(groups[0]!.entries[1]!, 'pnpm'))
  assert.equal(searchMemories(groups, 'pnpm', { tags: ['nope'] }).length, 0)
  assert.equal(searchMemories(groups, '').length, 0)
  assert.equal(browseMemories(groups).length, 2)
})

test('summary ranks a frequently used entry above a stale one', () => {
  const now = 1_000_000_000_000
  const stale = entry({ id: 'stale', scope: 'global', title: 'Stale', body: 'old', updatedAt: now - 86_400_000 * 400 })
  const used = entry({ id: 'used', scope: 'global', title: 'Used', body: 'hot', updatedAt: now - 86_400_000 * 400, uses: 6, lastUsedAt: now })
  assert.deepEqual(rankForSummary([stale, used], now).map((value) => value.id), ['used', 'stale'])
})

test('summary renders both scopes and stays inside its byte budget', () => {
  const scopes = [
    {
      label: 'global',
      heading: 'Global memories',
      total: 2,
      entries: [
        entry({ id: 'g1', scope: 'global', title: 'Prefer pnpm', body: 'x'.repeat(400) }),
        entry({ id: 'g2', scope: 'global', title: 'Answer in Chinese', body: 'y'.repeat(400) }),
      ],
    },
    {
      label: 'project:alpha',
      heading: 'Project memories (project:alpha)',
      total: 1,
      entries: [
        entry({ id: 'p1', scope: 'project', title: 'Windows only', body: 'z'.repeat(400) }),
      ],
    },
  ]
  const text = renderMemorySummary(scopes, { maxBytes: 900, maxEntriesPerScope: 12 })
  assert.ok(text !== undefined)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 900)
  assert.match(text, /<memory-context>/u)
  assert.match(text, /Global memories/u)
  assert.match(text, /Project memories/u)
  assert.equal(renderMemorySummary([], { maxBytes: 100, maxEntriesPerScope: 5 }), undefined)
})

test('deployment config resolves paths and clamps legacy tunable spellings', () => {
  const resolved = resolveConfig({ dshHome: 'C:\\home', maxSummaryBytes: -5, autoExtractIdleMs: 10, extractProvider: 'p', extractModel: 'm' })
  assert.equal(resolved.memoriesDir, 'C:\\home/memories')
  assert.equal(resolved.defaults.maxSummaryBytes, 0)
  assert.equal(resolved.defaults.autoExtractIdleMs, 1000)
  assert.equal(resolved.defaults.extractProvider, 'p')
  // A lone provider is not a route: both halves are required.
  assert.equal(resolveConfig({ extractProvider: 'p' }).defaults.extractModel, '')
  // `defaults` wins over the legacy flat spelling.
  assert.equal(resolveConfig({ maxSummaryBytes: 10, defaults: { maxSummaryBytes: 99 } }).defaults.maxSummaryBytes, 99)
})

test('normalizeSettings fills every field and clamps nonsense', () => {
  const settings = normalizeSettings({ autoExtract: false, maxSummaryEntries: -3 })
  assert.equal(settings.autoExtract, false)
  assert.equal(settings.maxSummaryEntries, 1)
  assert.equal(settings.enableTool, true)
  assert.equal(settings.maxSummaryBytes, DEFAULT_MAX_SUMMARY_BYTES)
})

test('findProjectRoot walks up to the marker and falls back to cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memories-root-'))
  try {
    await writeFile(join(root, '.git'), 'gitdir: elsewhere\n', 'utf8')
    const nested = join(root, 'packages', 'app', 'src')
    await mkdir(nested, { recursive: true })
    assert.equal(await findProjectRoot(nested, ['.git']), root)
    const orphan = await mkdtemp(join(tmpdir(), 'dsh-memories-orphan-'))
    try {
      assert.equal(await findProjectRoot(orphan, ['.git']), orphan)
    } finally {
      await rm(orphan, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
