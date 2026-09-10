/**
 * Tests for on-demand recall and the per-session memory switch.
 *
 * The once-per-conversation summary is cheap but static; a recall delta is what
 * answers a memory that only becomes relevant ten turns in. These tests pin the
 * three bounds that keep it from becoming a second, unbounded injection path —
 * a score threshold, a per-conversation cap, and never repeating an entry — and
 * the switch that turns the whole thing off for one session.
 *
 * @module dsh-memories/test/recall.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { MemoriesConfig } from '../config.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in whose surface carries at most one user message. */
function stubSession(cwd: string, userText = '', id = 'test-session'): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    seq: 1,
    requestHeader: () => undefined,
    deriveMessages: () => userText.length === 0
      ? []
      : [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }],
  } as unknown as Session
}

/** An agent stand-in. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/** A runtime over a temp store. */
async function fixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  settings: Partial<MemoriesConfig> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-recall-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, ...settings })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })
  return { dir, runtime }
}

/** The text of one message's content blocks. */
function textOf(message: { content: unknown } | undefined): string {
  return JSON.stringify(message?.content ?? '')
}

test('an on-demand delta surfaces the memory the current turn matches', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'pnpm')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm, not npm.', tags: [] }, 'tool')

  const delta = await runtime.recallFor(stubAgent(session))
  assert.ok(delta !== undefined, 'a strong match injects')
  assert.match(textOf(delta), /<memory-recall>/u)
  assert.match(textOf(delta), /Prefer pnpm/u)
  assert.equal(delta?.source.kind, 'plugin')
})

test('a delta is injected once per entry and capped per conversation', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'pnpm')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  const agent = stubAgent(session)

  assert.ok(await runtime.recallFor(agent) !== undefined)
  assert.equal(await runtime.recallFor(agent), undefined, 'the same entry is never repeated')

  await runtime.write(session, { scope: 'global', title: 'pnpm hoisting', body: 'Hoist pnpm deps.', tags: [] }, 'tool')
  assert.ok(await runtime.recallFor(agent) !== undefined, 'a second unseen entry still fits')

  await runtime.write(session, { scope: 'global', title: 'pnpm store', body: 'Share the pnpm store.', tags: [] }, 'tool')
  assert.ok(await runtime.recallFor(agent) !== undefined, 'up to the default cap of three')
  await runtime.write(session, { scope: 'global', title: 'pnpm audit', body: 'Audit pnpm deps.', tags: [] }, 'tool')
  assert.equal(await runtime.recallFor(agent), undefined, 'the cap stops further deltas')
})

test('a weak match and an unrelated turn inject nothing', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'what is the weather tomorrow')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  assert.equal(await runtime.recallFor(stubAgent(session)), undefined)
})

test('the score threshold gates the delta', async (t) => {
  const { runtime } = await fixture(t, { recallMinScore: 1_000 })
  const session = stubSession(process.cwd(), 'pnpm')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  assert.equal(await runtime.recallFor(stubAgent(session)), undefined)
})

test('recallMode once keeps the single summary, and off keeps nothing', async (t) => {
  const once = await fixture(t, { recallMode: 'once' })
  const onceSession = stubSession(process.cwd(), 'pnpm')
  await once.runtime.write(onceSession, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  assert.ok(await once.runtime.injectionFor(stubAgent(onceSession)) !== undefined, 'the summary still injects')
  assert.equal(await once.runtime.recallFor(stubAgent(onceSession)), undefined, 'no delta in once mode')

  const off = await fixture(t, { recallMode: 'off' })
  const offSession = stubSession(process.cwd(), 'pnpm')
  await off.runtime.write(offSession, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  assert.equal(await off.runtime.injectionFor(stubAgent(offSession)), undefined, 'off disables the summary')
  assert.equal(await off.runtime.recallFor(stubAgent(offSession)), undefined, 'and the delta')
})

test('a delta does not suppress the summary, and the summary suppresses a repeat', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'pnpm')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  const agent = stubAgent(session)

  assert.ok(await runtime.recallFor(agent) !== undefined)
  // The delta carries the same `form`, but not the summary's frame, so the
  // conversation is still owed its once-per-conversation block.
  assert.ok(await runtime.injectionFor(agent) !== undefined, 'the summary still arrives')

  const other = stubSession(process.cwd(), 'pnpm', 'second-session')
  const secondAgent = stubAgent(other)
  await runtime.write(other, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  assert.ok(await runtime.injectionFor(secondAgent) !== undefined)
  assert.equal(await runtime.recallFor(secondAgent), undefined, 'the summary already listed the only entry')
})

test('the per-session switch suspends injection and deltas until it is turned back on', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'pnpm')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')

  assert.match(runtime.setSessionMode(session, ''), /Memory is on/u)
  assert.match(runtime.setSessionMode(session, 'sideways'), /Usage: \/memories mode/u)
  assert.match(runtime.setSessionMode(session, 'off'), /off for this session/u)
  assert.equal(runtime.sessionMode(session), 'off')
  assert.equal(await runtime.injectionFor(stubAgent(session)), undefined)
  assert.equal(await runtime.recallFor(stubAgent(session)), undefined)

  runtime.setSessionMode(session, 'on')
  assert.equal(runtime.sessionMode(session), 'on')
  assert.ok(await runtime.injectionFor(stubAgent(session)) !== undefined, 'turning it back on re-arms the summary')
})

test('resetInjection re-arms both the summary and the delta budget', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'pnpm')
  await runtime.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm.', tags: [] }, 'tool')
  const agent = stubAgent(session)
  assert.ok(await runtime.recallFor(agent) !== undefined)
  assert.equal(await runtime.recallFor(agent), undefined)

  runtime.resetInjection(session)
  assert.ok(await runtime.recallFor(agent) !== undefined, 'a cleared conversation may see the memory again')
})
