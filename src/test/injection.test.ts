/**
 * Injection-behaviour tests for {@link MemoriesRuntime}.
 *
 * These pin the once-per-conversation rule that keeps the summary from crowding
 * out the conversation: the block enters the first step at which the store has
 * something to say, never again afterwards, and `clear`/`compact` (which replace
 * the conversation) are the only thing that re-arms it.
 *
 * @module dsh-memories/test/injection.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in: header, id, header fold, and a controllable history. */
function stubSession(cwd: string, history: readonly unknown[] = []): Session {
  let seq = 1
  return {
    id: 'test-session',
    header: { version: 0, id: 'test-session', createdAt: 0, cwd, isSeeded: false },
    get seq() { return seq += 1 },
    requestHeader: () => undefined,
    deriveMessages: () => [...history],
  } as unknown as Session
}

/** An agent stand-in exposing only `session`. */
function stubAgent(session: Session): Agent {
  return { id: 'test-session', session, status: 'idle' } as unknown as Agent
}

test('injection is once per conversation, not once per turn', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-inj-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  const agent = stubAgent(stubSession(dir))

  assert.equal(await runtime.injectionFor(agent), undefined, 'an empty store injects nothing')

  await runtime.write(agent.session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm, not npm.', tags: ['tooling'] }, 'tool')

  const first = await runtime.injectionFor(agent)
  assert.ok(first !== undefined, 'a non-empty store injects')
  assert.match(JSON.stringify(first.content), /Prefer pnpm/u)

  assert.equal(await runtime.injectionFor(agent), undefined, 'the same step does not re-inject')
  assert.equal(await runtime.injectionFor(agent), undefined, 'nor a later step')
  assert.equal(await runtime.injectionFor(agent), undefined, 'nor a later turn')

  // A write inside the conversation is NOT a reason to re-inject: the model just
  // made it, and every later recall goes through memory_search.
  await runtime.write(agent.session, { scope: 'global', title: 'Answer in Chinese', body: 'The user writes Chinese.', tags: [] }, 'tool')
  assert.equal(await runtime.injectionFor(agent), undefined, 'a write never re-injects')

  // `clear`/`compact` replace the conversation, so a session that carries
  // nothing (the stub's empty history) gets the block again.
  runtime.resetInjection(agent.session)
  const second = await runtime.injectionFor(agent)
  assert.ok(second !== undefined, 'a reset re-arms injection')
  assert.notEqual(second.id, first.id)
  assert.match(JSON.stringify(second.content), /Answer in Chinese/u)

  t.after(() => rm(dir, { recursive: true, force: true }))
})
test('a restarted harness does not re-inject into a conversation that already carries the block', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-restart-'))
  const first = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => first.dispose())
  const session = stubSession(dir)
  await first.write(session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm, not npm.', tags: ['tooling'] }, 'tool')
  const block = await first.injectionFor(stubAgent(session))
  assert.ok(block !== undefined, 'the first process injects once')

  // A fresh runtime models a restarted process. The block travelled with the
  // durable history, so resuming that conversation must not add a second copy —
  // which is exactly what an in-memory-only marker could not see.
  const second = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => second.dispose())
  assert.equal(await second.injectionFor(stubAgent(stubSession(dir, [block]))), undefined, 'a restored history already carries the block')

  // A cleared conversation carries nothing, so the block legitimately returns.
  assert.ok(await second.injectionFor(stubAgent(stubSession(dir))) !== undefined, 'a cleared conversation gets the block again')

  // Both stores must be closed before the temp directory goes.
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('an empty store stays silent, and a session with nothing to say is not marked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-forget-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  const agent = stubAgent(stubSession(dir))

  await runtime.write(agent.session, { scope: 'project', title: 'Windows only', body: 'Path separators differ.', tags: [] }, 'tool')
  assert.equal(await runtime.forget(agent.session, 'project', 'windows-only'), true)
  assert.equal(await runtime.injectionFor(agent), undefined, 'an emptied store has nothing to say')

  // The first memory that arrives after the session started still gets injected:
  // a silent step must not consume the one injection the conversation is owed.
  await runtime.write(agent.session, { scope: 'project', title: 'Windows only', body: 'Path separators differ.', tags: [] }, 'tool')
  assert.ok(await runtime.injectionFor(agent) !== undefined, 'the first non-empty step injects')

  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('project scope follows the session cwd and stays isolated from other roots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-scope-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memories-ws-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  const inside = stubAgent(stubSession(workspace))
  const outside = stubAgent(stubSession(tmpdir()))
  await runtime.write(inside.session, { scope: 'project', title: 'Repo convention', body: 'Tests live beside sources.', tags: [] }, 'tool')

  const here = await runtime.summary(inside.session)
  assert.ok(here !== undefined)
  assert.match(here, /Repo convention/u)

  const elsewhere = await runtime.summary(outside.session)
  assert.equal(elsewhere, undefined, 'another workspace sees nothing of this project scope')

  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))
})

test('the injected summary never exceeds its configured byte budget', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-budget-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, maxSummaryBytes: 700, maxSummaryEntries: 50 })
  t.after(() => runtime.dispose())
  const agent = stubAgent(stubSession(dir))
  for (let index = 0; index < 20; index += 1) {
    await runtime.write(agent.session, { scope: 'global', title: `Fact ${index}`, body: 'x'.repeat(200), tags: ['noise'] }, 'tool')
  }
  const summary = await runtime.summary(agent.session)
  assert.ok(summary !== undefined)
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 700)
  t.after(() => rm(dir, { recursive: true, force: true }))
})
