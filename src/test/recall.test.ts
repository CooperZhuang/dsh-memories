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

/**
 * A session stand-in whose surface carries at most one user message.
 *
 * The id is unique per call: state (usage counters, memory mode) is keyed by
 * session id on disk, and node:test runs tests in the same file concurrently, so
 * a shared id would let one test's writes change another's recall ranking.
 */
let sessionCounter = 0
function stubSession(cwd: string, userText = '', id = `test-session-${++sessionCounter}`): Session {
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

/** The raw text of the single memory block in one message. */
function blockText(message: { content: unknown } | undefined): string {
  const blocks = (message?.content ?? []) as readonly { type: string; text?: string }[]
  return blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
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
  assert.ok(await runtime.recallFor(agent) !== undefined, 'up to three')
  await runtime.write(session, { scope: 'global', title: 'pnpm audit', body: 'Audit pnpm deps.', tags: [] }, 'tool')
  assert.ok(await runtime.recallFor(agent) !== undefined, 'the fourth memory still fits the default cap')
  await runtime.write(session, { scope: 'global', title: 'pnpm dedupe', body: 'Dedupe pnpm deps.', tags: [] }, 'tool')
  assert.equal(await runtime.recallFor(agent), undefined, 'the cap stops further deltas')
})

test('one delta carries every memory the same turn matches, best first', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), 'pnpm workspace hoisting')
  // Both entries clear the evidence gate (each shares two of the turn's words
  // with its title), and they clear it by different margins: the first carries
  // the turn's words in its title AND body, the second only in its title. So the
  // order is decided by relevance, not by which entry was written last.
  await runtime.write(session, { scope: 'global', title: 'pnpm workspace', body: 'One pnpm workspace, hoisted for speed.', tags: [] }, 'tool')
  await runtime.write(session, { scope: 'global', title: 'pnpm hoisting', body: 'A short note.', tags: [] }, 'tool')

  const delta = await runtime.recallFor(stubAgent(session))
  assert.ok(delta !== undefined)
  const text = textOf(delta)
  assert.match(text, /pnpm workspace/u, 'the stronger match is listed')
  assert.match(text, /pnpm hoisting/u, 'and so is the second one the turn matched')
  assert.ok(text.indexOf('pnpm workspace') < text.indexOf('pnpm hoisting'), 'ranked by relevance, best first')
  // One block, not two: the whole point of a delta is that it costs one message.
  assert.equal((text.match(/<memory-recall>/gu) ?? []).length, 1)
})

test('the delta byte budget bounds one block instead of dropping it', async (t) => {
  const { runtime } = await fixture(t, { recallMaxBytes: 500 })
  const session = stubSession(process.cwd(), 'pnpm note number seven')
  for (let index = 0; index < 8; index += 1) {
    // Each entry shares two of the turn's words (pnpm, note) with its TITLE, so
    // all eight clear the evidence gate and the byte budget is the only thing
    // limiting how many can be listed.
    await runtime.write(session, {
      scope: 'global',
      title: `pnpm note number ${index}`,
      body: `A note about pnpm, padded out so that a preview takes up real room.`,
      tags: [],
    }, 'tool')
  }
  const delta = await runtime.recallFor(stubAgent(session))
  assert.ok(delta !== undefined, 'a budget too small for everything still yields a block')
  const text = blockText(delta)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 500, 'the block respects its budget')
  assert.match(text, /<memory-recall>/u)
  assert.match(text, /<\/memory-recall>/u, 'the closing frame survives the budget, or dedupe breaks')
  const listed = (text.match(/^- \[/gmu) ?? []).length
  assert.ok(listed >= 1, 'at least one memory is listed')
  assert.ok(listed < 8, 'and the budget stopped it short of the whole store')
})

test('a bare acknowledgement does not trigger a store scan', async (t) => {
  const { runtime } = await fixture(t, { recallMinQueryChars: 2 })
  const session = stubSession(process.cwd(), '好')
  await runtime.write(session, { scope: 'global', title: '好习惯', body: '每天提交。', tags: [] }, 'tool')
  assert.equal(await runtime.recallFor(stubAgent(session)), undefined, 'a one-character turn is skipped')
})

test('a Chinese turn reaches a memory it shares a phrase with', async (t) => {
  const { runtime } = await fixture(t)
  // The question and the title genuinely share the three consecutive characters
  // 件的日, while the title's own wording differs around them.
  const session = stubSession(process.cwd(), '这个插件的日志在哪里？')
  await runtime.write(session, {
    scope: 'global',
    title: '件的日志该去哪里看',
    body: '日志写在 dsh-memories.log 里。',
    tags: [],
  }, 'tool')
  const delta = await runtime.recallFor(stubAgent(session))
  assert.ok(delta !== undefined, 'a Chinese turn with no spaces still recalls')
  assert.match(textOf(delta), /件的日志该去哪里看/u)
})

test('a Chinese turn that only shares common pairs recalls nothing', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), '该插件是否有日志')
  // Shares the isolated pair 插件 with the question and nothing longer. It also
  // scores 12, above any floor low enough to admit a paraphrase, so a score
  // threshold cannot be the thing that keeps this out — the evidence gate is.
  await runtime.write(session, {
    scope: 'global',
    title: '插件注册顺序',
    body: '插件在启动时注册，日志级别由配置决定。',
    tags: [],
  }, 'tool')
  assert.equal(await runtime.recallFor(stubAgent(session)), undefined,
    'the same characters are not the same phrase')
})

test('appliesTo is what makes a memory reachable when the title shares no noun', async (t) => {
  const { runtime } = await fixture(t)
  const session = stubSession(process.cwd(), '准备推送代码')
  await runtime.write(session, {
    scope: 'global',
    title: '提交后主动推送',
    body: '本项目的约定是提交后主动推送，不要留在本地。',
    tags: [],
    appliesTo: '准备推送代码之前',
  }, 'tool')
  assert.ok(await runtime.recallFor(stubAgent(session)) !== undefined,
    'the appliesTo phrase is exactly the signal for a turn like this')
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
