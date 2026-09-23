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
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { MemoryStore, formatEntry, parseEntry, projectSlug, slugify } from '../storage.js'
import { browseMemories, scoreEntry, searchMemories } from '../search.js'
import { rankForSummary, renderMemorySummary, selectForSummary } from '../render.js'
import { DEFAULT_MAX_SUMMARY_BYTES, consolidationRouteOf, normalizeSettings, readTunables, resolveConfig } from '../config.js'
import { name } from '../index.js'
import { MEMORY_SOURCE_KIND } from '../types.js'
import { findProjectRoot, isWithin } from '../workspace.js'
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
  return { kind: 'fact', tags: [], keys: [], createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: 0, lastSurfacedAt: 0, source: 'tool', ...partial }
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

test('an entry records the session it came from, and keeps it across a rewrite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-provenance-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new MemoryStore(dir)
  await store.upsert({ scope: 'global', title: 'Ship with pnpm', body: 'Run pnpm run ship.', tags: [], sourceSession: 'session-42' }, undefined, 'auto')
  const stored = await store.read('global', undefined, 'ship-with-pnpm')
  assert.equal(stored?.sourceSession, 'session-42')
  assert.match(await readFile(join(dir, 'entries', 'ship-with-pnpm.md'), 'utf8'), /^session: session-42$/mu)

  // A consolidation rewrites the body without naming the session; provenance is
  // not the rewriter's to drop.
  await store.upsert({ scope: 'global', title: 'Ship with pnpm', body: 'Always run pnpm run ship.', tags: [] }, undefined, 'auto')
  assert.equal((await store.read('global', undefined, 'ship-with-pnpm'))?.sourceSession, 'session-42')
})

test('session evidence notes round-trip, including text a plain YAML scalar would break', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-notes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new MemoryStore(dir)
  const path = await store.writeSessionNote({
    session: 'session-1',
    at: 1_700_000_000_000,
    project: 'project:demo',
    summary: 'The user wrote: ship with pnpm run ship.',
    memories: ['ship-with-pnpm', 'prefer-pnpm'],
  })
  assert.equal(path, join(dir, 'sessions', 'session-1.md'))
  const note = await store.readSessionNote('session-1')
  assert.equal(note?.session, 'session-1')
  assert.equal(note?.project, 'project:demo')
  assert.equal(note?.summary, 'The user wrote: ship with pnpm run ship.')
  assert.deepEqual(note?.memories, ['ship-with-pnpm', 'prefer-pnpm'])
  assert.equal(note?.at, 1_700_000_000_000)
  assert.deepEqual(await store.listSessionNotes(), ['session-1'])
  assert.equal(await store.readSessionNote('never-mined'), undefined)
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

test('being listed in the summary does not renew an entry against a newer one', () => {
  const now = 1_000_000_000_000
  const DAY_MS = 86_400_000
  // The incumbent was read twice and is being listed right now, but nobody has
  // touched it in 200 days. Counting the listing as attention would pin its
  // recency at "now" and keep it ahead of everything written afterwards.
  const listed = entry({
    id: 'listed', scope: 'global', title: 'Listed', body: 'long-standing',
    updatedAt: now - 200 * DAY_MS, lastUsedAt: now - 200 * DAY_MS, lastSurfacedAt: now, uses: 2,
  })
  const fresh = entry({ id: 'fresh', scope: 'global', title: 'Fresh', body: 'written just now', updatedAt: now })
  assert.deepEqual(rankForSummary([listed, fresh], now).map((value) => value.id), ['fresh', 'listed'])
})

test('a saturated scope still lists a never-surfaced entry that ranking would drop', () => {
  const now = 1_000_000_000_000
  const incumbents = Array.from({ length: 20 }, (_, index) => entry({
    id: `old-${index}`, scope: 'global', title: `Old ${index}`, body: 'been here a while',
    updatedAt: now - 86_400_000, lastUsedAt: now, lastSurfacedAt: now, uses: 6,
  }))
  const correction = entry({
    id: 'correction', scope: 'global', title: 'The correction', body: 'this replaces one of them',
    updatedAt: now, source: 'tool',
  })
  const entries = [...incumbents, correction]

  const ranked = rankForSummary(entries, now)
  assert.ok(!ranked.slice(0, 12).some((value) => value.id === 'correction'),
    'the ranking alone keeps the correction out, which is the failure being fixed')
  assert.ok(ranked.findIndex((value) => value.id === 'correction') >= 12, 'and it sits below the cut')

  const selected = selectForSummary(entries, 12, { freshSlots: 2, now })
  assert.equal(selected.length, 12)
  assert.equal(selected[0]?.id, 'correction', 'a reserved entry comes first so byte pressure cannot drop it')
  assert.ok(selected.some((value) => value.id === 'correction'), 'the reserved slot lets it in exactly once')

  // Zero slots restores pure ranking, so the knob is what does the work.
  assert.ok(!selectForSummary(entries, 12, { freshSlots: 0, now }).some((value) => value.id === 'correction'))
})

test('reserved slots prefer an explicit write and never take the whole list', () => {
  const now = 1_000_000_000_000
  const unseen = Array.from({ length: 15 }, (_, index) => entry({
    id: `auto-${index}`, scope: 'global', title: `Extracted ${index}`, body: 'guessed',
    updatedAt: now - index * 1_000, source: 'auto',
  }))
  const explicit = entry({
    id: 'explicit', scope: 'global', title: 'A person said so', body: 'authoritative',
    updatedAt: now - 86_400_000, source: 'user',
  })
  const incumbents = Array.from({ length: 20 }, (_, index) => entry({
    id: `old-${index}`, scope: 'global', title: `Old ${index}`, body: 'been here a while',
    updatedAt: now, lastUsedAt: now, lastSurfacedAt: now, uses: 6,
  }))
  const selected = selectForSummary([...incumbents, ...unseen, explicit], 12, { freshSlots: 2, now })
  assert.equal(selected.length, 12)
  assert.ok(selected.some((value) => value.id === 'explicit'), 'the explicit write wins the reservation')
  assert.ok(selected.some((value) => value.id === 'auto-0'), 'the second slot goes to the newest extracted entry')
  assert.ok(selected.filter((value) => value.uses === 0).length < 12, 'the reservation does not take the whole list')
})

test('a reserved slot prefers a never-surfaced entry this conversation names', () => {
  const now = 1_000_000_000_000
  const incumbents = Array.from({ length: 20 }, (_, index) => entry({
    id: `old-${index}`, scope: 'global', title: `Old ${index}`, body: 'generic history',
    updatedAt: now, lastUsedAt: now, lastSurfacedAt: now, uses: 6,
  }))
  // The newest unseen entry shares nothing with the turn; an older one is about it.
  const newest = entry({
    id: 'newest', scope: 'global', title: 'Unrelated fresh note', body: 'nothing to do with it',
    updatedAt: now, source: 'auto',
  })
  const relevant = entry({
    id: 'relevant', scope: 'global', title: '发票 OCR 手写字段补摘', body: '按版面语义抽字段，不要用首个正则命中',
    updatedAt: now - 86_400_000, source: 'auto',
  })
  // Without the topical step the reserved slot went to the newest entry, which is
  // how every measured scope spent one of four global slots on something the
  // session could not use.
  const blind = selectForSummary([...incumbents, newest, relevant], 5, { freshSlots: 1, now })
  assert.ok(blind.some((value) => value.id === 'newest'), 'newest wins when there is no topic signal')
  const topical = selectForSummary([...incumbents, newest, relevant], 5, { freshSlots: 1, now, query: '发票手写字段怎么补摘' })
  assert.ok(topical.some((value) => value.id === 'relevant'), 'the named entry takes the reserved slot')
})

test('every entry is listed when a scope fits, and nothing is listed at zero', () => {
  const now = 1_000_000_000_000
  const entries = [
    entry({ id: 'a', scope: 'global', title: 'A', body: 'x', updatedAt: now }),
    entry({ id: 'b', scope: 'global', title: 'B', body: 'y', updatedAt: now - 1 }),
  ]
  assert.deepEqual(selectForSummary(entries, 5, { freshSlots: 2, now }).map((value) => value.id), ['a', 'b'])
  assert.deepEqual(selectForSummary(entries, 0, { freshSlots: 2, now }), [])
})

test('a pinned memory is listed even when the ranking would leave it out', () => {
  const now = 1_000_000_000_000
  const incumbents = Array.from({ length: 20 }, (_, index) => entry({
    id: `old-${index}`, scope: 'global', title: `Old ${index}`, body: 'well read history',
    updatedAt: now, lastUsedAt: now, lastSurfacedAt: now, uses: 6,
  }))
  const rule = entry({
    id: 'the-rule', scope: 'global', title: 'Never break the prompt cache', body: 'only append',
    updatedAt: now - 400 * 86_400_000, pinned: true, uses: 0,
  })
  const ranked = rankForSummary([...incumbents, rule], now)
  assert.ok(ranked.findIndex((value) => value.id === 'the-rule') >= 5, 'the ranking alone keeps it out')
  const selected = selectForSummary([...incumbents, rule], 5, { freshSlots: 0, now })
  assert.equal(selected[0]?.id, 'the-rule', 'a pin is chosen before the ranking and before the fresh slots')
})

test('pins compete only with each other, so they cannot take the whole list', () => {
  const now = 1_000_000_000_000
  const pinned = Array.from({ length: 9 }, (_, index) => entry({
    id: `pin-${index}`, scope: 'global', title: `Pin ${index}`, body: 'pinned', updatedAt: now - index * 1_000, pinned: true,
  }))
  const selected = selectForSummary(pinned, 4, { freshSlots: 1, now })
  assert.equal(selected.length, 4, 'the cap still bounds the section')
  assert.ok(selected.every((value) => value.pinned === true))
})

test('a pinned entry survives the kind grouping, which would otherwise drop it', () => {
  const now = 1_000_000_000_000
  const overview = entry({
    id: 'overview', scope: 'project', kind: 'fact', title: '项目概览：本仓库',
    body: '这是一个很长的概览正文，用来把预算吃掉一部分。'.repeat(6), pinned: true, updatedAt: now,
  })
  const others = Array.from({ length: 12 }, (_, index) => entry({
    id: `pref-${index}`, scope: 'project', kind: 'preference', title: `约定 ${index}`,
    body: '一条偏好。'.repeat(20), updatedAt: now - index,
  }))
  const text = renderMemorySummary([{
    label: 'project',
    heading: 'Project memories',
    entries: selectForSummary([...others, overview], 12, { freshSlots: 0, now }),
    total: others.length + 1,
  }], { maxBytes: 1_400, maxEntriesPerScope: 12 })
  assert.ok(text !== undefined)
  // Facts render last and the budget drops from the end: before the fix the
  // pinned overview was exactly the bullet that disappeared.
  assert.match(text, /📌 项目概览：本仓库/u, 'a pinned bullet is rendered first and cannot be cut')
})

test('a summary note is carried inside the byte budget', () => {
  const scopes = [{
    label: 'global',
    heading: 'Global memories',
    total: 2,
    entries: [
      entry({ id: 'a', scope: 'global', title: 'A', body: 'x' }),
      entry({ id: 'b', scope: 'global', title: 'B', body: 'y' }),
    ],
  }]
  const note = 'Pending skill drafts (2): promote-me, discard-me — promote with /memories promote <name>.'
  const text = renderMemorySummary(scopes, { maxBytes: 4_000, maxEntriesPerScope: 10, note })
  assert.ok(text !== undefined)
  assert.match(text, /Pending skill drafts \(2\)/u)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 4_000)
  // Even a budget that suits only the frame keeps the note inside it.
  const tight = renderMemorySummary(scopes, { maxBytes: 700, maxEntriesPerScope: 10, note })
  assert.ok(tight !== undefined)
  assert.ok(Buffer.byteLength(tight, 'utf8') <= 700)
})

test('isWithin treats a directory as inside itself and ignores case on Windows', () => {
  const parent = process.platform === 'win32' ? 'C:\\Code\\Alpha' : '/code/alpha'
  const child = join(parent, 'sub', 'deep')
  assert.equal(isWithin(parent, parent), true)
  assert.equal(isWithin(parent, child), true)
  assert.equal(isWithin(child, parent), false)
  const sibling = process.platform === 'win32' ? 'C:\\Code\\Alphabet' : '/code/alphabet'
  assert.equal(isWithin(parent, sibling), false, 'a shared prefix is not containment')
  if (process.platform === 'win32') assert.equal(isWithin(parent, 'c:\\code\\alpha\\sub'), true)
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

test('entry config resolves paths, clamps tunables, and reads live references', () => {
  const resolved = resolveConfig({ dshHome: 'C:\\home', maxSummaryBytes: -5, autoExtractIdleMs: 10, extractProvider: 'p', extractModel: 'm' })
  assert.equal(resolved.memoriesDir, 'C:\\home/memories')
  assert.equal(resolved.tunables.maxSummaryBytes, 0)
  assert.equal(resolved.tunables.autoExtractIdleMs, 1000)
  assert.equal(resolved.tunables.extractProvider, 'p')
  // A lone provider is not a route: both halves are required.
  assert.equal(resolveConfig({ extractProvider: 'p' }).tunables.extractModel, '')
  // A mounted row hands the tunables over as live references, not values; the
  // same resolution has to see straight through them.
  const mounted = resolveConfig({ maxSummaryBytes: createVolatile(8192), autoExtract: createVolatile(false) })
  assert.equal(mounted.tunables.maxSummaryBytes, 8192)
  assert.equal(mounted.tunables.autoExtract, false)
  // And re-reading follows the reference, which is what makes a settings write
  // take effect without a restart.
  const reference = createVolatile(8192)
  const live = { maxSummaryBytes: reference }
  assert.equal(readTunables(live).maxSummaryBytes, 8192)
  updateVolatile(reference, createVolatile(1024))
  assert.equal(readTunables(live).maxSummaryBytes, 1024)
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

test('injected context carries a producer-owned source kind', () => {
  // Durable session format v4 refuses the retired `{ kind: 'plugin', plugin }`
  // wrapper on write, so every message this plugin injects has to name its
  // producer. The platform's own v3→v4 migration derives `plugin:<name>` from
  // that wrapper, which is why the two spellings must agree: a session resumed
  // from an older log has to recognise the block it already carries, or the
  // summary is injected a second time.
  assert.equal(MEMORY_SOURCE_KIND, `plugin:${name}`)
  assert.notEqual(MEMORY_SOURCE_KIND, 'plugin')
})
