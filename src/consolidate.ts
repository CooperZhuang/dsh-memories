/**
 * Stage 2: consolidation of staged memories into the live store.
 *
 * Stage 1 (the idle extractor) writes what each session learned into the store
 * one session at a time. That is fast and cheap but it cannot resolve anything
 * ACROSS sessions: two sessions can state contradictory facts, five sessions can
 * each record a fragment of one procedure, and nothing ever decides which of
 * them is the current truth.
 *
 * Consolidation is the second pass. It hands the recent memories to a
 * restricted sub-agent whose only job is to return a merged set — replacing,
 * merging, or retiring entries — as strict JSON. The plugin then applies that
 * JSON itself, so the child never touches the store and the write path stays in
 * one place with a snapshot to roll back to.
 *
 * @module dsh-memories/consolidate
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryEntry, MemoryDraft, MemoryScope } from './types.js'

/** System instruction for the consolidation sub-agent. */
export const CONSOLIDATE_SYSTEM = [
  'You maintain the long-term memory of a coding assistant. You are given the CURRENT memories and must return a better set.',
  '',
  'You may:',
  '- MERGE several memories that describe the same thing into one clear memory.',
  '- REPLACE a memory that is now wrong or superseded, keeping its id.',
  '- RETIRE a memory that is stale, trivial, duplicated, or no longer true.',
  '- ADD a memory only when the input clearly states a durable fact that no current memory captures.',
  '',
  'Rules:',
  '- Preserve every id you keep. A returned memory with an existing id REPLACES that memory; a new id ADDS one.',
  '- Prefer fewer, sharper memories. Never invent facts that are not in the input.',
  '- Keep scope honest: a fact that is only true in one workspace stays "project"; a durable user preference or general tooling fact is "global".',
  '- Do not record secrets, credentials, transient task state, or restatements of code.',
  '- Write each body as 1-4 self-contained sentences. Titles are short and imperative.',
  '',
  'Reply with JSON only, no prose and no code fence:',
  '{"memories":[{"id":string|null,"scope":"global"|"project","title":string,"body":string,"tags":string[]}],"retire":[string],"notes":string}',
  'Use null for the id of a new memory. "retire" lists ids to delete. "notes" is one short sentence about what you changed.',
].join('\n')

/** JSON output contract for one consolidation call. */
export const CONSOLIDATE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['memories'],
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'title', 'body'],
        properties: {
          id: { type: ['string', 'null'] },
          scope: { type: 'string', enum: ['global', 'project'] },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    retire: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
} as const

/** One consolidation proposal, already validated against the input. */
export interface ConsolidationPlan {
  /** Memories to add or replace, keyed by the id they replace (or `undefined` to add). */
  readonly upserts: readonly { id: string | null; scope: MemoryScope; title: string; body: string; tags: readonly string[] }[]
  /** Ids to delete. */
  readonly retire: readonly string[]
  /** The sub-agent's one-line account of what it changed. */
  readonly notes: string
}

/** Render the input document handed to the consolidation agent. */
export function renderConsolidationInput(entries: readonly MemoryEntry[], projectLabel: string): string {
  const sections = new Map<MemoryScope, MemoryEntry[]>()
  for (const entry of entries) {
    const list = sections.get(entry.scope)
    if (list === undefined) sections.set(entry.scope, [entry])
    else list.push(entry)
  }
  const blocks: string[] = [`Workspace scope label: ${projectLabel}`, `Current memories: ${entries.length}`, '']
  for (const scope of ['global', 'project'] as const) {
    const list = sections.get(scope)
    if (list === undefined || list.length === 0) continue
    blocks.push(`## ${scope}`)
    for (const entry of list) {
      blocks.push(`- id: ${entry.id}`)
      blocks.push(`  title: ${entry.title}`)
      blocks.push(`  tags: ${entry.tags.join(', ') || '(none)'}`)
      blocks.push(`  body: ${entry.body.replace(/\n+/gu, ' ')}`)
    }
    blocks.push('')
  }
  return blocks.join('\n')
}

/** Parse and validate the agent's JSON reply into a plan. */
export function parsePlan(text: string, knownIds: ReadonlySet<string>, maxUpserts: number): ConsolidationPlan | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const rawMemories = Array.isArray(record['memories']) ? record['memories'] : []
  const upserts: ConsolidationPlan['upserts'][number][] = []
  const seen = new Set<string>()
  for (const item of rawMemories) {
    if (upserts.length >= maxUpserts) break
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const scope = entry['scope']
    const title = entry['title']
    const body = entry['body']
    if (scope !== 'global' && scope !== 'project') continue
    if (typeof title !== 'string' || typeof body !== 'string') continue
    const cleanTitle = title.replace(/\s+/gu, ' ').trim().slice(0, 120)
    const cleanBody = body.trim().slice(0, 2000)
    if (cleanTitle.length === 0 || cleanBody.length === 0) continue
    // A "replace" id the store does not know is treated as a new memory: the
    // agent inventing an id must not create a dangling reference.
    const rawId = entry['id']
    const id = typeof rawId === 'string' && knownIds.has(rawId) ? rawId : null
    if (id !== null && seen.has(id)) continue
    if (id !== null) seen.add(id)
    const tags = Array.isArray(entry['tags']) ? entry['tags'].filter((tag): tag is string => typeof tag === 'string') : []
    upserts.push({ id, scope, title: cleanTitle, body: cleanBody, tags })
  }
  const rawRetire = Array.isArray(record['retire']) ? record['retire'] : []
  const retired = new Set<string>()
  for (const value of rawRetire) {
    if (typeof value !== 'string') continue
    // Only ids the store actually has, and never one this plan rewrites.
    if (!knownIds.has(value) || seen.has(value)) continue
    retired.add(value)
  }
  if (upserts.length === 0 && retired.size === 0) return undefined
  return {
    upserts,
    retire: [...retired],
    notes: typeof record['notes'] === 'string' ? record['notes'].slice(0, 300) : '',
  }
}

/** Everything one consolidation run needs. */
export interface ConsolidateRequest {
  /** The agent whose subagent seam is used; also the lineage parent. */
  readonly parent: Agent
  /** Provider the child should use, defaulting to the parent's own route. */
  readonly provider?: string
  readonly model?: string
  /** Entries to consider, newest first. */
  readonly entries: readonly MemoryEntry[]
  /** Model-facing project label. */
  readonly projectLabel: string
  /** Cap on returned memories. */
  readonly maxUpserts: number
  /** Deadline for the child run. */
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** The subagent seam this module consumes, kept structural for testability. */
export interface SubagentSeam {
  start(name: string, request: {
    prompt: { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: { provider?: string; model?: string }
    outputSchema?: unknown
    maxDepth?: number
    toolFilter?: { deny?: readonly string[]; allow?: readonly string[] }
    persona?: string
  }): Promise<{ result: Promise<{ output: readonly unknown[]; structured?: unknown; stopReason?: { kind: string } }> }>
}

/** Tools the consolidation child must not have: it reads and proposes, nothing else. */
export const CONSOLIDATE_DENY_TOOLS = [
  'write', 'edit', 'str_replace_editor', 'pwsh', 'bash', 'terminal',
  'web_search', 'web_fetch', 'subagent', 'subagent_fork', 'workflow', 'ralph',
  'job_kill', 'interrupt_agent', 'memory', 'todo_write', 'create_goal', 'update_goal',
] as const

/**
 * Run one consolidation through a restricted sub-agent.
 * @param seam - the `ctx.subagents` service.
 * @param request - entries, route, caps, and cancellation.
 * @returns the validated plan, or `undefined` when the child produced none.
 */
export async function runConsolidation(seam: SubagentSeam, request: ConsolidateRequest): Promise<ConsolidationPlan | undefined> {
  if (request.entries.length === 0) return undefined
  const known = new Set(request.entries.map((entry) => entry.id))
  const input = renderConsolidationInput(request.entries, request.projectLabel)
  const timeout = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  const run = await seam.start('spawn', {
    prompt: [{ type: 'text', text: `${CONSOLIDATE_SYSTEM}\n\n---\n\n${input}` }],
    parent: request.parent,
    signal: timeout,
    ...request.provider !== undefined && request.model !== undefined
      ? { agentOptions: { provider: request.provider, model: request.model } }
      : {},
    outputSchema: CONSOLIDATE_JSON_SCHEMA,
    // The child may not delegate further, may not write anything, and may not
    // reach the network: its only output is the JSON plan it returns.
    maxDepth: 0,
    toolFilter: { deny: [...CONSOLIDATE_DENY_TOOLS] },
  })
  const result = await run.result
  const text = typeof result.structured === 'object' && result.structured !== null
    ? JSON.stringify(result.structured)
    : result.output
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  return parsePlan(text, known, request.maxUpserts)
}

/** A snapshot of the store taken before applying a plan, used to roll back. */
export interface ConsolidationSnapshot {
  /** Entries as they were before the plan ran. */
  readonly entries: readonly MemoryEntry[]
}

/** Apply one plan against a store-like target. */
export interface ConsolidationTarget {
  /** Write one entry, keeping `keepId` when given. */
  upsert(draft: MemoryDraft, projectRoot: string | undefined, source: MemoryEntry['source'], keepId?: string): Promise<{ entry: MemoryEntry; action: 'created' | 'updated' }>
  /** Delete one entry by id. */
  remove(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean>
}

/** The outcome of applying a plan. */
export interface ConsolidationResult {
  readonly written: number
  readonly retired: number
  readonly notes: string
}

/**
 * Apply a plan, restoring the snapshot when a write fails.
 *
 * The child proposes; this function is the only writer. Applying is all-or-
 * nothing: a failure mid-plan puts the entries it already touched back the way
 * they were, so a half-consolidated store is never left behind.
 *
 * @param plan - the validated plan.
 * @param target - the store to write to.
 * @param projectRoot - workspace root for project entries.
 * @param snapshot - entries as they were before the plan.
 * @returns how many entries were written and retired.
 */
export async function applyPlan(
  plan: ConsolidationPlan,
  target: ConsolidationTarget,
  projectRoot: string | undefined,
  snapshot: ConsolidationSnapshot,
): Promise<ConsolidationResult> {
  const before = new Map(snapshot.entries.map((entry) => [`${entry.scope}\u0000${entry.id}`, entry]))
  const touched: { scope: MemoryScope; id: string }[] = []
  try {
    for (const item of plan.upserts) {
      const draft: MemoryDraft = { scope: item.scope, title: item.title, body: item.body, tags: item.tags }
      const result = await target.upsert(draft, item.scope === 'project' ? projectRoot : undefined, 'auto', item.id ?? undefined)
      touched.push({ scope: result.entry.scope, id: result.entry.id })
    }
    for (const id of plan.retire) {
      await target.remove('global', projectRoot, id)
      await target.remove('project', projectRoot, id)
    }
    return { written: plan.upserts.length, retired: plan.retire.length, notes: plan.notes }
  } catch (error) {
    // Restore every entry the plan may have changed, then rethrow so the caller
    // can log it and retry with backoff.
    for (const item of touched) {
      const original = before.get(`${item.scope}\u0000${item.id}`)
      if (original === undefined) continue
      await target.upsert(
        { scope: original.scope, title: original.title, body: original.body, tags: original.tags },
        original.scope === 'project' ? projectRoot : undefined,
        original.source,
        original.id,
      )
    }
    throw error
  }
}
