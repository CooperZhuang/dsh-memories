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
import { toMemoryKind } from './types.js'
import type { MemoryEntry, MemoryDraft, MemoryKind, MemoryScope } from './types.js'

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
  '- Keep scope honest: a fact that is only true in one workspace stays "project"; a durable user preference or general tooling fact is "global". A fact that names a specific employer, product, customer, repository path, drive letter or internal host is NEVER global.',
  '- Keep the kind honest: "preference" for how the user wants work done, "failure" for something that went wrong, "procedure" for an ordered recipe, "knowledge" for a non-obvious technique, "fact" for background.',
  '- Do not record secrets, credentials, transient task state, or restatements of code.',
  '- Write every title, body and appliesTo in Simplified Chinese, keeping paths, commands, identifiers and product names exactly as they are. A memory the model wrote in Chinese must not come back in English.',
  '- The injected summary shows only the title and roughly the first 200 characters of the body, so lead with the trigger and the decision; put the detail after. This matters most when merging: the merged body must open with the one thing a future session needs.',
  '- Always provide "appliesTo": a short phrase in the user\'s words saying when the memory matters ("准备推送代码之前"). When you rewrite a memory that already has one, carry it over unless the rewrite makes it wrong.',
  '- Never record a number that moves on its own (test counts, file or row counts, "ahead by N commits", a version that will be bumped). Record the command that produces the number instead, or mark the value 截至 <date>.',
  '- A problem that is already fixed is recorded as fixed ("已修 in <commit>"); never leave it reading as an open problem.',
  '- Write each body as 1-4 self-contained sentences. Titles are short and imperative.',
  '',
  'When two or more memories together describe a repeatable procedure that would be worth running again, also return it as a skill: a short kebab-case name, a one-line description, and the ordered steps. Skills are drafts a human promotes; return at most 2.',
  '',
  'Reply with JSON only, no prose and no code fence:',
  '{"memories":[{"id":string|null,"scope":"global"|"project","kind":string,"title":string,"body":string,"tags":string[],"keys":string[],"appliesTo":string}],"retire":[string],"skills":[{"name":string,"description":string,"steps":string[]}],"notes":string}',
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
        required: ['scope', 'title', 'body', 'appliesTo'],
        properties: {
          // A nullable field must be spelled with `oneOf`: the harness schema
          // subset rejects `type: ["string", "null"]`, and a rejected schema
          // fails the whole child run at start.
          id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          scope: { type: 'string', enum: ['global', 'project'] },
          kind: { type: 'string', enum: ['fact', 'preference', 'knowledge', 'failure', 'procedure'] },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          appliesTo: { type: 'string' },
        },
      },
    },
    retire: { type: 'array', items: { type: 'string' } },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'steps'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    notes: { type: 'string' },
  },
} as const

/** One skill draft proposed by a consolidation pass. */
export interface SkillDraft {
  /** Kebab-case skill name. */
  readonly name: string
  /** One-line description. */
  readonly description: string
  /** Ordered steps. */
  readonly steps: readonly string[]
}

/** One consolidation proposal, already validated against the input. */
export interface ConsolidationPlan {
  /** Memories to add or replace, keyed by the id they replace (or `undefined` to add). */
  readonly upserts: readonly { id: string | null; scope: MemoryScope; kind: MemoryKind; title: string; body: string; tags: readonly string[]; keys?: readonly string[]; appliesTo?: string }[]
  /** Ids to delete. */
  readonly retire: readonly string[]
  /** Skill drafts extracted from the memory set. */
  readonly skills: readonly SkillDraft[]
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
      blocks.push(`  keys: ${entry.keys.join(', ') || '(none)'}`)
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
    const keys = Array.isArray(entry['keys']) ? entry['keys'].filter((key): key is string => typeof key === 'string') : []
    const appliesTo = typeof entry['appliesTo'] === 'string' ? entry['appliesTo'].replace(/\s+/gu, ' ').trim().slice(0, 160) : ''
    upserts.push({
      id,
      scope,
      kind: toMemoryKind(entry['kind']),
      title: cleanTitle,
      body: cleanBody,
      tags,
      keys,
      ...appliesTo.length > 0 ? { appliesTo } : {},
    })
  }
  const rawRetire = Array.isArray(record['retire']) ? record['retire'] : []
  const retired = new Set<string>()
  for (const value of rawRetire) {
    if (typeof value !== 'string') continue
    // Only ids the store actually has, and never one this plan rewrites.
    if (!knownIds.has(value) || seen.has(value)) continue
    retired.add(value)
  }
  const skills = parseSkills(record['skills'])
  if (upserts.length === 0 && retired.size === 0 && skills.length === 0) return undefined
  return {
    upserts,
    retire: [...retired],
    skills,
    notes: typeof record['notes'] === 'string' ? record['notes'].slice(0, 300) : '',
  }
}

/**
 * Parse the skill drafts of one reply.
 *
 * A name is forced into the kebab-case grammar DSH's skill loader accepts, and
 * a draft without a usable name, description, or any step is dropped: a skill
 * that cannot be loaded is worse than no skill.
 * @param value - the raw `skills` field.
 * @returns the validated drafts, at most two.
 */
function parseSkills(value: unknown): SkillDraft[] {
  if (!Array.isArray(value)) return []
  const drafts: SkillDraft[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (drafts.length >= MAX_SKILL_DRAFTS) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const rawName = typeof record['name'] === 'string' ? record['name'] : ''
    const name = rawName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
    const description = typeof record['description'] === 'string' ? record['description'].replace(/\s+/gu, ' ').trim().slice(0, 300) : ''
    const steps = Array.isArray(record['steps'])
      ? record['steps'].filter((step): step is string => typeof step === 'string').map((step) => step.trim()).filter((step) => step.length > 0).slice(0, 20)
      : []
    if (name.length === 0 || description.length === 0 || steps.length === 0) continue
    if (seen.has(name)) continue
    seen.add(name)
    drafts.push({ name, description, steps })
  }
  return drafts
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
  /** Tool names to deny the child; must be names the registry actually has. */
  readonly denyTools: readonly string[]
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

/** Cap on skill drafts one pass may propose. */
const MAX_SKILL_DRAFTS = 2

/**
 * Tools the consolidation child must not have: it reads and proposes, nothing else.
 *
 * The list is deliberately cross-platform (it names both `bash` and `pwsh`,
 * both `str_replace_editor` and `edit`), so any single deployment has only a
 * subset. {@link denyToolsFor} narrows it before use.
 */
export const CONSOLIDATE_DENY_TOOLS = [
  'write', 'edit', 'str_replace_editor', 'pwsh', 'bash', 'terminal',
  'web_search', 'web_fetch', 'subagent', 'subagent_fork', 'workflow', 'ralph',
  'job_kill', 'interrupt_agent', 'memory', 'todo_write', 'create_goal', 'update_goal',
] as const

/**
 * Narrow the deny list to tools this deployment actually has.
 *
 * `tools.restrict()` fails loud on an unknown name — a feature, since a typo in
 * a filter must not silently leave a capability enabled. But a cross-platform
 * deny list names tools that do not exist here, and that loud failure would
 * sink every consolidation pass. Pass the registry's own names and this returns
 * the intersection.
 * @param available - every tool name the registry knows.
 * @returns the deny list, filtered to known names.
 */
export function denyToolsFor(available: ReadonlySet<string>): string[] {
  return CONSOLIDATE_DENY_TOOLS.filter((tool) => available.has(tool))
}

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
    //
    // `maxDepth` is the cap on the CHILD's depth, and DSH counts depth from 1
    // (a top-level agent is 0, its child is 1). So 1 admits this child and
    // rejects any grandchild — 0 would reject the child itself, which is how
    // this line was wrong the first time.
    maxDepth: 1,
    toolFilter: { deny: request.denyTools },
  })
  const result = await run.result
  const text = typeof result.structured === 'object' && result.structured !== null
    ? JSON.stringify(result.structured)
    : result.output
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  return parsePlan(text, known, request.maxUpserts)
}

/**
 * Choose which memories one consolidation pass reviews.
 *
 * The pass used to receive the newest N entries, which meant an old memory was
 * never looked at again: the first page never changed, so a stale fact deep in
 * the store was unreachable by the only mechanism that could retire it.
 * Selection prefers what was never reviewed, then what was reviewed longest
 * ago, so every memory is eventually reached while new material — and material
 * the model actually uses — still goes first.
 *
 * @param entries - every candidate entry.
 * @param reviewedAt - `scope\u0000id` → last review time, or 0 when never.
 * @param max - how many entries the pass may consider.
 * @returns the selection to hand the sub-agent.
 */
export function selectForConsolidation(
  entries: readonly MemoryEntry[],
  reviewedAt: ReadonlyMap<string, number>,
  max: number,
): readonly MemoryEntry[] {
  if (max <= 0) return []
  const key = (entry: MemoryEntry): string => `${entry.scope}\u0000${entry.id}`
  const selected: MemoryEntry[] = []
  const taken = new Set<string>()
  const fresh = entries.filter((entry) => (reviewedAt.get(key(entry)) ?? 0) === 0)
  fresh.sort((left, right) => right.uses - left.uses || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  for (const entry of fresh) {
    if (selected.length >= max) return selected
    selected.push(entry)
    taken.add(key(entry))
  }
  const rest = entries.filter((entry) => !taken.has(key(entry)))
  rest.sort((left, right) =>
    (reviewedAt.get(key(left)) ?? 0) - (reviewedAt.get(key(right)) ?? 0)
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id))
  for (const entry of rest) {
    if (selected.length >= max) break
    selected.push(entry)
  }
  return selected
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
  /** Move one entry out of the live store; returns whether it was there. */
  archive(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean>
  /** Put an archived entry back, used to roll back a failed plan. */
  restore(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean>
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
  /** Retirements already archived, so a failed plan can put them back. */
  const archived: { scope: MemoryScope; id: string }[] = []
  try {
    for (const item of plan.upserts) {
      // A rewrite keeps the provenance of what it rewrites. Stamping every
      // consolidation result `auto` demotes memories a person wrote: `auto` is
      // the extractor's guess, `tool`/`user` is somebody's statement, and the
      // distinction carries a ranking bonus and an exemption from retention.
      // Measured on a real store, one consolidation run demoted the user's own
      // "never break the prompt cache" rule to `auto`, which is what a guess is.
      const previous = item.id === null ? undefined : before.get(`${item.scope}\u0000${item.id}`)
      const draft: MemoryDraft = {
        scope: item.scope,
        title: item.title,
        body: item.body,
        tags: item.tags,
        keys: item.keys ?? [],
        ...item.appliesTo === undefined ? {} : { appliesTo: item.appliesTo },
      }
      const result = await target.upsert(
        draft,
        item.scope === 'project' ? projectRoot : undefined,
        previous?.source ?? 'auto',
        item.id ?? undefined,
      )
      touched.push({ scope: result.entry.scope, id: result.entry.id })
    }
    for (const id of plan.retire) {
      if (await target.archive('global', projectRoot, id)) archived.push({ scope: 'global', id })
      if (await target.archive('project', projectRoot, id)) archived.push({ scope: 'project', id })
    }
    return { written: plan.upserts.length, retired: plan.retire.length, notes: plan.notes }
  } catch (error) {
    // Restore every entry the plan may have changed, then rethrow so the caller
    // can log it and retry with backoff.
    for (const item of touched) {
      const original = before.get(`${item.scope}\u0000${item.id}`)
      if (original === undefined) continue
      await target.upsert(
        { scope: original.scope, title: original.title, body: original.body, tags: original.tags, keys: [...original.keys] },
        original.scope === 'project' ? projectRoot : undefined,
        original.source,
        original.id,
      )
    }
    // A retirement is an archival, not a deletion, so it can be put back
    // exactly; without this the store would lose entries to a plan that failed
    // for an unrelated reason later in the same run.
    for (const item of archived) {
      await target.restore(item.scope, projectRoot, item.id).catch(() => undefined)
    }
    throw error
  }
}
