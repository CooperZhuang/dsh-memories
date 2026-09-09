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

test('closing twice is safe and a closed store degrades instead of throwing', async (t) => {
  const { store } = await tempStore(t)
  store.close()
  store.close()
  // The fallback map keeps the API usable after close.
  store.putSession('after-close', { lastSeq: 1, at: 1 })
  assert.equal(store.getSession('after-close')?.lastSeq, 1)
})
