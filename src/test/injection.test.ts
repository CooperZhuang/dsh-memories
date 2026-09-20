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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime, isCatchAllDirectory } from '../index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in: header, id, header fold, and a controllable history. */
function stubSession(cwd: string | undefined, history: readonly unknown[] = []): Session {
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

test('the harness home is not a workspace, so its sessions have no project scope', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memories-home-'))
  const dir = join(home, 'memories')
  const runtime = new MemoriesRuntime(stubContext, { dshHome: home, memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(home, { recursive: true, force: true }))

  const agent = stubAgent(stubSession(home))
  assert.equal(await runtime.projectRoot(agent.session), undefined, 'the harness home has no project scope')

  // A project draft from such a session is stored globally rather than dropped:
  // the extractor cannot know the session has no workspace.
  const stored = await runtime.write(agent.session, { scope: 'project', title: 'Mixed fact', body: 'From a home-directory session.', tags: [] }, 'tool')
  assert.equal(stored.entry.scope, 'global')
  assert.deepEqual(await runtime.store.listProjects(), [], 'no project bucket is created for the harness home')

  // A subdirectory of the harness home is still the harness home.
  const nested = stubAgent(stubSession(join(home, 'logs')))
  assert.equal(await runtime.projectRoot(nested.session), undefined)

  // A real repository underneath another root keeps its own scope.
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memories-ws-'))
  const inside = stubAgent(stubSession(workspace))
  assert.equal(await runtime.projectRoot(inside.session), workspace)
  t.after(() => rm(workspace, { recursive: true, force: true }))
})

test('the global section is capped so it cannot bury the project scope', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-cap-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memories-ws-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, globalSummaryEntries: 2 })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const agent = stubAgent(stubSession(workspace))

  for (let index = 0; index < 12; index += 1) {
    await runtime.write(agent.session, { scope: 'global', title: `Portable fact ${index}`, body: 'True everywhere.', tags: [] }, 'auto')
  }
  await runtime.write(agent.session, { scope: 'project', title: 'This repo is special', body: 'Only true here.', tags: [] }, 'tool')

  const summary = await runtime.summary(agent.session)
  assert.ok(summary !== undefined)
  const [globalPart, projectPart] = summary.split('\n## Project')
  const globalBullets = (globalPart ?? '').split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- …'))
  assert.equal(globalBullets.length, 2, 'the global half stops at its own cap')
  assert.match(projectPart ?? '', /This repo is special/u, 'and the project half still appears')
})

test('the global half is bounded in bytes, not only in entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-gbytes-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memories-ws-'))
  const runtime = new MemoriesRuntime(stubContext, {
    memoriesDir: dir,
    autoExtract: false,
    globalSummaryEntries: 12,
    globalSummaryBytes: 700,
  })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const agent = stubAgent(stubSession(workspace))

  // Chinese entries cost about three bytes per character, so a count cap alone
  // still let the global half take most of a 4 KB block.
  for (let index = 0; index < 12; index += 1) {
    await runtime.write(agent.session, {
      scope: 'global',
      title: `本机环境事实 ${index}`,
      body: `这是一条很长的中文背景说明，用来确认真实字节数而不是字符数决定了注入预算的分配。第 ${index} 条。`,
      tags: [],
    }, 'auto')
  }
  await runtime.write(agent.session, { scope: 'project', title: 'This repo is special', body: 'Only true here.', tags: [] }, 'tool')

  const summary = await runtime.summary(agent.session)
  assert.ok(summary !== undefined)
  const [globalPart] = summary.split('\n## Project')
  assert.ok(Buffer.byteLength(globalPart ?? '', 'utf8') < 1_100, 'the global section stays inside its byte budget')
  assert.match(summary, /This repo is special/u, 'and the project half is still there')
})

test('a global draft that names a known workspace is filed with that workspace', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-scopeguard-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memories-ws-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const agent = stubAgent(stubSession(workspace))

  // The project scope has to exist for the guard to know about this workspace.
  await runtime.write(agent.session, { scope: 'project', title: 'Repo layout', body: 'Sources under src.', tags: [] }, 'tool')

  // A global memory follows the user into every unrelated project, so a draft
  // that quotes this workspace's own path belongs to this workspace instead.
  const misfiled = await runtime.write(agent.session, {
    scope: 'global',
    title: 'Invoice export rule',
    body: `The exporter only reads ${workspace}\\invoices.`,
    tags: [],
  }, 'auto')
  assert.equal(misfiled.entry.scope, 'project', 'the cited path decides the scope')

  // A memory that names no workspace stays global.
  const portable = await runtime.write(agent.session, {
    scope: 'global',
    title: 'Prefer pnpm',
    body: 'Use pnpm rather than npm.',
    tags: [],
  }, 'tool')
  assert.equal(portable.entry.scope, 'global')
})

test('the user home directory itself is not a workspace', () => {
  assert.equal(isCatchAllDirectory(homedir(), 'C:\\harness-home'), true)
  assert.equal(isCatchAllDirectory(join(homedir(), 'AppData', 'LocalLow', 'SomeGame'), 'C:\\harness-home'), false)
})

test('a global draft is never rerouted into a catch-all directory', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memories-home-'))
  const dir = join(home, 'memories')
  const runtime = new MemoriesRuntime(stubContext, { dshHome: home, memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(home, { recursive: true, force: true }))

  // A descriptor for the harness home can outlive the guard that stopped new
  // ones being created. A machine-level fact quoting a path there belongs in
  // global: filing it under the home scope hides it from every other workspace.
  const entry = await runtime.write(stubAgent(stubSession(home)).session, {
    scope: 'global',
    title: 'Helper lives in the harness home',
    body: `The helper is ${home}\\restart.mjs, and its log sits beside it.`,
    tags: [],
  }, 'tool')
  assert.equal(entry.entry.scope, 'global', 'a catch-all directory is never a reroute target')
  assert.deepEqual(await runtime.store.listProjects(), [], 'and no scope is created for it')
})

test('a session with no recorded cwd has no project scope either', async (t) => {  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-nocwd-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  const session = stubSession(undefined)
  assert.equal(await runtime.projectRoot(session), undefined, 'no cwd means no workspace, not "wherever the host runs"')
  assert.match(await runtime.stats(session), /project:none: 0 memories/u)
})

test('an injected memory the turn is about earns a use', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-helped-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  const agent = stubAgent(stubSession(dir, [{
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '发票 OCR 手写字段要怎么补摘？' }],
  }]))

  const stored = await runtime.write(agent.session, {
    scope: 'global',
    title: '发票 OCR 手写字段补摘',
    body: '按版面语义抽字段，不要用首个正则命中。',
    tags: ['ocr'],
  }, 'tool')
  assert.equal(stored.entry.uses, 0)

  assert.ok(await runtime.injectionFor(agent) !== undefined, 'the block is injected first')
  await runtime.creditInjectedUse(agent)
  const after = await runtime.read(agent.session, 'global', stored.entry.id, false)
  assert.ok((after?.uses ?? 0) >= 1, 'the conversation used the memory it was handed')

  // Once per conversation: later steps must not keep inflating the count.
  await runtime.creditInjectedUse(agent)
  const again = await runtime.read(agent.session, 'global', stored.entry.id, false)
  assert.equal(again?.uses, after?.uses)
})

test('a turn that only brushes past an injected memory earns nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-helped2-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  const agent = stubAgent(stubSession(dir, [{
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '把这次改动提交一下，然后继续说别的。' }],
  }]))
  const stored = await runtime.write(agent.session, {
    scope: 'global',
    title: '发票 OCR 手写字段补摘',
    body: '按版面语义抽字段，不要用首个正则命中。',
    tags: ['ocr'],
  }, 'tool')
  await runtime.injectionFor(agent)
  await runtime.creditInjectedUse(agent)
  const after = await runtime.read(agent.session, 'global', stored.entry.id, false)
  assert.equal(after?.uses, 0, 'a shared common word must not count as use')
})

test('a scope that has filled up still shows a memory written after it filled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-saturated-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  t.after(() => rm(dir, { recursive: true, force: true }))
  const agent = stubAgent(stubSession(dir))
  const now = Date.now()

  // Twenty long-standing, well-read entries: each one outranks anything new.
  for (let index = 0; index < 20; index += 1) {
    const { entry } = await runtime.write(agent.session, { scope: 'global', title: `Old fact ${index}`, body: 'Been here for months.', tags: [] }, 'auto')
    await runtime.store.writeCounters(entry, undefined, { uses: 6, lastUsedAt: now, surfacedAt: now })
  }
  // The correction arrives last, reads zero, and has never been listed.
  await runtime.write(agent.session, { scope: 'global', title: 'The correction', body: 'This supersedes one of the old facts.', tags: [] }, 'tool')

  const summary = await runtime.summary(agent.session)
  assert.ok(summary !== undefined)
  assert.match(summary, /The correction/u, 'the reserved slot is what makes a new memory visible')
  assert.match(summary, /… 9 more not shown|… \d+ more not shown/u, 'the block still says how much it hides')
})
