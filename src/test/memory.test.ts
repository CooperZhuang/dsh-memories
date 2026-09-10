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
import { DEFAULT_MAX_SUMMARY_BYTES, consolidationRouteOf, normalizeSettings, resolveConfig } from '../config.js'
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

test('the consolidation route falls back to the extraction route, then to the session', () => {
  const base = normalizeSettings({})
  assert.deepEqual(consolidationRouteOf(base), {}, 'no route at all reuses the session route')
  assert.deepEqual(
    consolidationRouteOf({ ...base, extractProvider: 'p', extractModel: 'm' }),
    { provider: 'p', model: 'm' },
    'an unset consolidation route inherits extraction',
  )
  assert.deepEqual(
    consolidationRouteOf({ ...base, extractProvider: 'p', extractModel: 'm', consolidateProvider: 'q', consolidateModel: 'n' }),
    { provider: 'q', model: 'n' },
    'its own route wins',
  )
  // A lone half is not a route, exactly like the extraction pair.
  const half = normalizeSettings({ consolidateProvider: 'q' })
  assert.equal(half.consolidateModel, '')
  assert.deepEqual(consolidationRouteOf({ ...half, extractProvider: 'p', extractModel: 'm' }), { provider: 'p', model: 'm' })
})

test('the quota knobs default on and clamp to zero', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.pauseOnQuotaError, true)
  assert.equal(settings.quotaCooldownMinutes, 30)
  assert.equal(settings.quotaCooldownMaxMinutes, 480)
  assert.equal(normalizeSettings({ quotaCooldownMinutes: -5 }).quotaCooldownMinutes, 0)
  assert.equal(normalizeSettings({ pauseOnQuotaError: false }).pauseOnQuotaError, false)
})

/** Build a complete entry from the fields a test cares about. */
function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'scope' | 'title' | 'body'>): MemoryEntry {
  return { kind: 'fact', tags: [], createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: 0, source: 'tool', ...partial }
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

test('kind and appliesTo round-trip, and an entry without them defaults to a fact', () => {
  const value = entry({
    id: 'never-force-push',
    scope: 'global',
    kind: 'preference',
    title: 'Never force-push',
    body: 'Ask before any force-push.',
    appliesTo: 'before running any git push',
  })
  assert.deepEqual(parseEntry(formatEntry(value), 'global', 'fallback'), value)

  // A file written before kinds existed has no `kind:` line: it must parse as a
  // fact rather than being rejected or losing the entry.
  const legacy = [
    '---',
    'id: legacy',
    'scope: global',
    'title: Legacy entry',
    'tags:',
    'created: 2026-01-01T00:00:00.000Z',
    'updated: 2026-01-01T00:00:00.000Z',
    'source: tool',
    'uses: 0',
    'lastUsed: never',
    '---',
    '',
    'Written before kinds existed.',
  ].join('\n')
  const parsed = parseEntry(legacy, 'global', 'legacy')
  assert.equal(parsed?.kind, 'fact')
  assert.equal(parsed?.appliesTo, undefined)
  assert.equal(parsed?.supersedes, undefined)
})

test('an unknown kind value degrades to a fact instead of failing the entry', () => {
  const parsed = parseEntry(formatEntry(entry({ id: 'x', scope: 'global', title: 'X', body: 'y' })).replace('kind: fact', 'kind: nonsense'), 'global', 'x')
  assert.equal(parsed?.kind, 'fact')
})

test('a rewrite that omits the kind keeps the stored one', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', kind: 'preference', title: 'Use pnpm', body: 'Use pnpm.', tags: [] }, undefined, 'tool', 1_000)
    const updated = await store.upsert({ scope: 'global', title: 'Use pnpm', body: 'Use pnpm everywhere.', tags: [] }, undefined, 'auto', 2_000)
    assert.equal(updated.entry.kind, 'preference')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('supersedes retires the entry it replaces', async () => {
  const { store, dir } = await tempStore()
  try {
    await store.upsert({ scope: 'global', title: 'Use npm', body: 'Run npm install.', tags: [] }, undefined, 'tool', 1_000)
    const replacement = await store.upsert({
      scope: 'global',
      title: 'Use pnpm',
      body: 'Run pnpm install.',
      tags: [],
      supersedes: 'use-npm',
    }, undefined, 'auto', 2_000)
    assert.equal(replacement.entry.supersedes, 'use-npm')
    const listed = await store.list('global', undefined, { fresh: true })
    assert.deepEqual(listed.map((item) => item.id), ['use-pnpm'], 'the superseded entry is gone')
    assert.equal(await store.read('global', undefined, 'use-npm'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('supersedes never deletes the entry that carries it, and is scope-local', async () => {
  const { store, dir } = await tempStore()
  try {
    // A self-reference must be a no-op rather than a self-delete.
    const self = await store.upsert({ scope: 'global', title: 'Self', body: 'x', tags: [], supersedes: 'self' }, undefined, 'tool', 1_000)
    assert.equal(self.entry.supersedes, 'self')
    assert.ok(await store.read('global', undefined, 'self') !== undefined)

    // A project entry cannot retire a global one that happens to share an id.
    await store.upsert({ scope: 'global', title: 'Shared', body: 'global', tags: [] }, undefined, 'tool', 2_000)
    await store.upsert({ scope: 'project', title: 'Other', body: 'project', tags: [], supersedes: 'shared' }, dir, 'tool', 3_000)
    assert.ok(await store.read('global', undefined, 'shared') !== undefined, 'the global entry survives')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('the summary groups a scope by kind, actionable kinds first', () => {
  const scopes = [{
    label: 'global',
    heading: 'Global memories',
    total: 3,
    entries: [
      entry({ id: 'f', scope: 'global', kind: 'fact', title: 'A fact', body: 'background' }),
      entry({ id: 'p', scope: 'global', kind: 'preference', title: 'A preference', body: 'follow this' }),
      entry({ id: 'x', scope: 'global', kind: 'failure', title: 'A failure', body: 'avoid this' }),
    ],
  }]
  const text = renderMemorySummary(scopes, { maxBytes: 4_000, maxEntriesPerScope: 10 })
  assert.ok(text !== undefined)
  const preferenceAt = text.indexOf('### Preferences')
  const failureAt = text.indexOf('### Failures to avoid')
  const factAt = text.indexOf('### Facts')
  assert.ok(preferenceAt > 0 && failureAt > 0 && factAt > 0, 'every populated kind gets a heading')
  assert.ok(preferenceAt < failureAt && failureAt < factAt, 'actionable kinds render before plain facts')
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
