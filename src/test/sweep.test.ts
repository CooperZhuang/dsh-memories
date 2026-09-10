/**
 * Tests for the periodic maintenance sweep.
 *
 * Extraction used to be the only thing that ever triggered cleaning, so a store
 * that stopped producing new memories was never cleaned at all. The sweep is
 * driven by its own clock, covers every workspace on disk, and survives a
 * restart through the state database.
 *
 * @module dsh-memories/test/sweep.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { MemoriesConfig } from '../config.js'
import type { Session } from '@deepseek-ai/dsh-session'

/** One day in milliseconds. */
const DAY = 86_400_000

/** A clock far enough from the epoch that ages read naturally. */
const NOW = 10_000 * DAY

/** An hour in milliseconds. */
const HOUR = 3_600_000

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in. */
function stubSession(cwd: string): Session {
  return {
    id: 'test-session',
    header: { version: 0, id: 'test-session', createdAt: 0, cwd, isSeeded: false },
    seq: 1,
    requestHeader: () => undefined,
    deriveMessages: () => [],
  } as unknown as Session
}

/** A runtime over a temp store. */
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, settings: Partial<MemoriesConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-sweep-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, ...settings })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })
  return { dir, runtime }
}

test('the sweep archives unused memories once, then waits for its interval', async (t) => {
  const { runtime } = await fixture(t)
  await runtime.store.upsert({ scope: 'global', title: 'Ancient fact', body: 'x', tags: [] }, undefined, 'auto', NOW - 400 * DAY)

  assert.equal(await runtime.sweepIfDue(NOW), 1)
  assert.deepEqual(await runtime.store.list('global', undefined, { fresh: true }), [])
  assert.deepEqual((await runtime.store.listArchived('global', undefined)).map((entry) => entry.id), ['ancient-fact'])
  assert.equal(runtime.state.getMeta('sweep-at'), String(NOW), 'the interval is recorded')

  // Inside the interval nothing runs, even with more stale material waiting.
  await runtime.store.upsert({ scope: 'global', title: 'Another fact', body: 'x', tags: [] }, undefined, 'auto', NOW - 400 * DAY)
  assert.equal(await runtime.sweepIfDue(NOW + HOUR), 0)
  assert.equal((await runtime.store.list('global', undefined, { fresh: true })).length, 1)

  // Past it, the next sweep collects what the last one skipped.
  assert.equal(await runtime.sweepIfDue(NOW + 13 * HOUR), 1)
})

test('a manual sweep ignores the interval, which is what `/memories sweep` means', async (t) => {
  const { runtime } = await fixture(t)
  await runtime.store.upsert({ scope: 'global', title: 'Ancient fact', body: 'x', tags: [] }, undefined, 'auto', NOW - 400 * DAY)
  assert.equal(await runtime.sweepNow(NOW), 1)
  await runtime.store.upsert({ scope: 'global', title: 'Second fact', body: 'x', tags: [] }, undefined, 'auto', NOW - 400 * DAY)
  assert.equal(await runtime.sweepNow(NOW), 1, 'the interval does not gate a manual sweep')
})

test('the sweep covers every workspace on disk, not only the active one', async (t) => {
  const { runtime } = await fixture(t)
  const root = 'C:\\Code\\alpha'
  await runtime.store.upsert({ scope: 'project', title: 'Stale project fact', body: 'x', tags: [] }, root, 'auto', NOW - 400 * DAY)

  assert.equal(await runtime.sweepIfDue(NOW), 1)
  assert.deepEqual(await runtime.store.list('project', root, { fresh: true }), [])
  assert.deepEqual((await runtime.store.listArchived('project', root)).map((entry) => entry.id), ['stale-project-fact'])
})

test('retention is off when maxUnusedDays is 0', async (t) => {
  const { runtime } = await fixture(t, { maxUnusedDays: 0 })
  await runtime.store.upsert({ scope: 'global', title: 'Ancient fact', body: 'x', tags: [] }, undefined, 'auto', 1)
  assert.equal(await runtime.sweepIfDue(NOW), 0)
  assert.equal((await runtime.store.list('global', undefined, { fresh: true })).length, 1)
})

test('an archived memory can be listed and restored through the runtime', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd())
  await runtime.store.upsert({ scope: 'global', title: 'Ancient fact', body: 'Body text', tags: [] }, undefined, 'auto', NOW - 400 * DAY)
  await runtime.sweepNow(NOW)

  assert.match(await runtime.archived(session, 'global'), /ancient-fact|Ancient fact/u)
  assert.match(await runtime.restore(session, 'ancient-fact'), /Restored ancient-fact into global/u)
  assert.equal((await runtime.store.list('global', undefined, { fresh: true })).length, 1)
  assert.match(await runtime.restore(session, 'ancient-fact'), /No archived memory/u)
})

test('stats reports the recall and retention configuration', async (t) => {
  const { runtime } = await fixture(t, { recallMode: 'once', maxUnusedDays: 30, sweepIntervalHours: 24 })
  const text = await runtime.stats(stubSession(process.cwd()))
  assert.match(text, /recall: once/u)
  assert.match(text, /archive after 30d unused/u)
  assert.match(text, /sweep every 24h/u)
  assert.match(text, /session mode: on/u)
  assert.match(text, /logging: info → /u, 'stats names the log level and file')
})
