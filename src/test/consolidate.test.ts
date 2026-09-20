/**
 * Tests for stage-2 consolidation.
 *
 * The child agent is a stub here; what matters is the boundary the plugin owns:
 * a plan is validated against the ids that actually exist, application is
 * all-or-nothing, and a failure puts the store back the way it was.
 *
 * @module dsh-memories/test/consolidate.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  CONSOLIDATE_DENY_TOOLS,
  CONSOLIDATE_JSON_SCHEMA,
  denyToolsFor,
  applyPlan,
  parsePlan,
  renderConsolidationInput,
  runConsolidation,
} from '../consolidate.js'
import type { ConsolidationTarget, SubagentSeam } from '../consolidate.js'
import type { MemoryDraft, MemoryEntry, MemoryScope } from '../types.js'

/** Build one entry. */
function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'title' | 'body'>): MemoryEntry {
  return { scope: 'global', kind: 'fact', tags: [], keys: [], createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: 0, lastSurfacedAt: 0, source: 'auto', ...partial }
}

/** A stub subagent seam recording the request and replaying one reply. */
function seam(reply: string, seen: { request?: unknown } = {}): SubagentSeam {
  return {
    start: async (_name, request) => {
      seen.request = request
      return { result: Promise.resolve({ output: [{ type: 'text', text: reply }], structured: undefined, stopReason: { kind: 'completed' } }) }
    },
  }
}

/** An in-memory store target that can be made to fail on demand. */
function target(initial: MemoryEntry[], failOn?: string) {
  const entries = new Map(initial.map((item) => [`${item.scope}\u0000${item.id}`, item]))
  const writes: string[] = []
  const api: ConsolidationTarget = {
    upsert: async (draft: MemoryDraft, _root, source, keepId) => {
      const id = keepId ?? draft.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-')
      if (failOn === id) throw new Error('write exploded')
      writes.push(`upsert:${id}`)
      const existing = entries.get(`${draft.scope}\u0000${id}`)
      const next: MemoryEntry = {
        id,
        scope: draft.scope,
        kind: draft.kind ?? 'fact',
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        keys: draft.keys ?? existing?.keys ?? [],
        createdAt: existing?.createdAt ?? 1,
        updatedAt: 2,
        uses: existing?.uses ?? 0,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        lastSurfacedAt: existing?.lastSurfacedAt ?? 0,
        source,
      }
      entries.set(`${draft.scope}\u0000${id}`, next)
      return { entry: next, action: existing === undefined ? 'created' as const : 'updated' as const }
    },
    archive: async (scope: MemoryScope, _root, id) => {
      writes.push(`archive:${id}`)
      return entries.delete(`${scope}\u0000${id}`)
    },
    restore: async (scope: MemoryScope, _root, id) => {
      writes.push(`restore:${id}`)
      return entries.has(`${scope}\u0000${id}`)
    },
  }
  return { api, writes, get: (scope: MemoryScope, id: string) => entries.get(`${scope}\u0000${id}`), all: () => [...entries.values()] }
}

test('the consolidation schema is accepted by the harness schema subset', () => {
  // The child run fails at start if the harness rejects the schema, and the
  // failure is opaque ("unsupported JSON schema: ..."), so validate it here
  // with the same function the subagent seam uses. `type: ["string","null"]`
  // for a nullable field is exactly what this catches.
  assert.doesNotThrow(() => { assertObjectJsonSchema(CONSOLIDATE_JSON_SCHEMA) })
})

test('denyToolsFor keeps only names the registry actually has', () => {
  // The deny list is cross-platform; `tools.restrict()` rejects an unknown
  // name, so passing the raw list would sink every consolidation pass.
  const available = new Set(['write', 'edit', 'pwsh', 'read', 'memory', 'subagent_fork'])
  const denied = denyToolsFor(available)
  assert.ok(denied.includes('write'))
  assert.ok(denied.includes('pwsh'))
  assert.ok(denied.includes('subagent_fork'))
  assert.ok(!denied.includes('bash'), 'bash is not registered on this deployment')
  assert.ok(!denied.includes('str_replace_editor'), 'that name does not exist here')
  assert.ok(!denied.includes('read'), 'read stays available to the child')
  assert.equal(denyToolsFor(new Set()).length, 0)
})

test('the consolidation child is denied every write and network tool', async () => {
  const seen: { request?: unknown } = {}
  const reply = '{"memories":[{"id":null,"scope":"global","title":"t","body":"b"}],"retire":[],"notes":"n"}'
  await runConsolidation(seam(reply, seen), {
    parent: {} as never,
    entries: [entry({ id: 'a', title: 'A', body: 'a' })],
    projectLabel: 'project:x',
    maxUpserts: 10,
    denyTools: [...CONSOLIDATE_DENY_TOOLS],
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  const request = seen.request as { toolFilter: { deny: string[] }; maxDepth: number; outputSchema: unknown }
  for (const tool of ['write', 'edit', 'pwsh', 'web_search', 'subagent', 'memory']) {
    assert.ok(request.toolFilter.deny.includes(tool), `${tool} must be denied to the consolidation child`)
  }
  // DSH counts depth from 1 (a top-level agent is 0, its child is 1): the cap
  // must admit THIS child while refusing a grandchild. `0` rejects the child
  // itself, which is the bug this pins.
  assert.equal(request.maxDepth, 1, 'the child runs, but cannot delegate further')
  assert.ok(request.outputSchema !== undefined, 'the child must answer through the JSON schema')
  assert.deepEqual([...CONSOLIDATE_DENY_TOOLS].length, request.toolFilter.deny.length)
})

test('renderConsolidationInput groups by scope and lists ids', () => {
  const text = renderConsolidationInput([
    entry({ id: 'g1', title: 'Global one', body: 'g', scope: 'global', tags: ['x'] }),
    entry({ id: 'p1', title: 'Project one', body: 'p', scope: 'project' }),
  ], 'project:demo')
  assert.match(text, /Workspace scope label: project:demo/u)
  assert.match(text, /## global/u)
  assert.match(text, /## project/u)
  assert.match(text, /id: g1/u)
  assert.match(text, /id: p1/u)
})

test('parsePlan keeps only ids that exist and drops self-contradictory retirements', () => {
  const known = new Set(['keep-me', 'retire-me'])
  const plan = parsePlan(JSON.stringify({
    memories: [
      { id: 'keep-me', scope: 'global', title: 'Merged', body: 'merged body', tags: ['a'] },
      { id: 'invented', scope: 'project', title: 'New', body: 'new body' },
      { id: null, scope: 'global', title: 'Brand new', body: 'body' },
      { id: 'keep-me', scope: 'global', title: 'Duplicate id', body: 'ignored' },
      { scope: 'nonsense', title: 'Bad scope', body: 'x' },
    ],
    retire: ['retire-me', 'keep-me', 'not-known'],
    notes: 'merged two',
  }), known, 10)
  assert.ok(plan !== undefined)
  // The invented id becomes a new memory rather than a dangling reference.
  assert.deepEqual(plan.upserts.map((item) => item.id), ['keep-me', null, null])
  // `keep-me` is rewritten, so it cannot also be retired.
  assert.deepEqual(plan.retire, ['retire-me'])
  assert.equal(plan.notes, 'merged two')
})

test('parsePlan rejects a plan with nothing to do and tolerates a code fence', () => {
  assert.equal(parsePlan('{"memories":[],"retire":[]}', new Set(), 10), undefined)
  assert.equal(parsePlan('not json', new Set(['a']), 10), undefined)
  const fenced = parsePlan('```json\n{"memories":[{"id":null,"scope":"global","title":"t","body":"b"}]}\n```', new Set(), 10)
  assert.equal(fenced?.upserts.length, 1)
})

test('parsePlan caps the returned memories', () => {
  const reply = JSON.stringify({
    memories: Array.from({ length: 9 }, (_, index) => ({ id: null, scope: 'global', title: `t${index}`, body: 'b' })),
  })
  assert.equal(parsePlan(reply, new Set(), 3)?.upserts.length, 3)
})

test('runConsolidation reads the structured result when the provider returns one', async () => {
  const structured = { memories: [{ id: null, scope: 'global', title: 'From schema', body: 'body' }], retire: [], notes: 'ok' }
  const withSchema: SubagentSeam = {
    start: async () => ({ result: Promise.resolve({ output: [], structured, stopReason: { kind: 'completed' } }) }),
  }
  const plan = await runConsolidation(withSchema, {
    parent: {} as never,
    entries: [entry({ id: 'a', title: 'A', body: 'a' })],
    projectLabel: 'project:x',
    maxUpserts: 5,
    denyTools: [...CONSOLIDATE_DENY_TOOLS],
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  assert.equal(plan?.upserts[0]?.title, 'From schema')
})

test('applyPlan merges and retires through the target', async () => {
  const first = entry({ id: 'a', title: 'A', body: 'a' })
  const second = entry({ id: 'b', title: 'B', body: 'b' })
  const store = target([first, second])
  const result = await applyPlan({
    upserts: [{ id: 'a', scope: 'global', kind: 'preference', title: 'A merged', body: 'merged', tags: [], keys: ['alias'] }, { id: null, scope: 'project', kind: 'fact', title: 'New', body: 'new', tags: [] }],
    retire: ['b'],
    skills: [],
    notes: 'merged',
  }, store.api, undefined, { entries: [first, second] })
  assert.deepEqual(result, { written: 2, retired: 1, notes: 'merged' })
  assert.deepEqual([...(store.get('global', 'a')?.keys ?? [])], ['alias'], 'a merged memory keeps the keys it was given')
  assert.equal(store.get('global', 'a')?.title, 'A merged')
  assert.equal(store.get('project', 'new')?.body, 'new')
  assert.equal(store.get('global', 'b'), undefined)
})

test('applyPlan keeps the provenance of the memory it rewrites', async () => {
  const written = entry({ id: 'rule', title: 'Never break the prompt cache', body: 'only append', source: 'user' })
  const store = target([written])
  await applyPlan({
    upserts: [{ id: 'rule', scope: 'global', kind: 'preference', title: 'Never break the prompt cache', body: 'only append, never touch the prefix', tags: [] }],
    retire: [],
    skills: [],
    notes: 'sharpened',
  }, store.api, undefined, { entries: [written] })

  // `auto` means "an extractor's guess": stamping it on a rewrite of somebody's
  // own rule loses both the ranking bonus and the retention exemption, and one
  // real consolidation run demoted the user's prompt-cache rule that way.
  assert.equal(store.get('global', 'rule')?.source, 'user', 'a rewrite does not demote an explicit memory')
})

test('applyPlan restores what it changed when a write fails', async () => {
  const first = entry({ id: 'a', title: 'A', body: 'original a' })
  const store = target([first], 'b')
  await assert.rejects(() => applyPlan({
    upserts: [
      { id: 'a', scope: 'global', kind: 'fact', title: 'A changed', body: 'changed', tags: [] },
      { id: 'b', scope: 'global', kind: 'fact', title: 'B', body: 'b', tags: [] },
    ],
    retire: [],
    skills: [],
    notes: '',
  }, store.api, undefined, { entries: [first] }), /write exploded/u)
  // The first write is rolled back to the snapshot's content.
  assert.equal(store.get('global', 'a')?.body, 'original a')
})
