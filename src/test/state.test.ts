/**
 * Tests for the SQLite-backed operational state.
 *
 * These pin the behaviour the JSON files got wrong: two concurrent writers must
 * not lose each other's update, a job lease must be exclusive, and a store that
 * cannot open the driver must still work in memory.
 *
 * @module dsh-memories/test/state.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore, statePath } from '../state.js'

/** A fresh state store in a temp directory. */
async function tempStore(t: { after: (fn: () => void | Promise<void>) => void }): Promise<{ store: StateStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-state-'))
  const store = new StateStore(statePath(dir))
  t.after(() => {
    store.close()
    return rm(dir, { recursive: true, force: true })
  })
  return { store, dir }
}

test('the state store uses the built-in SQLite driver', async (t) => {
  const { store } = await tempStore(t)
  assert.equal(store.durable, true, 'node:sqlite should be available on this runtime')
  assert.equal(store.degradedReason, undefined)
})

test('the write-ahead log checkpoints far more often than the 1000-page default', async (t) => {
  const { store } = await tempStore(t)
  // The default lets a 143 KB database sit beside a 4 MB WAL. This store is a
  // few writes per pass, so it has no reason to carry a log that large.
  assert.equal(store.walAutocheckpoint, 64)
})

test('watermarks survive a reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-state-reopen-'))
  const first = new StateStore(statePath(dir))
  first.putSession('session-a', { lastSeq: 42, at: 1_000, root: 'C:\\work', contributed: true, activityAt: 2_000 })
  first.close()

  const second = new StateStore(statePath(dir))
  // Close both handles before the directory goes away, or Windows refuses the unlink.
  t.after(() => {
    second.close()
    first.close()
    return rm(dir, { recursive: true, force: true })
  })
  const state = second.getSession('session-a')
  assert.equal(state?.lastSeq, 42)
  assert.equal(state?.root, 'C:\\work')
  assert.equal(state?.contributed, true)
  assert.equal(second.sessionCount(), 1)
})

test('concurrent writers do not lose each other\'s update', async (t) => {
  const { store } = await tempStore(t)
  // The old JSON read-modify-write lost one of these; SQLite serializes them.
  store.putSession('a', { lastSeq: 1, at: 0 })
  store.putSession('b', { lastSeq: 1, at: 0 })
  store.putSession('a', { lastSeq: 2, at: 0 })
  assert.equal(store.getSession('a')?.lastSeq, 2)
  assert.equal(store.getSession('b')?.lastSeq, 1)
  assert.equal(store.sessionCount(), 2)
})

test('touchSession records activity without disturbing the watermark', async (t) => {
  const { store } = await tempStore(t)
  store.putSession('a', { lastSeq: 9, at: 5, contributed: true })
  store.touchSession('a', 77)
  const state = store.getSession('a')
  assert.equal(state?.lastSeq, 9)
  assert.equal(state?.contributed, true)
  assert.equal(state?.activityAt, 77)
  store.touchSession('fresh', 88)
  assert.equal(store.getSession('fresh')?.lastSeq, 0)
})

test('a job lease is exclusive until it expires, and backoff is honoured', async (t) => {
  const { store } = await tempStore(t)
  store.putJob({ key: 'global', enqueuedAt: 0, notBefore: 0, retries: 0 })
  const first = store.claimJob('global', 'worker-1', 1_000, 100)
  assert.equal(first?.lease, 'worker-1')
  // A second worker cannot take a live lease.
  assert.equal(store.claimJob('global', 'worker-2', 1_000, 200), undefined)
  // The same holder may renew it.
  assert.equal(store.claimJob('global', 'worker-1', 1_000, 300)?.lease, 'worker-1')
  // After expiry anyone may take over.
  assert.equal(store.claimJob('global', 'worker-2', 1_000, 2_000)?.lease, 'worker-2')
  // Backoff blocks even an expired lease.
  store.putJob({ key: 'global', enqueuedAt: 0, notBefore: 5_000, retries: 1, leaseUntil: 0 })
  assert.equal(store.claimJob('global', 'worker-3', 1_000, 4_000), undefined)
  assert.equal(store.claimJob('global', 'worker-3', 1_000, 5_000)?.lease, 'worker-3')
})

test('a job can be deleted', async (t) => {
  const { store } = await tempStore(t)
  store.putJob({ key: 'global', enqueuedAt: 0, notBefore: 0, retries: 0 })
  assert.ok(store.getJob('global') !== undefined)
  store.deleteJob('global')
  assert.equal(store.getJob('global'), undefined)
})

test('usage counters accumulate per scope and id', async (t) => {
  const { store } = await tempStore(t)
  assert.deepEqual(store.bumpUsage('global', 'x', 10), { uses: 1, lastUsedAt: 10 })
  assert.deepEqual(store.bumpUsage('global', 'x', 20), { uses: 2, lastUsedAt: 20 })
  assert.deepEqual(store.bumpUsage('project', 'x', 30), { uses: 1, lastUsedAt: 30 })
  assert.deepEqual(store.getUsage('global', 'x'), { uses: 2, lastUsedAt: 20 })
  assert.deepEqual(store.getUsage('project', 'x'), { uses: 1, lastUsedAt: 30 })
  assert.equal(store.listUsage().length, 2)
})

test('a store created before the root column migrates on open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-state-migrate-'))
  // A jobs table in the v1 shape: no `root` column.
  const legacy = new StateStore(statePath(dir))
  legacy.close()
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(statePath(dir))
  raw.exec('DROP TABLE jobs')
  raw.exec('CREATE TABLE jobs (key TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL, not_before INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, last_error TEXT)')
  raw.prepare('INSERT INTO jobs (key, enqueued_at, not_before, retries) VALUES (?, ?, ?, ?)').run('global', 1, 2, 0)
  raw.close()

  const reopened = new StateStore(statePath(dir))
  t.after(() => {
    reopened.close()
    return rm(dir, { recursive: true, force: true })
  })
  // Reading and writing a job must work: without the migration this throws
  // "no such column: root".
  const job = reopened.getJob('global')
  assert.equal(job?.enqueuedAt, 1)
  assert.equal(job?.root, undefined)
  reopened.putJob({ key: 'global', enqueuedAt: 1, notBefore: 2, retries: 0, root: 'C:\\work' })
  assert.equal(reopened.getJob('global')?.root, 'C:\\work')
})

test('closing twice is safe and a closed store degrades instead of throwing', async (t) => {
  const { store } = await tempStore(t)
  store.close()
  store.close()
  // The fallback map keeps the API usable after close.
  store.putSession('after-close', { lastSeq: 1, at: 1 })
  assert.equal(store.getSession('after-close')?.lastSeq, 1)
})

test('surfaced marks are recorded without touching the read counters', async (t) => {
  const { store } = await tempStore(t)
  store.bumpUsage('global', 'x', 10)
  store.bumpSurfaced('global', 'x', 20)
  store.bumpSurfaced('global', 'x', 30)
  // Surfacing is a weaker signal than a read: it must not inflate `uses`.
  assert.deepEqual(store.getUsage('global', 'x'), { uses: 1, lastUsedAt: 10 })
  const row = store.retentionRows().find((candidate) => candidate.id === 'x')
  assert.equal(row?.surfacedAt, 30)
  assert.equal(row?.consolidatedAt, 0)
})

test('a review mark is per entry and survives alongside usage', async (t) => {
  const { store } = await tempStore(t)
  store.bumpUsage('global', 'a', 5)
  store.bumpSurfaced('global', 'a', 7)
  store.markConsolidated([{ scope: 'global', id: 'a' }, { scope: 'project', id: 'b' }], 99)
  const rows = store.retentionRows()
  const global = rows.find((candidate) => candidate.scope === 'global' && candidate.id === 'a')
  const project = rows.find((candidate) => candidate.scope === 'project' && candidate.id === 'b')
  assert.deepEqual(
    { uses: global?.uses, lastUsedAt: global?.lastUsedAt, surfacedAt: global?.surfacedAt, consolidatedAt: global?.consolidatedAt },
    { uses: 1, lastUsedAt: 5, surfacedAt: 7, consolidatedAt: 99 },
  )
  assert.equal(project?.consolidatedAt, 99)
})

test('bookkeeping values and per-session switches survive a reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-state-meta-'))
  const first = new StateStore(statePath(dir))
  first.putMeta('sweep-at', '1234')
  first.setSessionMode('session-a', 'off')
  first.close()

  const second = new StateStore(statePath(dir))
  t.after(() => {
    second.close()
    first.close()
    return rm(dir, { recursive: true, force: true })
  })
  assert.equal(second.getMeta('sweep-at'), '1234')
  assert.equal(second.getMeta('never-written'), undefined)
  assert.equal(second.getSessionMode('session-a'), 'off')
  assert.equal(second.getSessionMode('session-b'), 'on', 'memory is on unless it was turned off')
  second.setSessionMode('session-a', 'on')
  assert.equal(second.getSessionMode('session-a'), 'on')
  // The switch is a column on the watermark row, so it must not disturb it.
  assert.equal(second.getSession('session-a')?.lastSeq, 0)
})

test('a store created before the retention columns migrates on open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-state-usage-migrate-'))
  const legacy = new StateStore(statePath(dir))
  legacy.close()
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(statePath(dir))
  raw.exec('DROP TABLE usage')
  raw.exec('DROP TABLE sessions')
  raw.exec('CREATE TABLE usage (scope TEXT NOT NULL, id TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, id))')
  raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0, root TEXT, contributed INTEGER NOT NULL DEFAULT 0, activity_at INTEGER NOT NULL DEFAULT 0)')
  raw.close()

  const reopened = new StateStore(statePath(dir))
  t.after(() => {
    reopened.close()
    return rm(dir, { recursive: true, force: true })
  })
  // Each of these names a column the old table did not have.
  reopened.bumpSurfaced('global', 'x', 1)
  reopened.markConsolidated([{ scope: 'global', id: 'x' }], 2)
  assert.equal(reopened.retentionRows()[0]?.consolidatedAt, 2)
  assert.equal(reopened.getSessionMode('nobody'), 'on')
})

test('minedCount separates mined sessions from merely tracked ones', async (t) => {
  const { store } = await tempStore(t)
  store.touchSession('touched', 5)
  store.setSessionMode('switched', 'off')
  store.putSession('mined', { lastSeq: 7, at: 6, contributed: true })
  assert.equal(store.sessionCount(), 3, 'every row counts as tracked')
  assert.equal(store.minedCount(), 1, 'only the session with a watermark was mined')
})
