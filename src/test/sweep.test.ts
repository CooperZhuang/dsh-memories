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
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import { projectSlug } from '../storage.js'
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

test('the sweep removes project directories that hold nothing recoverable', async (t) => {
  const { runtime, dir } = await fixture(t)
  const archivedRoot = 'C:\\Code\\abandoned'
  const emptyRoot = 'C:\\Code\\never-used'
  // One workspace produced a memory that retention then archived; another left a
  // slug behind without ever producing one. A real store had 12 of its 19 project
  // directories like this, six of them without even a descriptor.
  await runtime.store.upsert({ scope: 'project', title: 'Stale project fact', body: 'x', tags: [] }, archivedRoot, 'auto', NOW - 400 * DAY)
  await runtime.store.writeProjectDescriptor(emptyRoot, NOW)
  assert.equal((await runtime.store.listProjects()).length, 2)

  await runtime.sweepNow(NOW)

  assert.deepEqual(await runtime.store.listProjects(), [projectSlug(archivedRoot)], 'only the empty directory is gone')
  assert.deepEqual((await runtime.store.listArchived('project', archivedRoot)).map((entry) => entry.id), ['stale-project-fact'],
    'the archived workspace keeps its directory: an archive is restorable data')
  assert.equal(existsSync(join(dir, 'projects', projectSlug(emptyRoot))), false)
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

test('the sweep and the background pass each report themselves in one line', async (t) => {
  const lines: string[] = []
  const capturing = {
    get: () => undefined,
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-report-'))
  const runtime = new MemoriesRuntime(capturing, { memoriesDir: dir, autoExtract: true })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })

  await runtime.sweepNow(NOW)
  // The host formats `%d`/`%s` downstream, so the stub sees the template plus its
  // arguments; what matters here is that the line exists at all.
  const sweep = lines.find((line) => line.startsWith('dsh-memories: sweep:'))
  assert.ok(sweep !== undefined, 'a sweep says what it did even when that is nothing')
  assert.match(sweep, /archived %d memories across %d project scopes, pruned %d empty project/u)

  lines.length = 0
  // No tracked session: the pass has nothing to do, and the point is that the
  // file still answers "did the extractor run, and why did it do nothing".
  await runtime.runPeriodicPass()
  assert.ok(lines.some((line) => line.startsWith('dsh-memories: extract pass:')),
    'a pass with no work still leaves a line')
})

test('stats reports the recall and retention configuration', async (t) => {
  const { runtime } = await fixture(t, { recallMode: 'once', maxUnusedDays: 30, sweepIntervalHours: 24, autoExtract: true, minIdleHours: 6 })
  const text = await runtime.stats(stubSession(process.cwd()))
  assert.match(text, /recall: once/u)
  assert.match(text, /archive after 30d unused/u)
  assert.match(text, /sweep every 24h/u)
  assert.match(text, /session mode: on/u)
  assert.match(text, /logging: info → /u, 'stats names the log level and file')
  assert.match(text, /sessions: 0 mined \/ 0 tracked/u)
  assert.match(text, /auto-extract: on \(every 30m \+ 6h quiet to settle/u, 'stats shows both the periodic check and the settle wait')
  assert.match(text, /peak-hours: off/u, 'no peak rule is reported as off')
})
