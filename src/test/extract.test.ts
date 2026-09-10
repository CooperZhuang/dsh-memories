/**
 * Background-extraction tests for {@link MemoriesRuntime}.
 *
 * The extractor is the one path that normally needs a live model, so these
 * tests drive it through a fake LLM runtime and a synthetic session surface.
 * They pin the parts that matter: only human/assistant prose is read, the
 * watermark advances so a session is never mined twice, secrets are redacted
 * before anything is written, and a failing call leaves the store untouched.
 *
 * @module dsh-memories/test/extract.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import { EXTRACT_JSON_SCHEMA, collectWindow, parseDrafts, redactSecrets, runExtraction } from '../extract.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** A streaming text delta in the shape the assembler consumes. */
function textChunk(text: string, index = 0): StreamChunk {
  return { type: 'text-delta', index, text } as unknown as StreamChunk
}

/** The terminal chunk of a successful stream. */
function stopChunk(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
}

/** A fake LLM runtime that replays one canned reply. */
function fakeLlm(reply: string, seen: { system?: string | undefined; user?: string | undefined } = {}) {
  return {
    stream: (options: { system?: string; messages: { content: { type: string; text?: string }[] }[] }) => {
      seen.system = options.system
      seen.user = options.messages.map((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')).join('\n')
      return (async function* chunks() {
        yield textChunk(reply)
        yield stopChunk()
      })()
    },
  }
}

/** A session stand-in with a controllable surface. */
function stubSession(cwd: string, events: { seq: number; role: 'user' | 'assistant'; text: string; source?: 'user' | 'plugin' }[]): Session {
  const nodes = events.map((event) => event.seq)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    id: 'extract-session',
    header: { version: 0, id: 'extract-session', createdAt: 0, cwd, isSeeded: false },
    surface: { nodes },
    eventAt: (seq: number) => {
      const event = bySeq.get(seq)
      if (event === undefined) return undefined
      if (event.role === 'user') {
        return {
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: event.text }],
            source: event.source === 'plugin' ? { kind: 'plugin', plugin: 'other' } : { kind: 'user' },
          },
        }
      }
      return {
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: event.text }], source: { kind: 'model' } },
        },
      }
    },
    requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
  } as unknown as Session
}

/** A context whose only service is the fake LLM. */
function stubContext(llm: unknown) {
  return {
    get: (name: string) => (name === 'llm' ? llm : undefined),
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  } as never
}

test('redactSecrets removes credential-shaped text and keeps prose', () => {
  assert.equal(redactSecrets('use key sk-abcdefghijklmnopqrstuvwx now'), 'use key [redacted] now')
  assert.equal(redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz01'), '[redacted]')
  assert.equal(redactSecrets('AWS AKIAABCDEFGHIJKLMNOP here'), 'AWS [redacted] here')
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: [redacted]')
  assert.equal(redactSecrets('api_key = "supersecretvalue"'), '[redacted]')
  assert.equal(redactSecrets('plain prose about pnpm'), 'plain prose about pnpm')
})

test('parseDrafts accepts a bare object, a fenced object, and rejects junk', () => {
  const payload = '{"memories":[{"scope":"global","title":"Prefer pnpm","body":"Use pnpm.","tags":["tooling"]}]}'
  assert.equal(parseDrafts(payload, 5).length, 1)
  assert.equal(parseDrafts(`\`\`\`json\n${payload}\n\`\`\``, 5).length, 1)
  assert.equal(parseDrafts('{"memories":[]}', 5).length, 0)
  assert.equal(parseDrafts('not json at all', 5).length, 0)
  assert.equal(parseDrafts('{"memories":[{"scope":"elsewhere","title":"x","body":"y"}]}', 5).length, 0)
  assert.equal(parseDrafts('{"memories":[{"scope":"global","title":"","body":"y"}]}', 5).length, 0)
  const capped = parseDrafts(JSON.stringify({
    memories: [1, 2, 3, 4].map((index) => ({ scope: 'global', title: `t${index}`, body: `b${index}` })),
  }), 2)
  assert.equal(capped.length, 2)
})

test('parseDrafts redacts secrets inside extracted memories', () => {
  const drafts = parseDrafts('{"memories":[{"scope":"global","title":"API key","body":"the key is sk-abcdefghijklmnopqrstuvwx"}]}', 5)
  assert.equal(drafts[0]?.body, 'the key is [redacted]')
})

test('collectWindow reads only human/assistant prose after the watermark', () => {
  const session = stubSession('C:\\work', [
    { seq: 1, role: 'user', text: 'old question' },
    { seq: 2, role: 'assistant', text: 'old answer' },
    { seq: 3, role: 'user', text: 'new question' },
    { seq: 4, role: 'user', text: 'injected plugin context', source: 'plugin' },
    { seq: 5, role: 'assistant', text: 'new answer' },
  ])
  const window = collectWindow(session, 2, 10, 10_000)
  assert.equal(window.lastSeq, 5)
  assert.equal(window.messages, 2)
  assert.match(window.text, /new question/u)
  assert.match(window.text, /new answer/u)
  assert.doesNotMatch(window.text, /old question/u)
  assert.doesNotMatch(window.text, /injected plugin context/u)
})

test('collectWindow honours the message and character caps from the newest end', () => {
  const events = Array.from({ length: 12 }, (_, index) => ({ seq: index + 1, role: 'user' as const, text: `line ${index}` }))
  const session = stubSession('C:\\work', events)
  const byMessages = collectWindow(session, 0, 3, 100_000)
  assert.equal(byMessages.messages, 3)
  assert.match(byMessages.text, /line 11/u)
  const byChars = collectWindow(session, 0, 100, 30)
  assert.ok(byChars.text.length <= 30)
  assert.match(byChars.text, /line 11/u)
})

test('the extraction JSON schema is closed and requires the documented fields', () => {
  assert.equal(EXTRACT_JSON_SCHEMA.additionalProperties, false)
  assert.deepEqual([...EXTRACT_JSON_SCHEMA.required], ['memories'])
  assert.deepEqual([...EXTRACT_JSON_SCHEMA.properties.memories.items.required], ['scope', 'title', 'body'])
})

test('runExtraction sends the transcript and returns parsed drafts', async () => {
  const seen: { system?: string; user?: string } = {}
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'I always use pnpm here.' }])
  const outcome = await runExtraction(fakeLlm('{"memories":[{"scope":"project","title":"Use pnpm","body":"This repo uses pnpm.","tags":["tooling"]}]}', seen) as never, {
    session,
    window: collectWindow(session, 0, 10, 10_000),
    projectLabel: 'project:work',
    maxOutputTokens: 512,
    maxMemories: 5,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.kind, 'memories')
  assert.equal(outcome.kind === 'memories' ? outcome.drafts.length : 0, 1)
  assert.match(seen.system ?? '', /durable, reusable facts/u)
  assert.match(seen.user ?? '', /I always use pnpm here/u)
  assert.match(seen.user ?? '', /project:work/u)
})

test('runExtraction reports an empty window and a missing route without calling the model', async () => {
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'hi' }])
  const empty = await runExtraction(fakeLlm('{}') as never, {
    session,
    window: { text: '', lastSeq: undefined, messages: 0 },
    projectLabel: 'project:work',
    maxOutputTokens: 128,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })
  assert.deepEqual(empty, { kind: 'none', reason: 'empty-window' })

  const routeless = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'hi' }])
  ;(routeless as unknown as { requestHeader: () => undefined }).requestHeader = () => undefined
  const noRoute = await runExtraction(fakeLlm('{}') as never, {
    session: routeless,
    window: collectWindow(routeless, 0, 10, 1_000),
    projectLabel: 'project:work',
    maxOutputTokens: 128,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })
  assert.deepEqual(noRoute, { kind: 'none', reason: 'no-route' })
})

test('runExtraction throws on a non-stop finish reason', async () => {
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'hi' }])
  const truncated = {
    stream: () => (async function* chunks() {
      yield textChunk('{"memories":[')
      yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
    })(),
  }
  await assert.rejects(() => runExtraction(truncated as never, {
    session,
    window: collectWindow(session, 0, 10, 1_000),
    projectLabel: 'project:work',
    maxOutputTokens: 8,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }), /max-tokens/u)
})

test('runExtraction stores drafts, advances the watermark, and never mines twice', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-extract-'))
      const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'I always deploy with pnpm run ship.' }])
    const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
    const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
    t.after(() => runtime.dispose())
    const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

    assert.equal(await runtime.runExtraction(agent), 1)
    const stored = await runtime.store.list('project', process.cwd(), { fresh: true })
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.source, 'auto')
    assert.match(stored[0]?.body ?? '', /pnpm run ship/u)

    const state = runtime.state.getSession('extract-session')
    assert.equal(state?.lastSeq, 1)
    assert.equal(state?.contributed, true)

    // Nothing new on the surface, so a second pass is a no-op.
    assert.equal(await runtime.runExtraction(agent), 0)
    assert.equal((await runtime.store.list('project', process.cwd(), { fresh: true })).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a failing extraction call leaves the store and watermark untouched', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-extract-fail-'))
      const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'something memorable' }])
    const failing = { stream: () => { throw new Error('provider exploded') } }
    const runtime = new MemoriesRuntime(stubContext(failing), { memoriesDir: dir, autoExtract: true })
    t.after(() => runtime.dispose())
    const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

    await assert.rejects(() => runtime.runExtraction(agent), /provider exploded/u)
    assert.equal((await runtime.store.list('project', process.cwd(), { fresh: true })).length, 0)
    assert.equal(runtime.state.getSession('extract-session'), undefined)
    // The watermark is only written on success.
    assert.equal(runtime.state.sessionCount(), 0)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('extraction is skipped for subagent sessions and when disabled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-extract-skip-'))
      const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'x' }])
    ;(session.header as unknown as { delegationDepth?: number }).delegationDepth = 1
    const runtime = new MemoriesRuntime(stubContext(fakeLlm('{"memories":[]}')), { memoriesDir: dir, autoExtract: true })
    t.after(() => runtime.dispose())
    const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent
    runtime.scheduleExtraction(agent)
    assert.equal(await runtime.runExtraction(agent), 0)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a provider refusal pauses background passes and the pause survives a reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-quota-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'I always deploy with pnpm run ship.' }])
  let calls = 0
  const refusing = {
    stream: () => {
      calls += 1
      const error = new Error('rate limit exceeded') as Error & { code?: string }
      error.code = 'RATE_LIMIT'
      throw error
    },
  }
  const runtime = new MemoriesRuntime(stubContext(refusing), {
    memoriesDir: dir,
    autoExtract: true,
    quotaCooldownMinutes: 30,
    quotaCooldownMaxMinutes: 120,
  })
  t.after(() => runtime.dispose())
  const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

  await assert.rejects(() => runtime.runExtraction(agent), /rate limit/u)
  assert.equal(calls, 1)
  const first = runtime.state.getLimit()
  assert.ok(first !== undefined, 'a refusal is recorded')
  assert.equal(first.failures, 1)
  assert.equal(first.until - first.at, 30 * 60_000)

  // The next pass never reaches the provider, so the refusal costs one call per
  // cooldown instead of one per idle timer.
  assert.equal(await runtime.runExtraction(agent), 0)
  assert.equal(calls, 1)

  // A second refusal doubles the wait; consecutive refusals keep doubling to a cap.
  runtime.state.clearLimit()
  await assert.rejects(() => runtime.runExtraction(agent), /rate limit/u)
  const second = runtime.state.noteLimitFailure('again', 30 * 60_000, 120 * 60_000)
  assert.equal(second.failures, 2)
  assert.equal(second.until - second.at, 60 * 60_000)

  // The pause is durable state: a restarted process must not immediately retry.
  const reopened = new MemoriesRuntime(stubContext(refusing), { memoriesDir: dir, autoExtract: true })
  t.after(() => reopened.dispose())
  assert.equal(reopened.state.isLimited(), true)
  assert.equal(await reopened.runExtraction(agent), 0)
  assert.equal(calls, 2, 'a paused pass never calls the provider')

  // A successful pass forgets the pause.
  reopened.state.clearLimit()
  assert.equal(reopened.state.isLimited(), false)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('consolidation quotes the rate limit as its own refusal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-quota-consolidate-'))
  const runtime = new MemoriesRuntime(stubContext({ stream: async function* () {} }), { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  runtime.state.noteLimitFailure('quota exhausted', 1_000, 1_000)
  assert.equal(runtime.state.isLimited(), true)
  assert.match(await runtime.stats(stubSession(process.cwd(), [])), /background: paused until/u)
  t.after(() => rm(dir, { recursive: true, force: true }))
})
