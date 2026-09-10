/**
 * Tests for deterministic retention.
 *
 * These pin the rule that makes "unused memories eventually archive" true: age
 * is measured from the last time an entry was read, surfaced, or written by a
 * person — never from a consolidation rewrite — and a memory somebody typed is
 * never chosen at all.
 *
 * @module dsh-memories/test/retention.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { lastAttention, planRetention, retentionKey } from '../retention.js'
import type { MemoryEntry, RetentionRow } from '../types.js'

/** One day in milliseconds. */
const DAY = 86_400_000

/** A clock far enough from the epoch that ages read naturally. */
const NOW = 10_000 * DAY

/** Build one entry from the fields a case cares about. */
function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id'>): MemoryEntry {
  return {
    scope: 'global',
    kind: 'fact',
    title: partial.id,
    body: 'body',
    tags: [],
    keys: [],
    createdAt: 0,
    updatedAt: 0,
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...partial,
  }
}

/** Build one usage row. */
function row(partial: Partial<RetentionRow> & Pick<RetentionRow, 'id'>): RetentionRow {
  return { scope: 'global', uses: 0, lastUsedAt: 0, surfacedAt: 0, consolidatedAt: 0, ...partial }
}

test('an entry unused past the limit is archived, and its age is reported', () => {
  const decisions = planRetention([entry({ id: 'old', createdAt: NOW - 100 * DAY })], [], { maxUnusedDays: 90, now: NOW })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.id, 'old')
  assert.equal(Math.round(decisions[0]?.ageDays ?? 0), 100)
})

test('an entry exactly at the limit is kept', () => {
  assert.deepEqual(planRetention([entry({ id: 'edge', createdAt: NOW - 90 * DAY })], [], { maxUnusedDays: 90, now: NOW }), [])
})

test('the state database can protect an entry the file says was never read', () => {
  const entries = [entry({ id: 'read', createdAt: NOW - 400 * DAY })]
  // The file predates the read, or a concurrent session has the newer counter;
  // either way the state database is the authority.
  const rows = [row({ id: 'read', uses: 3, lastUsedAt: NOW - 10 * DAY })]
  assert.deepEqual(planRetention(entries, rows, { maxUnusedDays: 90, now: NOW }), [])
})

test('being surfaced counts as attention, so a memory read out of the summary survives', () => {
  const entries = [entry({ id: 'surfaced', createdAt: NOW - 200 * DAY, lastSurfacedAt: NOW - 2 * DAY })]
  assert.deepEqual(planRetention(entries, [], { maxUnusedDays: 90, now: NOW }), [])
})

test('a consolidation rewrite is not attention: a memory cannot be kept alive by rewriting it', () => {
  const entries = [entry({ id: 'rewritten', createdAt: NOW - 300 * DAY, updatedAt: NOW })]
  const decisions = planRetention(entries, [], { maxUnusedDays: 90, now: NOW })
  assert.deepEqual(decisions.map((decision) => decision.id), ['rewritten'])
})

test('a memory a person wrote is never chosen, and 0 disables retention', () => {
  const handwritten = [entry({ id: 'handwritten', createdAt: NOW - 900 * DAY, source: 'user' })]
  assert.deepEqual(planRetention(handwritten, [], { maxUnusedDays: 90, now: NOW }), [])
  const stale = [entry({ id: 'stale', createdAt: 0 })]
  assert.deepEqual(planRetention(stale, [], { maxUnusedDays: 0, now: NOW }), [])
})

test('the longest-unused entry is chosen first', () => {
  const decisions = planRetention([
    entry({ id: 'recent', createdAt: NOW - 100 * DAY }),
    entry({ id: 'ancient', createdAt: NOW - 500 * DAY }),
  ], [], { maxUnusedDays: 90, now: NOW })
  assert.deepEqual(decisions.map((decision) => decision.id), ['ancient', 'recent'])
})

test('usage rows are joined per scope, so another workspace cannot protect an entry', () => {
  const entries = [entry({ id: 'shared', scope: 'project', createdAt: NOW - 400 * DAY })]
  const rows = [row({ id: 'shared', scope: 'global', uses: 5, lastUsedAt: NOW })]
  assert.equal(planRetention(entries, rows, { maxUnusedDays: 90, now: NOW }).length, 1)
})

test('lastAttention takes the newest signal from either view', () => {
  const value = entry({ id: 'x', createdAt: 5, lastUsedAt: 10 })
  assert.equal(lastAttention(value, undefined), 10)
  assert.equal(lastAttention(value, row({ id: 'x', surfacedAt: 42 })), 42)
  assert.equal(retentionKey('project', 'x'), 'project\u0000x')
})
