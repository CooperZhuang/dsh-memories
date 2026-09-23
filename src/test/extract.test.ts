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
import { EXTRACT_JSON_SCHEMA, collectWindow, parseExtraction, redactSecrets, runExtraction } from '../extract.js'
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
            source: event.source === 'plugin' ? { kind: 'plugin:other' } : { kind: 'user' },
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
    /** Grow the surface mid-test, the way a conversation does. */
    append: (event: { seq: number; role: 'user' | 'assistant'; text: string }) => {
      bySeq.set(event.seq, event)
      nodes.push(event.seq)
    },
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

test('parseExtraction keeps the string keys and drops the rest', () => {
  const parsed = parseExtraction('{"memories":[{"scope":"global","title":"Prefer pnpm","body":"Use pnpm.","keys":["monorepo",7]}]}', 5, 'session-1')
  assert.deepEqual([...parsed.drafts[0]?.keys ?? []], ['monorepo'])
  // A reply that omits keys is normal: they are an optimization, not a contract.
  assert.deepEqual([...parseExtraction('{"memories":[{"scope":"global","title":"x","body":"y"}]}', 5, 's').drafts[0]?.keys ?? []], [])
})

test('parseExtraction accepts a bare object, a fenced object, and rejects junk', () => {
  const payload = '{"summary":"The user set up a pnpm workflow.","memories":[{"scope":"global","title":"Prefer pnpm","body":"Use pnpm.","tags":["tooling"]}]}'
  const parsed = parseExtraction(payload, 5, 'session-1')
  assert.equal(parsed.drafts.length, 1)
  assert.equal(parsed.summary, 'The user set up a pnpm workflow.')
  assert.equal(parsed.drafts[0]?.sourceSession, 'session-1')
  assert.equal(parseExtraction(`\`\`\`json\n${payload}\n\`\`\``, 5, 'session-1').drafts.length, 1)
  assert.equal(parseExtraction('{"memories":[]}', 5, 'session-1').drafts.length, 0)
  // A reply without a summary still parses; the evidence note then says so.
  assert.equal(parseExtraction('{"memories":[]}', 5, 'session-1').summary, '')
  assert.equal(parseExtraction('not json at all', 5, 'session-1').drafts.length, 0)
  assert.equal(parseExtraction('{"memories":[{"scope":"elsewhere","title":"x","body":"y"}]}', 5, 'session-1').drafts.length, 0)
  assert.equal(parseExtraction('{"memories":[{"scope":"global","title":"","body":"y"}]}', 5, 'session-1').drafts.length, 0)
  const capped = parseExtraction(JSON.stringify({
    memories: [1, 2, 3, 4].map((index) => ({ scope: 'global', title: `t${index}`, body: `b${index}` })),
  }), 2, 'session-1')
  assert.equal(capped.drafts.length, 2)
  // What the cap threw away is reported, not silently lost: a pass that always
  // lands exactly on the cap is otherwise indistinguishable from one that found
  // exactly that many memories, which hides the knob that limits the store.
  assert.equal(capped.dropped, 2)
  assert.equal(parseExtraction('{"memories":[{"scope":"global","title":"only","body":"one"}]}', 5, 's').dropped, 0)
})

test('parseExtraction redacts secrets inside extracted memories and the summary', () => {
  const parsed = parseExtraction('{"summary":"they pasted sk-abcdefghijklmnopqrstuvwx","memories":[{"scope":"global","title":"API key","body":"the key is sk-abcdefghijklmnopqrstuvwx"}]}', 5, 'session-1')
  assert.equal(parsed.drafts[0]?.body, 'the key is [redacted]')
  assert.equal(parsed.summary, 'they pasted [redacted]')
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
  // The summary is required too: it becomes the evidence note behind the drafts.
  assert.deepEqual([...EXTRACT_JSON_SCHEMA.required], ['summary', 'memories'])
  // `appliesTo` is required because it is the field that lets a paraphrased turn
  // find the memory again; half the store was unsearchable without it.
  assert.deepEqual([...EXTRACT_JSON_SCHEMA.properties.memories.items.required], ['scope', 'title', 'body', 'appliesTo'])
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

    assert.equal((await runtime.runExtraction(agent)).stored, 1)
    const stored = await runtime.store.list('project', process.cwd(), { fresh: true })
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.source, 'auto')
    assert.match(stored[0]?.body ?? '', /pnpm run ship/u)

    const state = runtime.state.getSession('extract-session')
    assert.equal(state?.lastSeq, 1)
    assert.equal(state?.contributed, true)

    // Nothing new on the surface, so a second pass is a no-op.
    assert.equal((await runtime.runExtraction(agent)).stored, 0)
    assert.equal((await runtime.store.list('project', process.cwd(), { fresh: true })).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('an llm service that arrives after activation is still used', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-late-llm-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'I always deploy with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship with `pnpm run ship`.","tags":["deploy"]}]}'
  let live: unknown
  const ctx = {
    get: (name: string) => (name === 'llm' ? live : undefined),
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  } as never
  const runtime = new MemoriesRuntime(ctx, { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())
  const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

  // In 0.1.7 the service can be provided by a row that runs after this plugin's,
  // so the activation snapshot is legitimately empty. Capturing it once — which
  // is what the plugin used to do — turned every later pass into a silent no-op
  // and left the watermark frozen for days.
  const before = await runtime.runExtraction(agent)
  assert.equal(before.stored, 0)
  assert.equal(before.reason, 'no-llm', 'the refusal names the missing service')

  live = fakeLlm(reply)
  assert.equal((await runtime.runExtraction(agent)).stored, 1, 'the pass picks the service up when it appears')
  assert.equal((await runtime.store.list('project', process.cwd(), { fresh: true })).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a session the registry knows but this process never settled is still mined', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-registry-'))
  const lines: string[] = []
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'Always run the tests with npm test here.' }])
  const reply = '{"memories":[{"scope":"project","title":"Run npm test","body":"Use `npm test`.","tags":["test"]}]}'
  const agent = {
    id: 'extract-session',
    session,
    status: 'idle',
    runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
  } as unknown as Agent
  const ctx = {
    get: (name: string) => {
      if (name === 'llm') return fakeLlm(reply)
      if (name === 'agents') return { roots: () => [agent] }
      return undefined
    },
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  const runtime = new MemoriesRuntime(ctx, { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())

  // `tracked` only holds agents that settled in THIS process, so a restored
  // window is invisible to it. The live registry is the second source.
  await runtime.runPeriodicPass()

  assert.equal((await runtime.store.list('project', process.cwd(), { fresh: true })).length, 1,
    'a registry session is mined without ever settling here')
  const pass = lines.find((line) => line.startsWith('dsh-memories: extract pass:'))
  assert.ok(pass !== undefined, 'the pass reports itself')
  assert.match(pass, /%d live, %d considered/u, 'the line separates what was live from what was considered')
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
    assert.equal((await runtime.runExtraction(agent)).stored, 0)
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
  assert.equal((await runtime.runExtraction(agent)).stored, 0)
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
  assert.equal((await reopened.runExtraction(agent)).stored, 0)
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

test('a successful pass writes the evidence note behind the drafts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-evidence-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"summary":"The user explained how this project ships.","memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())
  const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

  assert.equal((await runtime.runExtraction(agent)).stored, 1)
  const note = await runtime.store.readSessionNote('extract-session')
  assert.equal(note?.summary, 'The user explained how this project ships.')
  assert.deepEqual(note?.memories, ['deploy-with-pnpm-run-ship'])
  const stored = (await runtime.store.list('project', process.cwd(), { fresh: true }))[0]
  assert.equal(stored?.sourceSession, 'extract-session')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the settle timer actually runs a pass once its wait elapses', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-settle-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  // Short waits on both knobs: this is the whole settle path — timer, quiet-window
  // gate, pass, watermark — and it is what the shipped defaults could never reach
  // (a 5 minute timer guarded by a 6 hour window, with no re-arm). The idle delay
  // is clamped to a 1000 ms floor, so this is as short as the timer can be.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 0,
    autoExtractIdleMs: 1_000,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = {
    id: 'settle-session',
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent

  runtime.scheduleExtraction(agent)
  await new Promise((settle) => setTimeout(settle, 1_400))
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1, 'the settle timer mined the session')
  assert.equal((await runtime.store.list('project', process.cwd(), { fresh: true })).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the exit flush mines a session that never had its quiet window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-flush-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  // A six-hour quiet window against an immediate exit: the timer cannot be what
  // saves this session, only the forced flush can.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), { memoriesDir: dir, autoExtract: true, minIdleHours: 6, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())
  // `mine` claims the idle phase through `runMaintenance`, so the stub has to
  // provide it the way a real agent does.
  const agent = {
    id: 'flush-session',
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent
  runtime.scheduleExtraction(agent)

  assert.equal(await runtime.flushExit(5_000), 1, 'the exit boundary ignores the quiet window')
  // The watermark is keyed by the session, not by the agent id.
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('peak hours hold back the automatic passes but not an explicit one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-peak-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  // `* 00:00-24:00` is peak forever, which makes the gate deterministic to test;
  // a real timetable would only be in or out depending on when the suite runs.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 0,
    peakHours: '* 00:00-24:00',
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = {
    id: 'peak-session',
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent

  runtime.scheduleExtraction(agent)
  await new Promise((settle) => setTimeout(settle, 1_300))
  assert.equal(runtime.state.getSession('extract-session'), undefined, 'the settle timer waits the window out')
  assert.equal(await runtime.flushExit(5_000), 0, 'the exit flush is an automatic spend, so it defers too')
  assert.equal(await runtime.mineNow(agent), 1, 'an explicit /memories mine ignores the window')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

/** The agent stub every periodic test needs: idle, and able to claim the idle phase. */
function idleAgent(session: Session, id = 'periodic-session'): Agent {
  return {
    id,
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent
}

test('a periodic pass mines new material and costs nothing when there is none', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-periodic-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":[]}]}'
  const seen: { user?: string | undefined } = {}
  // The quiet window is six hours, so the settle path could not fire for hours:
  // the periodic check is what mines this session, and it must not consult that
  // window — the whole point is to capture while the session is still running.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply, seen)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 6,
    extractIntervalMinutes: 30,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = idleAgent(session)
  runtime.scheduleExtraction(agent)

  await runtime.runPeriodicPass()
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1, 'the slice was mined')
  assert.ok(seen.user !== undefined, 'the first pass called the model')

  // Nothing new since the watermark: the next pass must not spend a call.
  seen.user = undefined
  await runtime.runPeriodicPass()
  assert.equal(seen.user, undefined, 'a session with nothing new costs no model call')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a periodic pass respects the peak window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-periodic-peak-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship it.","tags":[]}]}'
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    extractIntervalMinutes: 30,
    peakHours: '* 00:00-24:00',
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  runtime.scheduleExtraction(idleAgent(session))

  await runtime.runPeriodicPass()
  assert.equal(runtime.state.getSession('extract-session'), undefined, 'spending waits for off-peak')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the periodic timer actually runs a pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-periodic-timer-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship it.","tags":[]}]}'
  // 0.02 minutes ≈ 1.2s: fractional intervals are kept, which is what makes this
  // testable without waiting half an hour.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    extractIntervalMinutes: 0.02,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  runtime.scheduleExtraction(idleAgent(session))
  runtime.startPeriodicExtraction()

  await new Promise((settle) => setTimeout(settle, 1_600))
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1, 'the interval fired')
  runtime.stopPeriodicExtraction()
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the exit flush still mines what arrived after a periodic pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-periodic-flush-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship it.","tags":[]}]}'
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 6,
    extractIntervalMinutes: 30,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = idleAgent(session)
  runtime.scheduleExtraction(agent)

  await runtime.runPeriodicPass()
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1)
  // The turn continues after the periodic pass, and then the process exits: the
  // flush must look at the content, not at "have we mined this session already".
  ;(session as unknown as { append: (event: { seq: number; role: 'user'; text: string }) => void })
    .append({ seq: 2, role: 'user', text: 'Also run tsc before publishing.' })
  assert.equal(await runtime.flushExit(5_000), 1, 'new material is not skipped by a per-process flag')
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 2)
  t.after(() => rm(dir, { recursive: true, force: true }))
})
