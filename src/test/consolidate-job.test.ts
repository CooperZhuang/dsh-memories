/**
 * Unit test for consolidation's workspace bookkeeping.
 *
 * Consolidation is process-level but project scope is per-workspace. The job
 * must remember which workspace enqueued it, otherwise whichever session runs
 * the pass decides whose project memories get consolidated — the bug that let a
 * pass run against the wrong workspace and report success.
 *
 * @module dsh-memories/test/consolidate-job.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in. */
function stubSession(id: string, cwd: string): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    seq: 1,
    requestHeader: () => undefined,
  } as unknown as Session
}

/** A runtime over a temp store. */
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-job-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })
  return { dir, runtime }
}

test('enqueue records the workspace the pass should cover', async (t) => {
  const { runtime } = await fixture(t)
  runtime.enqueueConsolidation(1_000, false, 'C:\\work\\alpha')
  const job = runtime.state.getJob('global')
  assert.equal(job?.root, 'C:\\work\\alpha')
  assert.equal(job?.enqueuedAt, 1_000)
  // The cooldown applies to a background enqueue.
  assert.ok((job?.notBefore ?? 0) > 1_000)
})

test('a manual enqueue skips the cooldown but still records the root', async (t) => {
  const { runtime } = await fixture(t)
  runtime.enqueueConsolidation(2_000, true, 'C:\\work\\beta')
  const job = runtime.state.getJob('global')
  assert.equal(job?.notBefore, 2_000, 'ready now')
  assert.equal(job?.root, 'C:\\work\\beta')
})

test('a later enqueue updates the root so the newest workspace wins', async (t) => {
  const { runtime } = await fixture(t)
  runtime.enqueueConsolidation(1_000, false, 'C:\\work\\alpha')
  runtime.enqueueConsolidation(2_000, false, 'C:\\work\\beta')
  assert.equal(runtime.state.getJob('global')?.root, 'C:\\work\\beta')
})

test('an enqueue without a root keeps the recorded one', async (t) => {
  const { runtime } = await fixture(t)
  runtime.enqueueConsolidation(1_000, false, 'C:\\work\\alpha')
  runtime.enqueueConsolidation(2_000, false)
  assert.equal(runtime.state.getJob('global')?.root, 'C:\\work\\alpha')
})

test('consolidation is a no-op without a subagent seam', async (t) => {
  const { runtime } = await fixture(t)
  // No `subagents` service in the stub context, so the pass cannot run and
  // must report that rather than creating a job it can never complete.
  assert.equal(await runtime.consolidateNow({ session: stubSession('s', process.cwd()) } as never), undefined)
  assert.equal(runtime.state.getJob('global'), undefined)
})
