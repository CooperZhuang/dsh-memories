/**
 * Injection-behaviour tests for {@link MemoriesRuntime}.
 *
 * These pin the turn-scoped rule that keeps the summary from crowding out the
 * conversation: inject at the first step of a turn, refresh inside a turn only
 * when the store actually changed, and never re-inject an unchanged summary.
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

/** A session stand-in: the runtime only reads the header, id, and header fold. */
function stubSession(cwd: string): Session {
  let seq = 1
  return {
    id: 'test-session',
    header: { version: 0, id: 'test-session', createdAt: 0, cwd, isSeeded: false },
    get seq() { return seq += 1 },
    requestHeader: () => undefined,
  } as unknown as Session
}

/** An agent stand-in exposing only `session`. */
function stubAgent(session: Session): Agent {
  return { id: 'test-session', session, status: 'idle' } as unknown as Agent
}

test('injection is turn-scoped: once per turn, and only when the store changed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-inj-'))
      const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
    t.after(() => runtime.dispose())
    const agent = stubAgent(stubSession(dir))

    assert.equal(await runtime.injectionFor(agent, 1), undefined, 'an empty store injects nothing')

    await runtime.write(agent.session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm, not npm.', tags: ['tooling'] }, 'tool')

    const first = await runtime.injectionFor(agent, 1)
    assert.ok(first !== undefined, 'a non-empty store injects')
    assert.match(JSON.stringify(first.content), /Prefer pnpm/u)

    assert.equal(await runtime.injectionFor(agent, 1), undefined, 'the same turn does not re-inject an unchanged summary')
    assert.equal(await runtime.injectionFor(agent, 1), undefined, 'and again on a later step')

    const second = await runtime.injectionFor(agent, 2)
    assert.ok(second !== undefined, 'a new turn re-injects')
    assert.notEqual(second.id, first.id)

    await runtime.write(agent.session, { scope: 'global', title: 'Answer in Chinese', body: 'The user writes Chinese.', tags: [] }, 'tool')
    const third = await runtime.injectionFor(agent, 2)
    assert.ok(third !== undefined, 'a mid-turn write refreshes the summary')
    assert.match(JSON.stringify(third.content), /Answer in Chinese/u)

    assert.equal(await runtime.injectionFor(agent, 2), undefined, 'the refresh happens once')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('forget refreshes the summary and an emptied store stops injecting', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-forget-'))
      const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
    t.after(() => runtime.dispose())
    const agent = stubAgent(stubSession(dir))
    await runtime.write(agent.session, { scope: 'project', title: 'Windows only', body: 'Path separators differ.', tags: [] }, 'tool')
    assert.ok(await runtime.injectionFor(agent, 1) !== undefined)

    assert.equal(await runtime.forget(agent.session, 'project', 'windows-only'), true)
    assert.equal(await runtime.injectionFor(agent, 1), undefined, 'an emptied store has nothing to say')
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

    const here = await runtime.summary(inside.session, false)
    assert.ok(here !== undefined)
    assert.match(here.text, /Repo convention/u)

    const elsewhere = await runtime.summary(outside.session, false)
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
    const summary = await runtime.summary(agent.session, false)
    assert.ok(summary !== undefined)
    assert.ok(Buffer.byteLength(summary.text, 'utf8') <= 700)
  t.after(() => rm(dir, { recursive: true, force: true }))
})
