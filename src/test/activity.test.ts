/**
 * Tests for the age gate's clock.
 *
 * `maxAgeDays` decides whether a finished session is still worth mining. It
 * reads the session's last OBSERVED activity, which only exists because the
 * plugin records it on every status transition. Without that recording the
 * gate silently never fires — the bug these tests exist to prevent from
 * coming back.
 *
 * @module dsh-memories/test/activity.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in: the runtime only reads the id and the header. */
function stubSession(id: string, cwd = process.cwd()): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    seq: 1,
    requestHeader: () => undefined,
  } as unknown as Session
}

test('recordActivity writes the clock the age gate reads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-activity-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })

  const session = stubSession('session-a')
  assert.equal(runtime.state.getSession('session-a'), undefined, 'nothing is recorded before any activity')

  runtime.recordActivity(session, 1_000)
  assert.equal(runtime.state.getSession('session-a')?.activityAt, 1_000)

  runtime.recordActivity(session, 2_000)
  assert.equal(runtime.state.getSession('session-a')?.activityAt, 2_000, 'later activity moves the clock')

  // Recording activity must not fabricate a watermark: a session can be used
  // for days without ever being mined.
  assert.equal(runtime.state.getSession('session-a')?.lastSeq, 0)
})

test('recording activity keeps an existing watermark intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-activity-keep-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })

  runtime.state.putSession('session-a', { lastSeq: 42, at: 500, contributed: true, activityAt: 600 })
  runtime.recordActivity(stubSession('session-a'), 9_000)
  const state = runtime.state.getSession('session-a')
  assert.equal(state?.activityAt, 9_000)
  assert.equal(state?.lastSeq, 42, 'the watermark is untouched')
  assert.equal(state?.contributed, true)
})

test('activity is per session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-activity-scope-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })

  runtime.recordActivity(stubSession('a'), 1_000)
  runtime.recordActivity(stubSession('b'), 2_000)
  assert.equal(runtime.state.getSession('a')?.activityAt, 1_000)
  assert.equal(runtime.state.getSession('b')?.activityAt, 2_000)
})
