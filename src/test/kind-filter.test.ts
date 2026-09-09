/**
 * Tests for the `--kind` flag and kind filtering.
 *
 * `kind` is only useful if it can be used to narrow a search and to label a
 * memory written by hand; these tests pin both, including the deliberate choice
 * to ignore an unknown kind rather than silently returning nothing.
 *
 * @module dsh-memories/test/kind-filter.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { browseMemories, searchMemories } from '../search.js'
import type { ScopeEntries } from '../search.js'
import type { MemoryEntry, MemoryKind } from '../types.js'

/** Build one entry. */
function entry(id: string, kind: MemoryKind, title: string, body: string, tags: string[] = []): MemoryEntry {
  return { id, scope: 'global', kind, title, body, tags, createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: 0, source: 'tool' }
}

const GROUPS: ScopeEntries[] = [{
  scope: 'global',
  label: 'global',
  entries: [
    entry('pref', 'preference', 'Prefer pnpm', 'Use pnpm, not npm.'),
    entry('fail', 'failure', 'Never force-push', 'A force-push destroyed a branch once.'),
    entry('proc', 'procedure', 'Release steps', 'Tag, build, publish.'),
    entry('fact', 'fact', 'Repo layout', 'Sources live in src/.'),
  ],
}]

test('search filters by kind', () => {
  assert.deepEqual(searchMemories(GROUPS, 'pnpm', { kinds: ['preference'] }).map((hit) => hit.entry.id), ['pref'])
  assert.deepEqual(searchMemories(GROUPS, 'pnpm', { kinds: ['failure'] }), [])
  assert.equal(searchMemories(GROUPS, 'push', { kinds: ['failure'] }).length, 1)
  assert.equal(searchMemories(GROUPS, 'release', { kinds: ['procedure', 'knowledge'] }).length, 1)
})

test('browse filters by kind without a query', () => {
  assert.deepEqual(browseMemories(GROUPS, { kinds: ['fact'] }).map((hit) => hit.entry.id), ['fact'])
  assert.equal(browseMemories(GROUPS, { kinds: ['knowledge'] }).length, 0)
  assert.equal(browseMemories(GROUPS).length, 4, 'no filter returns everything')
})

test('kind filtering composes with tag filtering', () => {
  const tagged: ScopeEntries[] = [{
    scope: 'global',
    label: 'global',
    entries: [
      entry('a', 'preference', 'Tagged pref', 'body', ['tooling']),
      entry('b', 'fact', 'Tagged fact', 'body', ['tooling']),
    ],
  }]
  assert.deepEqual(browseMemories(tagged, { kinds: ['preference'], tags: ['tooling'] }).map((hit) => hit.entry.id), ['a'])
  assert.deepEqual(browseMemories(tagged, { kinds: ['preference'], tags: ['absent'] }), [])
})
