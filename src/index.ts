/**
 * `dsh-memories` — cross-session memory for the DeepSeek Harness.
 *
 * Two scopes, mirroring the Codex memories split:
 *
 * - **global** — facts that hold across every project (`$DSH_HOME/memories`).
 * - **project** — facts tied to one workspace
 *   (`$DSH_HOME/memories/projects/<slug>`), shared by every session opened in
 *   that workspace, whichever subdirectory it starts in.
 *
 * Three cooperating mechanisms:
 *
 * 1. **Explicit capture** — the `memory` tool lets the model write, search,
 *    read, update, and forget entries, choosing the scope per call.
 * 2. **Idle-time extraction** — after a session has been quiet for
 *    `autoExtractIdleMs`, one auxiliary model call mines the transcript tail for
 *    durable facts and upserts them (deduplicated by title).
 * 3. **Layered injection** — a bounded summary of both scopes enters the
 *    conversation once, at the first step that has something to say; details
 *    stay behind `memory_search`.
 *
 * @module dsh-memories
 */
import { createUserMessage, isQuotaExceededError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, MemoriesSettingsSchema, SETTINGS_NS, consolidationRouteOf, normalizeSettings, resolveConfig } from './config.js'
import type { MemoriesConfig, MemoriesSettings, ResolvedConfig } from './config.js'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { MemoryStore, slugify } from './storage.js'
import { StateStore, importLegacyState, statePath } from './state.js'
import { browseMemories, explainEntry, searchMemories } from './search.js'
import type { MatchEvidence, ScopeEntries } from './search.js'
import { isSubstantiveTurn } from './query.js'
import { MEMORY_OPEN, rankForSummary, renderEntry, renderHit, renderMemorySummary, renderRecall, renderScopeListing, selectForSummary } from './render.js'
import type { SummaryScope } from './render.js'
import { findProjectRoot, isWithin } from './workspace.js'
import { planRetention, retentionKey } from './retention.js'
import { MemoryLog, createFileSink, createLogExporter, pluginLogger } from './log.js'
import { collectWindow, runExtraction } from './extract.js'
import { backgroundDelayMs, extractionDelayMs, formatDelay, parsePeakHours, peakDelayMs } from './schedule.js'
import { applyPlan, denyToolsFor, runConsolidation, selectForConsolidation } from './consolidate.js'
import { discardDraft, listDrafts, promote, writeDraft } from './skills.js'
import type { ConsolidationTarget, SubagentSeam } from './consolidate.js'
import { MEMORY_KINDS } from './types.js'
import type { MemoryDraft, MemoryEntry, MemoryKind, MemoryScope, SessionMode } from './types.js'
import { registerMemoryTool } from './tool.js'
import { REMOTE_CONTRIBUTION, REMOTE_SERVICE, createRemoteService } from './remote.js'
import type { TypertRegistryLike } from './remote.js'

/** Plugin name; also the source tag of every injected message. */
export const name = 'memories'

/** Budget for the extraction a shutdown is allowed to wait for. */
const EXIT_FLUSH_TIMEOUT_MS = 8_000

/** State key holding the last periodic sweep, so it survives a restart. */
const SWEEP_META_KEY = 'sweep-at'

/**
 * How far above the recall floor a single shared run must score to be enough.
 *
 * A turn that is essentially one keyword ("端口 3080") shares one run and
 * deserves its memory; a turn that merely brushes past a memory shares one run
 * among many words and does not. The score is what separates them, so the
 * requirement is a multiple of the caller's own floor rather than a second
 * absolute number to keep in sync.
 */
const QUALIFIED_SCORE_FACTOR = 2

/**
 * Model-facing label of a session that has no workspace of its own.
 *
 * Sessions opened in the harness home itself (or with no recorded `cwd`) are not
 * working in a project, and giving them one produced a scope that mixed
 * unrelated repositories: measured on a real store, one such bucket held 14
 * memories from five different projects and injected all of them into every
 * session started there.
 */
const NO_PROJECT_LABEL = 'project:none'

/**
 * Services this plugin requires at activation: the tool registry (for the
 * `memory` tool), the command registry (for `/memories`), and the settings
 * provider (which owns the `memories` namespace).
 *
 * The LLM and the subagent seam are read opportunistically with `ctx.get`, so a
 * deployment with no model adapter or no delegation still loads — it just never
 * runs background extraction or consolidation.
 */
export const inject: string[] = ['tools', 'commands', 'settings']

/** Job key of the single global consolidation job. */
const CONSOLIDATE_JOB = 'global'

/** One scope's loaded state. */
interface ScopeState {
  readonly scope: MemoryScope
  readonly label: string
  readonly heading: string
  readonly entries: readonly MemoryEntry[]
}


/**
 * The memory runtime: one instance per plugin mount, shared by the tool, the
 * injector, the extractor, and the command handler.
 */
export class MemoriesRuntime {
  /** Deployment facts resolved once: paths and workspace discovery. */
  readonly deployment: ResolvedConfig
  readonly store: MemoryStore
  /** Operational state: watermarks, consolidation jobs, usage counters. */
  readonly state: StateStore
  /**
   * Live tunables.
   *
   * A thunk rather than a snapshot: the settings namespace is hot-reloaded, so
   * every read must see the value committed most recently, and a restart is
   * never required to change a knob.
   */
  private readonly settingsThunk: () => MemoriesSettings
  /**
   * The LLM runtime captured at activation.
   *
   * Captured eagerly rather than resolved per call: by the time a settle pass
   * runs the tree may already be disposing, and a late `ctx.get('llm')` then
   * resolves to nothing — which is exactly the pass a one-shot run depends on.
   */
  private readonly llm: LlmRuntime | undefined
  /** The subagent seam, read once; absent in a deployment without delegation. */
  private readonly subagents: SubagentSeam | undefined
  private readonly rootCache = new WeakMap<Session, Promise<string | undefined>>()
  /** Sessions whose conversation already carries the memory block. */
  private readonly injected = new WeakSet<Session>()
  /** Recall deltas already injected into each conversation. */
  private readonly recallCounts = new WeakMap<Session, number>()
  /** Entry ids each conversation has already been shown. */
  private readonly surfacedIds = new WeakMap<Session, Set<string>>()
  private readonly idleTimers = new WeakMap<Agent, NodeJS.Timeout>()
  private readonly extracting = new Set<string>()
  private readonly lifecycle = new AbortController()
  /** The plugin's own logger: the host logger, plus the decision facade. */
  private readonly log: MemoryLog
  /**
   * Why the configured log file is not being written, when it could not be
   * opened or a write failed. Set by the composition, surfaced by `/memories
   * stats` — the only reachable diagnostic, since the broken channel cannot
   * report itself.
   */
  logSinkError: string | undefined

  constructor(
    private readonly ctx: Context,
    config: MemoriesConfig,
    settings?: () => MemoriesSettings,
  ) {
    this.deployment = resolveConfig(config)
    this.settingsThunk = settings ?? (() => this.deployment.defaults)
    this.store = new MemoryStore(this.deployment.memoriesDir)
    this.store.entryLimit = () => this.settings.maxEntriesPerScope
    this.store.similarityLimit = () => this.settings.dedupeSimilarity
    this.state = new StateStore(statePath(this.deployment.memoriesDir))
    this.llm = ctx.get('llm') as LlmRuntime | undefined
    this.subagents = ctx.get('subagents') as SubagentSeam | undefined
    this.log = new MemoryLog(pluginLogger(ctx.logger), () => this.settings.traceMaintenance)
  }

  /** The tunables in force right now. */
  get settings(): MemoriesSettings {
    return this.settingsThunk()
  }

  /** Abort every owned background activity and release the state store. */
  dispose(): void {
    this.stopPeriodicExtraction()
    this.lifecycle.abort(new Error('dsh-memories disposed'))
    this.state.close()
  }

  /**
   * Resolve (and cache) one session's workspace root.
   *
   * `undefined` means the session has no project scope at all — see
   * {@link NO_PROJECT_LABEL} — which is a different thing from "the lookup
   * failed": every caller treats it as "this conversation has no workspace".
   *
   * @param session - session whose workspace to resolve.
   * @returns the workspace root, or `undefined` when the session has none.
   */
  async projectRoot(session: Session): Promise<string | undefined> {
    const cached = this.rootCache.get(session)
    if (cached !== undefined) return await cached
    const pending = this.resolveProjectRoot(session)
    this.rootCache.set(session, pending)
    return await pending
  }

  /** Decide one session's project scope; see {@link NO_PROJECT_LABEL}. */
  private async resolveProjectRoot(session: Session): Promise<string | undefined> {
    const cwd = session.header.cwd?.trim()
    // A session with no recorded cwd is not a project: the host's own working
    // directory is where the harness happens to run, not where the conversation
    // works, and scoping to it merged unrelated repositories into one bucket.
    if (cwd === undefined || cwd.length === 0) return undefined
    const root = await findProjectRoot(cwd, this.deployment.projectRootMarkers)
    // The harness home is not a project either. `findProjectRoot` falls back to
    // the starting directory when it finds no marker, so a session started in
    // `$DSH_HOME` would otherwise own a scope shared by everything worked on
    // from there — measured: 14 memories from five unrelated projects.
    return isWithin(this.deployment.dshHome, root) ? undefined : root
  }

  /** Load one scope's entries plus its model-facing labels. */
  async scopeState(scope: MemoryScope, session: Session): Promise<ScopeState> {
    const root = scope === 'project' ? await this.projectRoot(session) : undefined
    if (scope === 'project' && root === undefined) {
      return { scope, label: NO_PROJECT_LABEL, heading: 'Project memories (none)', entries: [] }
    }
    const entries = await this.store.list(scope, root)
    const target = this.store.target(scope, root)
    return {
      scope,
      label: target.label,
      heading: scope === 'global' ? 'Global memories' : `Project memories (${target.label})`,
      entries: rankForSummary(entries),
    }
  }

  /** Load both scopes, broadest first. */
  async allScopes(session: Session): Promise<readonly ScopeState[]> {
    return [await this.scopeState('global', session), await this.scopeState('project', session)]
  }

  /** Convert loaded scopes into the search/browse input shape. */
  private groups(states: readonly ScopeState[]): ScopeEntries[] {
    return states.map((state) => ({ scope: state.scope, label: state.label, entries: state.entries }))
  }

  /** Search both scopes. */
  async search(session: Session, query: string, options: { scopes?: readonly MemoryScope[]; tags?: readonly string[]; kinds?: readonly MemoryKind[]; limit?: number }) {
    const states = await this.allScopes(session)
    return searchMemories(this.groups(states), query, options)
  }

  /** Browse both scopes without a query. */
  async browse(session: Session, options: { scopes?: readonly MemoryScope[]; tags?: readonly string[]; kinds?: readonly MemoryKind[]; limit?: number }) {
    const states = await this.allScopes(session)
    return browseMemories(this.groups(states), options)
  }

  /** Read one entry by scope and id, recording the hit. */
  async read(session: Session, scope: MemoryScope, id: string, record = true): Promise<MemoryEntry | undefined> {
    const root = scope === 'project' ? await this.projectRoot(session) : undefined
    if (scope === 'project' && root === undefined) return undefined
    const entry = await this.store.read(scope, root, id)
    if (entry === undefined || !record) return entry
    return this.touchEntry(entry, root)
  }

  /**
   * Record one read/search hit.
   *
   * The counter lives in the state database (atomic, concurrent-safe) and is
   * mirrored back into the entry file so the markdown stays a complete picture
   * for a human reader.
   */
  private async touchEntry(entry: MemoryEntry, root: string | undefined): Promise<MemoryEntry> {
    const counters = this.state.bumpUsage(entry.scope, entry.id)
    return this.store.writeCounters(entry, root, counters)
  }

  /** Record hits for a batch of search/browse results, best-effort. */
  async recordUsage(session: Session, entries: readonly MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return
    const root = await this.projectRoot(session)
    // An entry can only be marked against a scope that exists right now, and a
    // session without a workspace has no project scope to mark.
    const markable = entries.filter((entry) => entry.scope === 'global' || root !== undefined)
    await Promise.all(markable.map((entry) => this.touchEntry(entry, entry.scope === 'project' ? root : undefined)))
  }

  /**
   * Store one draft, choosing the scope.
   *
   * The whole draft shape is accepted, not a reduced one: `kind`, `keys`, and
   * `appliesTo` are what make a memory findable and what say when it matters, so
   * a caller that has them must not have to drop them at this seam.
   *
   * A project draft from a session with no workspace is stored globally rather
   * than refused: the extractor cannot know the session has none, and dropping
   * the fact would lose it silently. The rewrite is logged, because the scope it
   * lands in is what decides who sees it later.
   */
  async write(
    session: Session,
    draft: MemoryDraft,
    source: MemoryEntry['source'],
  ) {
    return await this.persist(session, draft, source)
  }

  /** The one place a draft becomes an entry, so the scope rule has one home. */
  private async persist(session: Session, draft: MemoryDraft, source: MemoryEntry['source']) {
    if (draft.scope === 'global') return await this.store.upsert(draft, undefined, source)
    const root = await this.projectRoot(session)
    if (root !== undefined) return await this.store.upsert(draft, root, source)
    this.log.decision('dsh-memories: session %s has no workspace, storing %s as global', session.id, draft.title)
    return await this.store.upsert({ ...draft, scope: 'global' }, undefined, source)
  }

  /** Delete one entry. */
  async forget(session: Session, scope: MemoryScope, id: string): Promise<boolean> {
    const root = scope === 'project' ? await this.projectRoot(session) : undefined
    if (scope === 'project' && root === undefined) return false
    return await this.store.remove(scope, root, id)
  }

  /**
   * Build the injected summary block for one session, or `undefined` when the
   * store is empty or injection is disabled.
   *
   * @param session - session whose scopes to summarize.
   * @returns the framed block, or `undefined` when there is nothing to say.
   */
  async summary(session: Session): Promise<string | undefined> {
    return (await this.summaryWithSurfaced(session))?.text
  }

  /**
   * Build the injected block and name the entries it lists.
   *
   * The caller needs both: the text enters the conversation, and the entries it
   * names are marked as surfaced, which is what keeps retention from archiving a
   * memory that works so well it never needs a search.
   *
   * Which entries those are is decided by `selectForSummary`, not by the ranker
   * alone: on a scope with more entries than slots the ranking is a fixed point,
   * so pure ranking would list the same memories forever and never surface
   * anything new — including an explicit correction of one of them.
   *
   * @param session - session whose scopes to summarize.
   * @returns the framed block plus the entries it lists, or `undefined`.
   */
  private async summaryWithSurfaced(session: Session): Promise<{ text: string; surfaced: readonly MemoryEntry[] } | undefined> {
    if (this.settings.maxSummaryBytes <= 0) return undefined
    if (this.settings.recallMode === 'off') return undefined
    const states = await this.allScopes(session)
    const selected = states.map((state) => selectForSummary(state.entries, this.settings.maxSummaryEntries, {
      freshSlots: this.settings.summaryFreshSlots,
    }))
    const scopes: SummaryScope[] = states.map((state, index) => ({
      label: state.label,
      heading: state.heading,
      entries: selected[index] ?? [],
      // The full count, not the listed one, so the block still says how much it
      // is not showing.
      total: state.entries.length,
    }))
    const note = await this.draftNote()
    const text = renderMemorySummary(scopes, {
      maxBytes: this.settings.maxSummaryBytes,
      maxEntriesPerScope: this.settings.maxSummaryEntries,
      ...note === undefined ? {} : { note },
    })
    if (text === undefined) return undefined
    return { text, surfaced: selected.flat() }
  }

  /**
   * The one line this plugin wants in the summary but cannot express as a memory.
   *
   * Staged skill drafts are the only state that needs a human: consolidation
   * produces them, they are invisible to the model (the harness scans its own
   * skill roots, not the memory store), and nothing else ever mentions them
   * again. Measured on a real store: 13 drafts had accumulated over a week and
   * none had ever been promoted, because the only notice was a line in one
   * session's consolidation reply.
   *
   * @returns the note, or `undefined` when nothing is waiting.
   */
  private async draftNote(): Promise<string | undefined> {
    const drafts = await listDrafts(this.store.memoriesDir).catch(() => [])
    if (drafts.length === 0) return undefined
    const names = drafts.slice(0, 3).map((draft) => draft.name).join(', ')
    const more = drafts.length > 3 ? `, +${drafts.length - 3} more` : ''
    return `Pending skill drafts (${drafts.length}): ${names}${more} — promote with /memories promote <name> or discard with /memories discard <name>.`
  }

  /**
   * Record that these entries entered a conversation.
   *
   * The state database is authoritative and the entry file is only a mirror for
   * a human reader, refreshed at most hourly: rewriting a dozen markdown files
   * on every injection would cost more than the mark is worth.
   *
   * @param session - conversation the entries appeared in.
   * @param entries - the entries shown.
   */
  private async markSurfaced(session: Session, entries: readonly MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return
    const seen = this.seenIds(session)
    const root = await this.projectRoot(session)
    // A project entry cannot be marked in a scope that does not exist; the
    // counter still moves, only the markdown mirror is skipped.
    await Promise.all(entries.map(async (entry) => {
      seen.add(entry.id)
      const at = this.state.bumpSurfaced(entry.scope, entry.id)
      if (entry.scope === 'project' && root === undefined) return
      if (entry.lastSurfacedAt >= at - 3_600_000) return
      await this.store.writeCounters(entry, entry.scope === 'project' ? root : undefined, {
        uses: entry.uses,
        lastUsedAt: entry.lastUsedAt,
        surfacedAt: at,
      }).catch(() => undefined)
    }))
  }

  /**
   * Decide what the model should see at this step boundary.
   *
   * The block enters exactly ONCE per conversation: at the first step where the
   * store has something to say. Nothing re-injects afterwards, so a long session
   * pays for its memories once instead of once per turn, and every later recall
   * goes through `memory_search`.
   *
   * "Once" is decided by the CONVERSATION, not by this process: the block is a
   * durable user message, so {@link carriesRecall} answers whether the model can
   * already see one. A restarted harness restores that message with the rest of
   * the history, so it does not inject a second copy; `clear` and `compact`
   * replace the history and therefore legitimately bring the block back (which is
   * why {@link resetInjection} drops this process's cache there).
   *
   * An empty store deliberately leaves the session unmarked: the block should
   * still appear later if the first memory arrives after the session started.
   *
   * @param agent - the agent whose next step is being prepared.
   * @returns the message to enter the conversation, or `undefined` when this
   *   conversation already carries one.
   */
  async injectionFor(agent: Agent): Promise<UserMessage | undefined> {
    const session = agent.session
    // The cache only avoids re-reading the history on every step of a turn;
    // checking it first also keeps the common case free of a state-database read.
    if (this.injected.has(session)) return undefined
    if (this.sessionOff(session)) return undefined
    if (this.carriesRecall(session)) {
      this.injected.add(session)
      return undefined
    }
    const summary = await this.summaryWithSurfaced(session)
    if (summary === undefined) return undefined
    this.injected.add(session)
    await this.markSurfaced(session, summary.surfaced)
    this.log.info('dsh-memories: injected the summary into session %s (%d bytes, %d entries)',
      session.id, Buffer.byteLength(summary.text, 'utf8'), summary.surfaced.length)
    return createUserMessage({
      content: [{ type: 'text', text: summary.text }],
      source: { kind: 'plugin', plugin: name, form: 'recall' },
    })
  }

  /**
   * Whether the model-visible history already carries a memory block.
   *
   * `deriveMessages` projects each surface node exactly once and caches the
   * result, so asking is cheap even on a long session. Any failure reads as "no
   * block", whose worst case is one redundant injection — never a failed turn.
   */
  private carriesRecall(session: Session): boolean {
    try {
      return session.deriveMessages().some((message) => {
        const source = message.source
        if (source.kind !== 'plugin' || source.plugin !== name || source.form !== 'recall') return false
        // Both blocks carry this form, so the SUMMARY is the one whose frame
        // says so: an on-demand delta must not count as the once-per-
        // conversation block, or the summary would never be injected.
        const blocks = message.content as readonly { type: string; text?: string }[]
        return blocks.some((block) => block.type === 'text' && (block.text ?? '').includes(MEMORY_OPEN))
      })
    } catch {
      return false
    }
  }

  /** Re-arm injection for one session (used on `clear`/`compact` restarts). */
  resetInjection(session: Session): void {
    this.injected.delete(session)
    this.recallCounts.delete(session)
    this.surfacedIds.delete(session)
  }

  /**
   * The on-demand recall delta for this step, or `undefined` when nothing is
   * worth adding.
   *
   * `recallMode: 'on-demand'` answers the one real weakness of injecting once:
   * the summary is a snapshot from the start of the conversation, so a memory
   * that only becomes relevant ten turns later stays invisible unless the model
   * thinks to search for it. The delta is deterministic — the same scorer the
   * tool uses, with no extra model call — and bounded three ways: a score
   * threshold, a per-conversation cap, and one entry per block. Every entry it
   * shows is recorded, so a delta never repeats what the summary listed.
   *
   * @param agent - the agent whose next step is being prepared.
   * @returns the message to enter the conversation, or `undefined`.
   */
  async recallFor(agent: Agent): Promise<UserMessage | undefined> {
    if (this.settings.recallMode !== 'on-demand') return undefined
    const session = agent.session
    // The budget is checked before the session switch because it lives in memory:
    // once the cap is reached, no step pays for a state-database read again.
    const used = this.recallCounts.get(session) ?? 0
    const remaining = this.settings.recallMaxPerConversation - used
    if (remaining <= 0) return undefined
    if (this.sessionOff(session)) return undefined
    const query = this.latestUserText(session)
    // A one-word acknowledgement has nothing a memory could be about; skipping it
    // also avoids a full store scan on every "好" the user types.
    if (query === undefined || !isSubstantiveTurn(query)) return undefined
    const seen = this.seenIds(session)
    const states = await this.allScopes(session)
    const eligible: { entry: MemoryEntry; relevance: number; score: number; best: string; evidence: MatchEvidence }[] = []
    let near: { id: string; relevance: number; terms: number } | undefined
    for (const state of states) {
      for (const entry of state.entries) {
        if (seen.has(entry.id)) continue
        const why = explainEntry(entry, query)
        // Two gates, and they answer different questions.
        //
        // The FLOOR is the caller's knob: the relevance a memory has to reach at
        // all.
        //
        // CREDIT is the structural gate, and a score threshold cannot replace it
        // for Chinese. Measured on a real 54-memory store, "该插件是否有日志"
        // shares the isolated bigram 插件 with a memory about an unrelated
        // cost-meter bug and scores 12 — above any floor low enough to admit a
        // paraphrase. Credit therefore asks for substantive terms: a Latin word of
        // three characters or more, or a CJK pair inside a shared run of three or
        // more, which is the only Chinese term a merely common pair cannot fake.
        // A whole-query hit stands alone, one such term is enough when the score is
        // decisive (a one-keyword turn like "端口 3080"), and otherwise two are
        // required.
        const distinctive = why.relevance >= this.settings.recallMinScore * QUALIFIED_SCORE_FACTOR
        const credited = why.evidence.phrase
          || why.evidence.strongTerms >= this.settings.recallMinTerms
          || (why.evidence.strongTerms >= 1 && distinctive)
        if (why.relevance < this.settings.recallMinScore || !credited) {
          // Remember the closest miss, so "why was nothing recalled?" has an
          // answer in the log instead of being a silence.
          if (why.relevance > 0 && (near === undefined || why.relevance > near.relevance)) {
            near = { id: entry.id, relevance: why.relevance, terms: why.evidence.strongTerms }
          }
          continue
        }
        eligible.push({ entry, ...why })
      }
    }
    if (eligible.length === 0) {
      this.log.decision('dsh-memories: session %s recalled nothing (closest: %s at relevance %.1f with %d strong terms; needs relevance ≥%.0f and either %d strong terms, one substantive term above %.0f, or an exact phrase)',
        session.id, near?.id ?? 'none', near?.relevance ?? 0, near?.terms ?? 0,
        this.settings.recallMinScore, this.settings.recallMinTerms,
        this.settings.recallMinScore * QUALIFIED_SCORE_FACTOR)
      return undefined
    }
    // Ranked by the decayed score, so recency and the entry's own track record
    // break ties between equally relevant memories.
    eligible.sort((left, right) => right.score - left.score
      || right.entry.updatedAt - left.entry.updatedAt
      || left.entry.title.localeCompare(right.entry.title))
    const picked: { entry: MemoryEntry; relevance: number; score: number; best: string; evidence: MatchEvidence }[] = []
    for (const candidate of eligible) {
      if (picked.length >= remaining) break
      // `renderRecall` is the budget's authority: if one more entry would not fit,
      // it returns `undefined` and the block keeps the entries already chosen.
      if (renderRecall([...picked, candidate].map((item) => item.entry), this.settings.recallMaxBytes) === undefined) break
      picked.push(candidate)
    }
    if (picked.length === 0) return undefined
    const text = renderRecall(picked.map((item) => item.entry), this.settings.recallMaxBytes)
    if (text === undefined) return undefined
    this.log.decision('dsh-memories: session %s recalled %s (relevance %.1f, score %.1f, via %j)',
      session.id, picked.map((item) => item.entry.id).join(', '),
      picked[0]!.relevance, picked[0]!.score, (picked[0]!.best ?? '').slice(0, 80))
    this.recallCounts.set(session, used + picked.length)
    await this.markSurfaced(session, picked.map((item) => item.entry))
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The same form as the summary block; `carriesRecall` tells them apart by
      // the frame, so a delta never suppresses the once-per-conversation block.
      source: { kind: 'plugin', plugin: name, form: 'recall' },
    })
  }

  /**
   * The newest user-authored message, which is what the current turn is about.
   *
   * Tool results and this plugin's own injected blocks are skipped: a recall
   * decision must be driven by the human, not by the assistant's output or by
   * the memory block itself.
   *
   * @param session - session to read.
   * @returns the text, or `undefined` when no user message is on the surface.
   */
  private latestUserText(session: Session): string | undefined {
    try {
      const messages = session.deriveMessages()
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message === undefined || message.role !== 'user') continue
        if (message.source.kind !== 'user') continue
        const blocks = message.content as readonly { type: string; text?: string }[]
        const text = blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim()
        if (text.length < this.settings.recallMinQueryChars) return undefined
        if (text.length > 0) return text.slice(0, 2_000)
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /** Whether memory is switched off for one session. */
  private sessionOff(session: Session): boolean {
    return this.state.getSessionMode(session.id) === 'off'
  }

  /** Entry ids already shown to one conversation, created on first use. */
  private seenIds(session: Session): Set<string> {
    const existing = this.surfacedIds.get(session)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    this.surfacedIds.set(session, created)
    return created
  }

  /**
   * Whether background passes are paused right now.
   *
   * Codex gates memory work on a provider-reported remaining-quota percentage;
   * DSH exposes no such number, so the gate here is the refusal itself (see
   * {@link noteLimitRefusal}).
   *
   * @returns true while a recorded wait has not elapsed.
   */
  private backgroundPaused(): boolean {
    if (!this.settings.pauseOnQuotaError) return false
    return this.state.isLimited()
  }

  /**
   * Pause background passes after a provider refused for quota or rate.
   *
   * Only refusals pause: a malformed reply, a timeout, or a missing route says
   * nothing about the account's remaining quota, and treating them as refusals
   * would stop extraction for reasons the cooldown cannot fix.
   *
   * @param error - the failure thrown by an extraction or consolidation call.
   */
  private noteLimitRefusal(error: unknown): void {
    if (!this.settings.pauseOnQuotaError) return
    const code = (error as { code?: unknown } | null | undefined)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code !== 'RATE_LIMIT' && code !== QUOTA_EXCEEDED_CODE && !isQuotaExceededError(message)) return
    const base = this.settings.quotaCooldownMinutes * 60_000
    const max = Math.max(base, this.settings.quotaCooldownMaxMinutes * 60_000)
    const state = this.state.noteLimitFailure(message.slice(0, 200), base, max)
    this.log.warn(
      'dsh-memories: provider refused background work (%s), pausing background passes for %d min',
      typeof code === 'string' ? code : 'quota',
      Math.round((state.until - state.at) / 60_000),
    )
  }

  /**
   * Record that a session was used just now.
   *
   * This is the input the `maxAgeDays` gate reads. It is deliberately separate
   * from the extraction watermark: a session can be used for days without ever
   * being mined (background extraction needs a long-lived process), and the age
   * gate must still see it as recent.
   */
  recordActivity(session: Session, now = Date.now()): void {
    this.state.touchSession(session.id, now)
  }

  /** Whether one session is eligible for extraction (scope and configuration). */
  private eligible(session: Session): boolean {
    if (!this.settings.autoExtract) return false
    if (session.header.origin === 'subagent') return false
    if (session.header.delegationDepth !== undefined && session.header.delegationDepth > 0) return false
    return this.withinAge(session)
  }

  /**
   * Whether a session is still young enough to mine.
   *
   * `maxAgeDays` keeps a pass from resurrecting very old conversations: past
   * that horizon a fact is more likely stale than useful, and mining it costs
   * quota. The clock is the session's last observed activity (see
   * {@link recordActivity}), not its watermark — a session that was never mined
   * would otherwise read as infinitely young and the gate would never fire.
   *
   * A session with no recorded activity yet is treated as fresh.
   */
  private withinAge(session: Session, now = Date.now()): boolean {
    const limit = this.settings.maxAgeDays
    if (limit <= 0) return true
    const activity = this.state.getSession(session.id)?.activityAt
    if (activity === undefined || activity === 0) return true
    return now - activity <= limit * 86_400_000
  }

  /**
   * Schedule the idle-time extraction pass for a settled agent.
   *
   * The timer is unref'd, so a background pass never keeps an otherwise finished
   * process alive. That means a one-shot run (a headless task, a script) is
   * normally gone before the pass could fire; extraction is a feature of
   * long-lived surfaces such as `dsh web`, where the session is still open long
   * after the user stopped typing. {@link flushExit} covers the remaining case
   * as far as the process lifecycle allows.
   */
  scheduleExtraction(agent: Agent): void {
    if (!this.eligible(agent.session)) return
    this.track(agent)
    this.idleSince.set(agent, Date.now())
    this.armTimer(agent, backgroundDelayMs(this.settings, new Date()))
  }

  /**
   * Arm (or re-arm) one agent's settle timer.
   *
   * Kept separate from {@link scheduleExtraction} because a re-arm must not touch
   * `idleSince`: deferring a pass out of the peak window and then resetting the
   * quiet-window clock would push the pass back by the full window every time.
   *
   * @param agent - the agent whose pass is being waited for.
   * @param delayMs - how long to wait.
   */
  private armTimer(agent: Agent, delayMs: number): void {
    const existing = this.idleTimers.get(agent)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.idleTimers.delete(agent)
      // Still inside a peak window? Wait for it to end rather than spending now —
      // the settle clock keeps running, so the pass runs as soon as it is cheap.
      const penalty = peakDelayMs(this.settings.peakHours, new Date())
      if (penalty > 0) {
        this.log.decision('dsh-memories: session %s deferred for %s of peak hours', agent.session.id, formatDelay(penalty))
        this.armTimer(agent, penalty)
        return
      }
      void this.mine(agent).then(
        async (stored) => {
          await this.afterPass(agent, stored)
        },
        (error: unknown) => {
          if (!this.lifecycle.signal.aborted) this.log.warn('dsh-memories: extraction failed for session %s: %o', agent.session.id, error)
        },
      )
    }, delayMs)
    timer.unref?.()
    this.idleTimers.set(agent, timer)
  }

  /**
   * The bookkeeping every pass shares once it has run.
   *
   * New material is what makes a consolidation pass worth running; retention
   * costs no quota and needs no new material, so it runs on its own interval.
   *
   * @param agent - the session's agent.
   * @param stored - how many drafts the pass stored.
   */
  private async afterPass(agent: Agent, stored: number): Promise<void> {
    if (stored > 0) this.enqueueConsolidation(Date.now(), false, await this.projectRoot(agent.session))
    // Awaited, not fired and forgotten: retention is local file work, it runs at
    // most once per interval, and leaving it in flight makes the pass's side
    // effects land after the caller thinks the pass is over.
    await this.sweepIfDue()
    void this.consolidateIfDue(agent)
  }

  /**
   * (Re)start the periodic check from the current settings.
   *
   * Idempotent, so the settings watcher can call it on every commit: the old
   * timer is cleared first, and an interval of `0` simply leaves none running.
   */
  startPeriodicExtraction(): void {
    this.stopPeriodicExtraction()
    const minutes = this.settings.extractIntervalMinutes
    if (!(minutes > 0)) return
    const timer = setInterval(() => {
      void this.runPeriodicPass()
    }, minutes * 60_000)
    timer.unref?.()
    this.periodicTimer = timer
  }

  /** Stop the periodic check, if one is running. */
  stopPeriodicExtraction(): void {
    if (this.periodicTimer !== undefined) clearInterval(this.periodicTimer)
    this.periodicTimer = undefined
  }

  /** The periodic check's timer, when one is armed. */
  private periodicTimer: NodeJS.Timeout | undefined

  /**
   * Mine every open session that has something new, in slices.
   *
   * This is what keeps a long working session from losing its middle: a
   * settle-only pass reads the newest slice once and then moves the watermark
   * past everything before it, so those messages are never mined. The idle window
   * is deliberately not consulted here — the point is to capture while the
   * session is still running — but peak hours and the quota gate still are, and
   * `runMaintenance` inside {@link mine} waits for a natural gap instead of
   * racing the conversation.
   *
   * A session with nothing new costs no model call.
   *
   * The pass reports itself in one line. Without it the log could only be read
   * for what happened, never for why nothing did: every gate that skips work
   * (quota pause, no new material, an ineligible or already-running session)
   * left no trace at the level the file is configured for, and "is the
   * background extractor alive at all?" had no answer.
   */
  async runPeriodicPass(): Promise<void> {
    if (!this.settings.autoExtract) return
    if (!(this.settings.extractIntervalMinutes > 0)) return
    if (this.backgroundPaused()) {
      this.log.decision('dsh-memories: periodic extraction skipped, background passes are %s', this.backgroundLine())
      return
    }
    const counts = { tracked: 0, mined: 0, stored: 0, idle: 0, skipped: 0, failed: 0 }
    for (const reference of [...this.tracked]) {
      if (this.lifecycle.signal.aborted) return
      const agent = reference.deref()
      if (agent === undefined) {
        this.tracked.delete(reference)
        continue
      }
      counts.tracked += 1
      const session = agent.session
      if (!this.eligible(session)) {
        counts.skipped += 1
        continue
      }
      if (this.extracting.has(session.id)) {
        counts.skipped += 1
        continue
      }
      if (this.hasNothingNew(session)) {
        counts.idle += 1
        continue
      }
      try {
        const stored = await this.mine(agent, { ignoreIdleWindow: true })
        // A pass that ran but stored nothing was deferred, not mined: the reason
        // is in its own decision line, and only a real pass counts here.
        if (stored > 0) {
          counts.mined += 1
          counts.stored += stored
        } else {
          counts.skipped += 1
        }
        await this.afterPass(agent, stored)
      } catch (error) {
        counts.failed += 1
        this.log.warn('dsh-memories: periodic extraction failed for session %s: %o', session.id, error)
      }
    }
    this.reportPass(counts)
    await this.sweepIfDue()
  }

  /**
   * Record one periodic pass: at info when it changed something or failed, and at
   * decision level when there was simply nothing to do (which is most ticks).
   */
  private reportPass(counts: { tracked: number; mined: number; stored: number; idle: number; skipped: number; failed: number }): void {
    const line = 'dsh-memories: extract pass: %d tracked, %d mined (%d stored), %d nothing new, %d skipped, %d failed'
    const args = [counts.tracked, counts.mined, counts.stored, counts.idle, counts.skipped, counts.failed] as const
    if (counts.mined > 0 || counts.failed > 0) this.log.info(line, ...args)
    else this.log.decision(line, ...args)
  }

  /**
   * Run the consolidation pass when its cooldown has elapsed.
   *
   * The pass needs a parent agent for the subagent seam and is process-level, so
   * any settled agent serves; a pass already in flight is skipped because the
   * job lease is exclusive.
   */
  private async consolidateIfDue(agent: Agent): Promise<void> {
    if (!this.settings.consolidate || this.subagents === undefined) return
    const job = this.state.getJob(CONSOLIDATE_JOB)
    if (job === undefined) return
    if (job.notBefore > Date.now()) return
    if (agent.status !== 'idle') return
    // The job stays queued: the settle timer re-arms for the end of the window,
    // so a pass skipped here gets its turn as soon as tokens are cheap again.
    const penalty = peakDelayMs(this.settings.peakHours, new Date())
    if (penalty > 0) {
      this.log.decision('dsh-memories: consolidation deferred for %s of peak hours', formatDelay(penalty))
      return
    }
    await this.consolidateNow(agent)
  }

  /** When each agent last entered `idle`; cleared whenever it wakes. */
  private readonly idleSince = new WeakMap<Agent, number>()

  /**
   * Whether a settled agent has been quiet long enough for `minIdleHours`.
   *
   * The idle timer already waits `autoExtractIdleMs`; this is the second,
   * independent gate Codex applies — a session that keeps being resumed is not
   * a finished conversation, so its facts are still moving.
   */
  private idleEnough(agent: Agent, now = Date.now()): boolean {
    const hours = this.settings.minIdleHours
    if (hours <= 0) return true
    const since = this.idleSince.get(agent)
    if (since === undefined) return false
    return now - since >= hours * 3_600_000
  }

  /**
   * Run one extraction as an agent maintenance task.
   *
   * `agent.runMaintenance` claims the true idle phase, so a wake that arrives
   * while the pass runs is queued behind it instead of racing it, and the pass
   * is cancelled if the agent is torn down. A pass that cannot claim the idle
   * phase is skipped; the next settle pass tries again.
   *
   * @param agent - the settled agent to mine.
   * @param options - which gates to ignore. The exit flush passes
   *   `ignoreIdleWindow` (a session being torn down is finished by definition)
   *   but still respects peak hours, because it is an automatic spend.
   * @returns how many drafts were stored.
   */
  private async mine(agent: Agent, options: { ignoreIdleWindow?: boolean; ignorePeakHours?: boolean } = {}): Promise<number> {
    if (this.sessionOff(agent.session)) return 0
    if (options.ignorePeakHours !== true) {
      const penalty = peakDelayMs(this.settings.peakHours, new Date())
      if (penalty > 0) {
        this.log.decision('dsh-memories: not mining session %s, %s of peak hours remain',
          agent.session.id, formatDelay(penalty))
        return 0
      }
    }
    if (options.ignoreIdleWindow !== true) {
      if (agent.status !== 'idle') return 0
      if (!this.idleEnough(agent)) {
        this.log.decision('dsh-memories: session %s is not quiet enough yet, still inside the %sh window',
          agent.session.id, this.settings.minIdleHours)
        return 0
      }
    }
    try {
      return await agent.runMaintenance(async (signal) => this.runExtraction(agent, signal, true))
    } catch (error) {
      // Claiming the idle phase can be refused (a wake arrived first), and a
      // broken seam should not be silent: the pass is skipped either way.
      this.log.decision('dsh-memories: could not claim the idle phase for session %s: %o', agent.session.id, error)
      return 0
    }
  }

  /** Cancel a pending extraction timer. */
  cancelExtraction(agent: Agent): void {
    const timer = this.idleTimers.get(agent)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.idleTimers.delete(agent)
    }
    this.idleSince.delete(agent)
  }

  /** Remember an agent so a process exit can still mine it. */
  private track(agent: Agent): void {
    this.tracked.add(new WeakRef(agent))
    this.installExitFlush()
  }

  /**
   * Mine every tracked agent once, right now.
   *
   * Called at the disposal boundary and from `beforeExit`: a one-shot run (a
   * headless task, a script) finishes long before the idle timer fires, and
   * without this the session would never be mined — and its watermark would
   * never advance, so every later run would re-read the same transcript.
   *
   * Each call is bounded, so it cannot hang a shutdown beyond the budget, and a
   * session is mined at most once per process.
   *
   * @param timeoutMs - budget for the whole flush.
   * @returns how many drafts were stored across every flushed session.
   */
  async flushExit(timeoutMs = EXIT_FLUSH_TIMEOUT_MS): Promise<number> {
    if (!this.settings.autoExtract) return 0
    const budget = AbortSignal.timeout(timeoutMs)
    const limit = this.settings.maxSessionsPerPass
    let stored = 0
    let mined = 0
    for (const reference of [...this.tracked]) {
      const agent = reference.deref()
      if (agent === undefined) {
        this.tracked.delete(reference)
        continue
      }
      // Content decides, not a per-process flag: a periodic pass may already have
      // mined this session, and the minutes that followed it still deserve a pass.
      // Reading the transcript is free; only the model call costs anything, and
      // `runExtraction` skips that when the window is empty.
      if (this.extracting.has(agent.session.id)) continue
      if (this.hasNothingNew(agent.session)) continue
      if (budget.aborted || mined >= limit) break
      mined += 1
      try {
        // Forced past the quiet window: at this boundary the session is over, so
        // that gate would only guarantee a process which exits before
        // `minIdleHours` never mines anything. Peak hours still apply.
        stored += await this.mine(agent, { ignoreIdleWindow: true })
      } catch (error) {
        if (!budget.aborted) this.log.warn('dsh-memories: exit extraction failed for session %s: %o', agent.session.id, error)
      }
    }
    return stored
  }

  /**
   * Whether a session has nothing after its watermark.
   *
   * The check exists so a flush (or a periodic tick) does not spend a model call
   * to learn that there is nothing to read: walking the surface is free.
   *
   * @param session - session to inspect.
   * @returns true when there is nothing new to mine.
   */
  private hasNothingNew(session: Session): boolean {
    const after = this.state.getSession(session.id)?.lastSeq ?? 0
    const window = collectWindow(session, after, this.settings.extractWindowMessages, this.settings.extractMaxInputChars)
    return window.lastSeq === undefined || window.text.trim().length === 0
  }

  /** Agents that have settled at least once and may need an exit flush. */
  private readonly tracked = new Set<WeakRef<Agent>>()

  /** Whether the process-exit flush hook is installed. */
  private exitFlushInstalled = false

  /**
   * Best-effort flush of every tracked session.
   *
   * The primary pass is the settle timer; this exists as a safety net for a
   * natural process exit, where the tree may already be disposed and the LLM
   * service gone. Registered on the process rather than through `ctx.effect`,
   * because an effect disposer runs during teardown — exactly when the flush
   * must still be armed.
   */
  private installExitFlush(): void {
    if (this.exitFlushInstalled) return
    this.exitFlushInstalled = true
    process.on('beforeExit', this.exitFlush)
  }

  /** Bound `beforeExit` handler. */
  private readonly exitFlush = (): void => {
    void this.flushExit().catch(() => undefined)
  }

  /**
   * Mine one session's transcript tail and store what it yields.
   *
   * Marks the session as mined for this process even when there was nothing new
   * to store, so the exit flush cannot repeat a call that already ran.
   *
   * @param agent - the settled agent to mine.
   * @param budget - optional outer cancellation (a settle-window or shutdown deadline).
   * @param force - skip the "is the agent idle" gate; used by the exit flush and
   *   by `/memories mine`, where the caller has already decided to spend the call.
   * @returns how many drafts were stored.
   */
  async runExtraction(agent: Agent, budget?: AbortSignal, force = false): Promise<number> {
    if (!this.settings.autoExtract) return 0
    if (this.backgroundPaused()) {
      const limit = this.state.getLimit()
      this.log.debug('dsh-memories: background pass paused until %s (%d refusals)', new Date(limit?.until ?? 0).toISOString(), limit?.failures ?? 0)
      return 0
    }
    if (!force && agent.status !== 'idle') return 0
    const session = agent.session
    const key = session.id
    if (this.extracting.has(key)) return 0
    const llm = this.llm
    if (llm === undefined) return 0
    this.extracting.add(key)
    // Keep the event loop alive for the duration: a one-shot run has nothing
    // else scheduled, and Node would exit mid-request. Released in `finally`.
    const hold = setTimeout(() => undefined, this.settings.extractTimeoutMs + 1_000)
    try {
      const watermark = this.state.getSession(key)
      const afterSeq = watermark?.lastSeq ?? 0
      const window = collectWindow(session, afterSeq, this.settings.extractWindowMessages, this.settings.extractMaxInputChars)
      if (window.lastSeq === undefined || window.text.trim().length === 0) return 0
      const root = await this.projectRoot(session)
      const projectLabel = root === undefined ? NO_PROJECT_LABEL : this.store.target('project', root).label
      // A settle-window pass deliberately does NOT inherit the plugin lifecycle
      // signal: the plugin is disposed as the process shuts down, and tying the
      // pass to that signal would abort exactly the pass a one-shot run needs.
      const signal = budget ?? this.lifecycle.signal
      let outcome
      try {
        outcome = await runExtraction(llm, {
          session,
          window,
          projectLabel,
          ...this.settings.extractProvider.length > 0 && this.settings.extractModel.length > 0
            ? { provider: this.settings.extractProvider, model: this.settings.extractModel }
            : {},
          maxOutputTokens: this.settings.extractMaxOutputTokens,
          maxMemories: this.settings.extractMaxMemories,
          timeoutMs: this.settings.extractTimeoutMs,
          signal,
        })
      } catch (error) {
        // A refusal pauses every background pass, then propagates: the caller's
        // error handling is unchanged, it just runs less often from here on.
        this.noteLimitRefusal(error)
        throw error
      }
      // Reaching the provider proves quota is available again.
      this.state.clearLimit()
      if (outcome.kind === 'none') {
        this.log.decision('dsh-memories: session %s produced no memories (%s)', key, outcome.reason)
      } else {
        const stored: string[] = []
        for (const draft of outcome.drafts) {
          const result = await this.persist(session, draft, 'auto')
          stored.push(result.entry.id)
        }
        // The evidence note is part of the result, not a nice-to-have: without it
        // a memory has no history to check when its wording or age matters.
        await this.store.writeSessionNote({
          session: key,
          at: Date.now(),
          project: projectLabel,
          summary: outcome.summary,
          memories: stored,
        }).catch((error: unknown) => {
          this.log.warn('dsh-memories: could not write the evidence note for session %s: %o', key, error)
        })
        this.log.info('dsh-memories: stored %d memories from session %s (%s)', outcome.drafts.length, key, stored.join(', '))
        // A pass that always lands on the cap is a pass whose ceiling is the
        // binding constraint. Saying so is the only way anybody can tell that
        // `extractMaxMemories` is the knob to raise — measured on a real store,
        // 50 of 54 passes stopped exactly there and nothing ever said so.
        if (outcome.dropped > 0) {
          this.log.info('dsh-memories: the extractor offered %d more than the cap of %d, so they were dropped (raise extractMaxMemories to keep them)',
            outcome.dropped, this.settings.extractMaxMemories)
        }
      }
      this.state.putSession(key, {
        lastSeq: window.lastSeq,
        at: Date.now(),
        ...root === undefined ? {} : { root },
        activityAt: Date.now(),
        ...outcome.kind === 'memories' ? { contributed: true } : {},
      })
      return outcome.kind === 'memories' ? outcome.drafts.length : 0
    } finally {
      clearTimeout(hold)
      this.extracting.delete(key)
    }
  }

  /** Force an extraction now, ignoring the idle timer and the quiet window (used by `/memories mine`). */
  async mineNow(agent: Agent): Promise<number> {
    this.cancelExtraction(agent)
    const stored = await this.runExtraction(agent, undefined, true)
    if (stored > 0) this.enqueueConsolidation(Date.now(), false, await this.projectRoot(agent.session))
    return stored
  }

  /**
   * Mark the global consolidation job dirty.
   *
   * Enqueueing is cheap and only sets a flag: the pass itself runs on the
   * cooldown, so a burst of new memories produces one consolidation, not one
   * per write.
   *
   * @param now - clock for the enqueue timestamp.
   * @param readyNow - skip the cooldown (a manual pass), so the claim that
   *   follows can succeed immediately.
   * @param root - workspace root whose project scope this pass should cover;
   *   recorded so a later pass does not consolidate a different workspace.
   */
  enqueueConsolidation(now = Date.now(), readyNow = false, root?: string): void {
    if (!this.settings.consolidate) return
    const notBefore = readyNow ? now : now + this.settings.consolidateCooldownHours * 3_600_000
    const existing = this.state.getJob(CONSOLIDATE_JOB)
    if (existing !== undefined) {
      this.state.putJob({ ...existing, enqueuedAt: now, notBefore, ...root === undefined ? {} : { root } })
      return
    }
    this.state.putJob({ key: CONSOLIDATE_JOB, enqueuedAt: now, notBefore, retries: 0, ...root === undefined ? {} : { root } })
  }

  /**
   * Run one consolidation pass if the cooldown has elapsed.
   *
   * The pass is a restricted sub-agent that returns a merged plan as JSON; this
   * method is the only writer. Every failure is contained and backed off, so a
   * broken pass never damages the store and never retries in a hot loop.
   *
   * @param parent - an agent whose subagent seam and lineage the pass uses.
   * @returns a human-readable summary, or `undefined` when nothing ran.
   */
  async consolidateNow(parent: Agent): Promise<string | undefined> {
    if (!this.settings.consolidate) return undefined
    const seam = this.subagents
    if (seam === undefined) return undefined
    // A manual pass creates the job when none exists: the cooldown gates the
    // BACKGROUND pass, and a user who types the command is asking for it now.
    // Without this, `/memories consolidate` silently did nothing on a store
    // that had never been mined.
    const sessionRoot = await this.projectRoot(parent.session)
    if (this.state.getJob(CONSOLIDATE_JOB) === undefined) this.enqueueConsolidation(Date.now(), true, sessionRoot)
    const token = `consolidate-${process.pid}-${Date.now().toString(36)}`
    const job = this.state.claimJob(CONSOLIDATE_JOB, token, 600_000)
    if (job === undefined) return undefined
    // A paused account skips the pass and leaves the job in place: the cooldown
    // is the right place to retry, not this turn.
    if (this.backgroundPaused()) return undefined
    // The job's recorded root wins: consolidation is process-level, so the
    // session that happens to run the pass must not decide whose project
    // memories get consolidated.
    const root = job.root ?? sessionRoot
    try {
      const global = await this.store.list('global', undefined, { fresh: true })
      // A job recorded against a workspace can outlive the session that queued
      // it, and a session may have no workspace at all; either way there is
      // simply no project scope to merge into.
      const project = root === undefined ? [] : await this.store.list('project', root, { fresh: true })
      const reviewed = new Map(this.state.retentionRows().map((row) => [`${row.scope}\u0000${row.id}`, row.consolidatedAt]))
      const entries = selectForConsolidation([...global, ...project], reviewed, this.settings.consolidateMaxEntries)
      const unreviewed = entries.filter((entry) => (reviewed.get(retentionKey(entry.scope, entry.id)) ?? 0) === 0).length
      this.log.decision('dsh-memories: reviewing %d memories (%d never reviewed) for session %s: %s',
        entries.length, unreviewed, parent.session.id, entries.map((entry) => entry.id).join(', '))
      if (entries.length < 2) {
        this.state.deleteJob(CONSOLIDATE_JOB)
        return undefined
      }
      const plan = await runConsolidation(seam, {
        parent,
        ...consolidationRouteOf(this.settings),
        entries,
        projectLabel: root === undefined ? NO_PROJECT_LABEL : this.store.target('project', root).label,
        maxUpserts: this.settings.consolidateMaxEntries,
        // Only names the registry actually has: `tools.restrict()` rejects an
        // unknown name, and this deny list is cross-platform.
        denyTools: denyToolsFor(new Set((this.ctx.get('tools')?.schemas() ?? []).map((schema) => schema.name))),
        timeoutMs: this.settings.consolidateTimeoutMs,
        signal: this.lifecycle.signal,
      })
      if (plan === undefined) {
        this.state.deleteJob(CONSOLIDATE_JOB)
        return undefined
      }
      const result = await applyPlan(plan, this.consolidationTarget(), root, { entries })
      // Record the review, so the next pass starts from whatever has waited
      // longest instead of from the same newest page again.
      this.state.markConsolidated(entries.map((entry) => ({ scope: entry.scope, id: entry.id })))
      // Skill drafts are staged, not installed: a background pass must not
      // silently grow the model's skill catalog.
      const staged: string[] = []
      for (const draft of plan.skills) {
        try {
          await writeDraft(this.store.memoriesDir, draft)
          staged.push(draft.name)
        } catch (error) {
          this.log.warn('dsh-memories: could not stage skill draft %s: %o', draft.name, error)
        }
      }
      this.state.deleteJob(CONSOLIDATE_JOB)
      this.state.clearLimit()
      this.log.info('dsh-memories: consolidated %d written, %d retired, %d skill drafts for session %s',
        result.written, result.retired, staged.length, parent.session.id)
      return [
        `Consolidated ${entries.length} memories: ${result.written} written, ${result.retired} retired.`,
        staged.length > 0 ? `Staged skill drafts: ${staged.join(', ')} (promote with /memories promote <name>).` : '',
        result.notes,
      ].filter((line) => line.length > 0).join(' ')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Release the lease and back off, so a broken pass cannot spin.
      const { lease: _lease, ...rest } = job
      this.state.putJob({
        ...rest,
        leaseUntil: 0,
        retries: job.retries + 1,
        notBefore: Date.now() + Math.min(6, job.retries + 1) * 3_600_000,
        lastError: message,
      })
      this.noteLimitRefusal(error)
      this.log.warn('dsh-memories: consolidation failed for session %s: %s', parent.session.id, message)
      return undefined
    }
  }

  /**
   * The store, narrowed to the write surface consolidation needs.
   *
   * The adapter drops `upsert`'s clock parameter so the target's `keepId` is the
   * fourth argument, matching the consolidation contract.
   */
  private consolidationTarget(): ConsolidationTarget {
    return {
      upsert: (draft, projectRoot, source, keepId) => this.store.upsert(draft, projectRoot, source, Date.now(), keepId),
      // Retirements are archival, so a wrong judgement stays recoverable.
      archive: (scope, projectRoot, id) => this.store.archive(scope, projectRoot, id),
      restore: (scope, projectRoot, id) => this.store.restore(scope, projectRoot, id),
    }
  }

  /**
   * Run the periodic maintenance sweep when its interval has elapsed.
   *
   * Retention is deterministic and costs no quota, so unlike extraction it needs
   * no live conversation — just a store and a clock. Running it here, and once
   * at startup before any session exists, is what makes "unused memories
   * eventually archive" true in a workspace that never happens to produce a new
   * memory: the pass stops being a side effect of extraction succeeding.
   *
   * @param now - injected clock.
   * @returns how many entries were archived.
   */
  async sweepIfDue(now = Date.now()): Promise<number> {
    if (this.settings.sweepIntervalHours <= 0 && this.settings.maxUnusedDays <= 0) return 0
    const last = Number(this.state.getMeta(SWEEP_META_KEY) ?? '0')
    if (this.settings.sweepIntervalHours > 0 && Number.isFinite(last) && last > 0
      && now - last < this.settings.sweepIntervalHours * 3_600_000) {
      this.log.decision('dsh-memories: sweep not due yet (next after %s)',
        new Date(last + this.settings.sweepIntervalHours * 3_600_000).toISOString())
      return 0
    }
    return await this.sweepNow(now)
  }

  /** Run retention now, ignoring the interval (used by `/memories sweep`). */
  async sweepNow(now = Date.now()): Promise<number> {
    this.state.putMeta(SWEEP_META_KEY, String(now))
    let archived = await this.retain('global', undefined, now)
    let scopes = 0
    for (const slug of await this.store.listProjects()) {
      const descriptor = await this.store.readProjectDescriptor(slug)
      if (descriptor === undefined) continue
      // A scope rooted in the harness home is one this plugin no longer creates
      // (see `resolveProjectRoot`); it is kept until retention empties it, and
      // saying so here is the only way a reader learns where those memories went.
      if (isWithin(this.deployment.dshHome, descriptor.root)) {
        this.log.decision('dsh-memories: project scope %s is inside the harness home; it is no longer injected and its entries will age out', slug)
        continue
      }
      scopes += 1
      archived += await this.retain('project', descriptor.root, now)
    }
    const removed = await this.store.pruneEmptyProjects().catch(() => [])
    for (const slug of removed) {
      this.log.decision('dsh-memories: removed empty project directory %s', slug)
    }
    // One line per sweep, always: it is the only evidence that retention runs at
    // all, and a sweep that never archives anything is exactly what somebody
    // wondering "why is my store still this big" needs to see.
    this.log.info('dsh-memories: sweep: archived %d memories across %d project scopes, pruned %d empty project director%s',
      archived, scopes, removed.length, removed.length === 1 ? 'y' : 'ies')
    return archived
  }

  /**
   * Apply retention to one scope.
   *
   * @param scope - scope to sweep.
   * @param root - workspace root for a project scope.
   * @param now - injected clock.
   * @returns how many entries were archived.
   */
  private async retain(scope: MemoryScope, root: string | undefined, now: number): Promise<number> {
    const days = this.settings.maxUnusedDays
    if (days <= 0) return 0
    const entries = await this.store.list(scope, root, { fresh: true })
    const expired = planRetention(entries, this.state.retentionRows(), { maxUnusedDays: days, now })
    let archived = 0
    for (const decision of expired) {
      this.log.decision('dsh-memories: archiving %s/%s, unused for %d days', decision.scope, decision.id, Math.round(decision.ageDays))
      if (await this.store.archive(scope, root, decision.id, now)) archived += 1
    }
    return archived
  }

  /** One line describing the sweep schedule, for `/memories stats`. */
  private sweepLine(): string {
    if (this.settings.sweepIntervalHours <= 0) return ', sweep off'
    const last = Number(this.state.getMeta(SWEEP_META_KEY) ?? '0')
    const when = Number.isFinite(last) && last > 0 ? new Date(last).toISOString() : 'never'
    return `, sweep every ${this.settings.sweepIntervalHours}h (last ${when})`
  }

  /**
   * Warn about tunables whose text did not parse.
   *
   * A `peakHours` typo silently disables the whole restriction — exactly the kind
   * of quiet failure this plugin keeps working to avoid — so the settings watcher
   * calls this and a bad edit says so immediately.
   */
  reportSettingsIssues(): void {
    const spec = this.settings.peakHours
    if (spec.length === 0) return
    const { invalid } = parsePeakHours(spec)
    if (invalid.length === 0) return
    this.log.warn('dsh-memories: peakHours entries not understood, so they are ignored: %s', invalid.join('; '))
  }

  /** Where this plugin's log is going, or why it is not. */
  private logDestination(): string {
    if (this.deployment.logFile.length === 0) return 'off'
    return this.logSinkError ?? this.deployment.logFile
  }

  /**
   * One line describing the peak-hours rule, for `/memories stats`.
   *
   * It reports whether a pass would be deferred *right now*, because that is the
   * question somebody reading the line is actually asking ("why isn't it
   * mining?").
   */
  private peakLine(now = new Date()): string {
    const spec = this.settings.peakHours
    if (spec.length === 0) return 'off'
    const { invalid } = parsePeakHours(spec)
    const penalty = peakDelayMs(spec, now)
    const state = penalty > 0 ? `deferring for ${formatDelay(penalty)}` : 'clear now'
    return `${spec} (${state})${invalid.length > 0 ? ` — unparsed: ${invalid.join('; ')}` : ''}`
  }

  /** This session's memory switch. */
  sessionMode(session: Session): SessionMode {
    return this.state.getSessionMode(session.id)
  }

  /**
   * Turn memory off or on for one session.
   *
   * Per session rather than global: the useful case is "this repository is full
   * of credentials, remember nothing from it", and a switch that silenced every
   * other project too would be the wrong shape.
   *
   * @param session - session to change.
   * @param value - `on`, `off`, or anything else to report the current state.
   * @returns a human-readable confirmation.
   */
  setSessionMode(session: Session, value: string): string {
    if (value !== 'on' && value !== 'off') {
      return `Memory is ${this.sessionMode(session)} for this session. Usage: /memories mode [on|off]`
    }
    this.state.setSessionMode(session.id, value)
    if (value === 'off') this.resetInjection(session)
    return value === 'off'
      ? 'Memory is off for this session: nothing injected and nothing mined. The memory tool still works.'
      : 'Memory is on for this session.'
  }

  /** List one scope's archived entries. */
  async archived(session: Session, scope: MemoryScope): Promise<string> {
    const root = scope === 'project' ? await this.projectRoot(session) : undefined
    if (scope === 'project' && root === undefined) {
      return renderScopeListing({ scope, label: `${NO_PROJECT_LABEL} archive`, entries: [] })
    }
    const entries = await this.store.listArchived(scope, root)
    return renderScopeListing({ scope, label: `${this.store.target(scope, root).label} archive`, entries })
  }

  /**
   * Restore one archived entry, project scope first.
   *
   * @param session - session whose workspace to search.
   * @param id - entry id.
   * @returns a human-readable outcome.
   */
  async restore(session: Session, id: string): Promise<string> {
    for (const scope of ['project', 'global'] as const) {
      const root = scope === 'project' ? await this.projectRoot(session) : undefined
      if (scope === 'project' && root === undefined) continue
      if (await this.store.restore(scope, root, id)) {
        return `Restored ${slugify(id)} into ${this.store.target(scope, root).label}.`
      }
    }
    return `No archived memory with id ${JSON.stringify(id)}, or it is live again already.`
  }

  /** One line describing whether background passes are running, for `/memories stats`. */
  private backgroundLine(now = Date.now()): string {
    const limit = this.state.getLimit()
    if (limit === undefined || !this.settings.pauseOnQuotaError) return 'running'
    if (limit.until <= now) return `running (last refusal ${new Date(limit.at).toISOString()})`
    return `paused until ${new Date(limit.until).toISOString()} after ${limit.failures} refusal${limit.failures === 1 ? '' : 's'}${limit.reason === undefined ? '' : `: ${limit.reason}`}`
  }

  /** A one-line status used by `/memories` and diagnostics. */
  async stats(session: Session): Promise<string> {
    const states = await this.allScopes(session)
    const drafts = await listDrafts(this.store.memoriesDir).catch(() => [])
    const lines = [
      `memory home: ${this.store.memoriesDir}`,
      ...states.map((scope) => `${scope.label}: ${scope.entries.length} memories`),
      `auto-extract: ${this.settings.autoExtract ? `on (every ${formatDelay(this.settings.extractIntervalMinutes * 60_000)}${this.settings.minIdleHours > 0 ? ` + ${formatDelay(extractionDelayMs(this.settings))} quiet to settle` : ''}, ≤${this.settings.maxAgeDays}d old)` : 'off'}`,
      `peak-hours: ${this.peakLine()}`,
      `recall: ${this.settings.recallMode} (relevance ≥${this.settings.recallMinScore} plus ${this.settings.recallMinTerms} terms or a shared run, ≤${this.settings.recallMaxPerConversation} memories and ≤${this.settings.recallMaxBytes}B per conversation)`,
      `summary: ≤${this.settings.maxSummaryEntries} per scope with ${this.settings.summaryFreshSlots} reserved for never-listed memories`,
      `skills: ${drafts.length === 0 ? 'no staged drafts' : `${drafts.length} staged draft${drafts.length === 1 ? '' : 's'} waiting (promote with /memories promote <name>)`}`,
      `retention: ${this.settings.maxUnusedDays > 0 ? `archive after ${this.settings.maxUnusedDays}d unused` : 'off'}${this.sweepLine()}`,
      `session mode: ${this.sessionMode(session)}`,
      `logging: ${this.settings.logLevel}${this.settings.traceMaintenance ? ' + maintenance trace' : ''} → ${this.logDestination()}`,
      `sessions: ${this.state.minedCount()} mined / ${this.state.sessionCount()} tracked`,
      `background: ${this.backgroundLine()}`,
      `state store: ${this.state.durable ? 'sqlite' : `memory-only (${this.state.degradedReason ?? 'driver unavailable'})`}`,
    ]
    return lines.join('\n')
  }

  /** Render one scope's entries for a human-facing command. */
  async list(session: Session, scope: MemoryScope): Promise<string> {
    const state = await this.scopeState(scope, session)
    return renderScopeListing({ scope: state.scope, label: state.label, entries: state.entries })
  }

  /** List the staged skill drafts. */
  async skills(): Promise<string> {
    const drafts = await listDrafts(this.store.memoriesDir)
    if (drafts.length === 0) return 'No skill drafts staged.'
    return [
      `${drafts.length} staged skill ${drafts.length === 1 ? 'draft' : 'drafts'}:`,
      ...drafts.map((draft) => `- ${draft.name} — ${draft.description || '(no description)'}`),
      '',
      'Promote one with /memories promote <name>; discard with /memories discard <name>.',
    ].join('\n')
  }

  /** Copy one staged draft into the harness skill root. */
  async promoteSkill(name: string): Promise<string> {
    const target = await promote(this.store.memoriesDir, this.deployment.dshHome, name)
    if (target === undefined) return `No staged skill draft named ${JSON.stringify(name)}.`
    return `Promoted ${JSON.stringify(name)} to ${target}. It joins the skill catalog on the next catalog refresh.`
  }

  /** Delete one staged draft. */
  async discardSkill(name: string): Promise<string> {
    return await discardDraft(this.store.memoriesDir, name)
      ? `Discarded staged skill draft ${JSON.stringify(name)}.`
      : `No staged skill draft named ${JSON.stringify(name)}.`
  }
}

/**
 * Split an optional `--kind <kind>` flag out of one command's arguments.
 *
 * The flag is accepted anywhere after the verb, so `add global text --kind
 * preference` and `search query --kind failure` both work. An unknown kind is
 * ignored rather than rejected: a typo should not silently filter everything
 * out, and the caller's text is still meaningful.
 * @param raw - the text after the subcommand.
 * @returns the text with the flag removed, and the requested kinds.
 */
function parseKindFlag(raw: string): { text: string; kinds?: readonly MemoryKind[] } {
  const match = /(?:^|\s)--kind[= ]([A-Za-z]+)/u.exec(raw)
  if (match === null) return { text: raw.trim() }
  const value = match[1]?.toLowerCase()
  const kind = MEMORY_KINDS.find((candidate) => candidate === value)
  const text = `${raw.slice(0, match.index)} ${raw.slice(match.index + match[0].length)}`.trim()
  return kind === undefined ? { text } : { text, kinds: [kind] }
}

/** Narrow the `/memories` argument grammar. */
function parseCommandInput(raw: string): { verb: string; rest: string } {  const trimmed = raw.trim()
  if (trimmed.length === 0) return { verb: 'help', rest: '' }
  const separator = trimmed.search(/\s/u)
  if (separator < 0) return { verb: trimmed.toLowerCase(), rest: '' }
  return { verb: trimmed.slice(0, separator).toLowerCase(), rest: trimmed.slice(separator + 1).trim() }
}

/** Render the `/memories` help text. */
function helpText(): string {
  return [
    'Usage: /memories [subcommand]',
    '  list [global|project]   list stored memories',
    '  search <query> [--kind <kind>]   search both scopes',
    '  show <id>               show one memory (project first)',
    '  add <global|project> <text> [--kind <kind>]   store a memory by hand',
    '  forget <id>             delete a memory for good',
    '  archive [global|project]   list archived (retired) memories',
    '  restore <id>            bring an archived memory back',
    '  mode [on|off]           switch memory off or on for this session',
    '  mine                    extract memories from this session now',
    '  consolidate             merge and reconcile all memories now',
    '  sweep                   archive unused memories now',
    '  skills                  list staged skill drafts',
    '  promote <name>          copy a staged draft into the harness skill root',
    '  discard <name>          delete a staged draft',
    '  stats                   store location and counters',
  ].join('\n')
}

/**
 * Register the memory tool, the injector, the idle extractor, and `/memories`.
 *
 * The tunables live in the `memories` settings namespace: registering it here
 * is what puts them in `$DSH_HOME/settings.yaml` and in the DSH Settings shell,
 * and every knob takes effect on the next read — no restart.
 *
 * @param ctx - the plugin context.
 * @param config - deployment configuration (paths and workspace discovery).
 */
export function apply(ctx: Context, config: MemoriesConfig = {}): void {
  const deployment = resolveConfig(config)
  // Every line this plugin emits goes through its own named logger: the name is
  // what keeps other plugins' traffic out of this plugin's log file, and using it
  // here too means a failure during composition is recorded like any other.
  const log = pluginLogger(ctx.logger)
  /**
   * Authoritative tunables.
   *
   * The settings scope owns the lifecycle: `register` returns a scope whose
   * `get()` is the resolved value (schema defaults, then the composition base,
   * then the user's `settings.yaml` section) and whose `watch` fires on every
   * commit. One source, so the settings document and the runtime can never
   * disagree, and no restart is needed to change a knob.
   */
  let current: MemoriesSettings = deployment.defaults
  const read = (): MemoriesSettings => current
  /** Assigned once the live registrations exist; a no-op until then. */
  let liveRegistrations = (): void => undefined
  /** Assigned once the runtime exists, so a settings commit can act on it. */
  let onSettingsCommit = (): void => undefined

  // The settings seam is optional: a deployment that composes no provider
  // keeps the row-level defaults and simply has no settings document.
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings !== undefined) {
    try {
      const scope = settings.register(SETTINGS_NS, MemoriesSettingsSchema, { base: deployment.defaults, applies: 'live' })
      current = normalizeSettings(scope.get())
      ctx.effect(() => scope.watch((next) => {
        current = normalizeSettings(next)
        liveRegistrations()
        onSettingsCommit()
      }), 'dsh-memories.settingsWatch')
    } catch (error) {
      log.warn('dsh-memories: settings registration failed, using row defaults: %o', error)
    }
  }

  const runtime = new MemoriesRuntime(ctx, config, read)
  ctx.effect(() => () => runtime.dispose(), 'dsh-memories.lifecycle')
  onSettingsCommit = () => {
    runtime.startPeriodicExtraction()
    runtime.reportSettingsIssues()
  }
  runtime.startPeriodicExtraction()
  runtime.reportSettingsIssues()

  // The host logger drops `warn` and `debug` before any sink sees them: the only
  // exporter a stock composition installs declares no level, so the threshold
  // falls back to 1 and `warn` (2) is filtered out. Registering our own exporter
  // for this plugin's logger name only raises that threshold for our lines, and
  // the file then records whatever `logLevel` allows — which is what makes a
  // failed extraction, a quota refusal, or a retention decision observable.
  const sink = createFileSink(deployment.logFile, undefined, (reason) => {
    // A failed write is the one failure the log file cannot report about itself:
    // the very channel is broken. Record it on the runtime so `/memories stats`
    // (and the settings card, which reads the same field) can say the file is
    // stale instead of leaving a user to trust something that stopped growing.
    runtime.logSinkError = `write failed: ${reason}`
  })
  if (sink !== undefined) {
    ctx.logger.exporter(createLogExporter(sink, () => current.logLevel))
  } else if (deployment.logFile.trim().length > 0) {
    // Recorded on the runtime rather than only logged: this very message cannot
    // reach the file that failed to open, and the host's own sink is a ring
    // buffer that a stock profile never reads. `stats` is where a user looks.
    runtime.logSinkError = `unwritable: ${deployment.logFile}`
    log.warn('dsh-memories: could not open the log file %s', deployment.logFile)
  }
  // The Settings page reads and edits memories through the Typert gateway, so
  // registering the invocation manifest and providing the `memories` service
  // are what make `ctx.remote.memories.*` callable from the browser. Both are
  // optional: a deployment that composes no gateway (headless, tui) keeps every
  // model-facing and command-facing surface and simply has no browser page.
  const typert = ctx.get('typert') as TypertRegistryLike | undefined
  if (typert !== undefined) {
    try {
      const withdraw = typert.register(REMOTE_CONTRIBUTION)
      ctx.effect(() => withdraw, 'dsh-memories.remoteContribution')
      const service = createRemoteService({ store: runtime.store, dshHome: deployment.dshHome })
      ctx.effect(() => ctx.provide(REMOTE_SERVICE, service), 'dsh-memories.remoteService')
    } catch (error) {
      log.warn('dsh-memories: remote registration failed, the settings page stays unavailable: %o', error)
    }
  }
  // Import (and remove) a pre-SQLite watermark file once, so upgrading does not
  // re-mine conversations that were already processed.
  void importLegacyState(runtime.state, runtime.store.memoriesDir).then((imported) => {
    if (imported === undefined) return
    log.info('dsh-memories: imported %d watermarks from the legacy state file', imported)
  }).catch((error: unknown) => {
    log.warn('dsh-memories: legacy state import failed: %o', error)
  })
  // The first sweep runs here rather than waiting for a session to settle: a
  // process that starts and stops (a script, a one-shot task) then still gets
  // the periodic cleanup it would otherwise never reach.
  void runtime.sweepIfDue().catch((error: unknown) => {
    log.warn('dsh-memories: startup sweep failed: %o', error)
  })
  // Activation facts belong at `debug`, not at the file's default verbosity: a
  // hot reload writes this line on every edit, and measured over nine days it
  // was a quarter of the whole log while saying nothing a reader could act on.
  // `/memories stats` reports the same facts on demand.
  log.debug(
    'dsh-memories: store at %s autoExtract=%s idle=%d settings=%s log=%s',
    runtime.store.memoriesDir,
    String(runtime.settings.autoExtract),
    runtime.settings.autoExtractIdleMs,
    settings === undefined ? 'row-defaults' : SETTINGS_NS,
    deployment.logFile.length > 0 ? `${deployment.logFile} (${runtime.settings.logLevel})` : 'off',
  )

  // `enableTool`/`enableCommand` are live: each registration is torn down and
  // re-created when the toggle flips, so the model's catalog follows the
  // settings document without a restart.
  const registerTool = (): (() => void) => registerMemoryTool(ctx, runtime)
  const registerCommand = (): (() => void) => ctx.commands.register({
    name: 'memories',
    description: 'Inspect and manage cross-session memories',
    input: { hint: 'list | search <query> [--kind <k>] | show <id> | add <scope> <text> [--kind <k>] | forget <id> | archive | restore <id> | mode [on|off] | mine | consolidate | sweep | skills | stats' },
    handler: async (invocation: CommandInvocation) => handleCommand(runtime, invocation),
  })
  let toolDisposer: (() => void) | undefined
  let commandDisposer: (() => void) | undefined
  const syncRegistrations = (): void => {
    const wantTool = runtime.settings.enableTool
    if (wantTool && toolDisposer === undefined) toolDisposer = registerTool()
    else if (!wantTool && toolDisposer !== undefined) {
      toolDisposer()
      toolDisposer = undefined
    }
    const wantCommand = runtime.settings.enableCommand
    if (wantCommand && commandDisposer === undefined) commandDisposer = registerCommand()
    else if (!wantCommand && commandDisposer !== undefined) {
      commandDisposer()
      commandDisposer = undefined
    }
  }
  syncRegistrations()
  liveRegistrations = syncRegistrations
  ctx.effect(() => () => {
    toolDisposer?.()
    commandDisposer?.()
  }, 'dsh-memories.registrations')

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') runtime.scheduleExtraction(agent)
    else runtime.cancelExtraction(agent)
    // Record real activity on every transition, so `maxAgeDays` judges a
    // session by when it was last USED rather than by when it was last mined —
    // a session that is never mined would otherwise look infinitely young.
    runtime.recordActivity(agent.session)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    runtime.cancelExtraction(agent)
    // A short-lived process may exit before the idle timer ever fires; the
    // disposal boundary is the last moment an extraction can still run.
    void runtime.flushExit().catch(() => undefined)
  })

  ctx.on('agent/session-start', ({ agent, source }: { agent: Agent; source: SessionStartSource }) => {
    // `clear`/`compact` replace the conversation, so the summary the model saw
    // is gone: forget it and let the next pre-step re-inject. Fresh and resumed
    // sessions need no work here — the first step of the first turn injects.
    if (source === 'clear' || source === 'compact') runtime.resetInjection(agent.session)
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const addition: UserMessage[] = []
    const summary = await runtime.injectionFor(agent)
    if (summary !== undefined) addition.push(summary)
    // The on-demand delta is a second, independent decision: a conversation can
    // already carry the summary and still meet a memory that only matters now.
    const delta = await runtime.recallFor(agent)
    if (delta !== undefined) addition.push(delta)
    const fresh = addition.filter((message) => !decision.messages.some((existing) => existing.id === message.id))
    if (fresh.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...fresh] }
  })
}

/** Execute one `/memories` invocation. */
async function handleCommand(runtime: MemoriesRuntime, invocation: CommandInvocation): Promise<{ kind: 'success' | 'error'; text: string }> {
  const { verb, rest } = parseCommandInput(invocation.rawInput)
  const session = invocation.agent.session
  switch (verb) {
    case 'help':
      return { kind: 'success', text: helpText() }
    case 'stats':
      return { kind: 'success', text: await runtime.stats(session) }
    case 'list': {
      const scope = rest.trim().toLowerCase()
      if (scope === 'global' || scope === 'project') return { kind: 'success', text: await runtime.list(session, scope) }
      const [global, project] = await runtime.allScopes(session)
      return {
        kind: 'success',
        text: [
          renderScopeListing({ scope: 'global', label: global?.label ?? 'global', entries: global?.entries ?? [] }),
          '',
          renderScopeListing({ scope: 'project', label: project?.label ?? 'project', entries: project?.entries ?? [] }),
        ].join('\n'),
      }
    }
    case 'search': {
      if (rest.length === 0) return { kind: 'error', text: 'Usage: /memories search <query> [--kind <kind>]' }
      const { text: query, kinds } = parseKindFlag(rest)
      if (query.length === 0) return { kind: 'error', text: 'Usage: /memories search <query> [--kind <kind>]' }
      const hits = await runtime.search(session, query, { limit: 10, ...kinds === undefined ? {} : { kinds } })
      if (hits.length === 0) return { kind: 'success', text: `No memories match ${JSON.stringify(query)}.` }
      return { kind: 'success', text: hits.map((hit, index) => renderHit(hit, index)).join('\n') }
    }
    case 'show': {
      if (rest.length === 0) return { kind: 'error', text: 'Usage: /memories show <id>' }
      const entry = await runtime.read(session, 'project', rest) ?? await runtime.read(session, 'global', rest)
      if (entry === undefined) return { kind: 'error', text: `No memory with id ${JSON.stringify(rest)}.` }
      return { kind: 'success', text: renderEntry(entry) }
    }
    case 'add': {
      const { text: body, kinds } = parseKindFlag(rest)
      const separator = body.search(/\s/u)
      const scope = (separator < 0 ? body : body.slice(0, separator)).trim().toLowerCase()
      const text = separator < 0 ? '' : body.slice(separator + 1).trim()
      if ((scope !== 'global' && scope !== 'project') || text.length === 0) {
        return { kind: 'error', text: 'Usage: /memories add <global|project> <text> [--kind <kind>]' }
      }
      const title = text.length <= 80 ? text : `${text.slice(0, 77)}...`
      const result = await runtime.write(session, {
        scope,
        title,
        body: text,
        tags: [],
        ...kinds === undefined ? {} : { kind: kinds[0] },
      }, 'user')
      return { kind: 'success', text: `${result.action === 'created' ? 'Stored' : 'Updated'} ${scope} ${result.entry.kind} memory ${result.entry.id}.` }
    }
    case 'forget': {
      if (rest.length === 0) return { kind: 'error', text: 'Usage: /memories forget <id>' }
      const project = await runtime.forget(session, 'project', rest)
      const global = project ? false : await runtime.forget(session, 'global', rest)
      if (!project && !global) return { kind: 'error', text: `No memory with id ${JSON.stringify(rest)}.` }
      return { kind: 'success', text: `Forgot ${slugify(rest)}.` }
    }
    case 'skills':
      return { kind: 'success', text: await runtime.skills() }
    case 'promote': {
      if (rest.length === 0) return { kind: 'error', text: 'Usage: /memories promote <name>' }
      return { kind: 'success', text: await runtime.promoteSkill(rest) }
    }
    case 'discard': {
      if (rest.length === 0) return { kind: 'error', text: 'Usage: /memories discard <name>' }
      return { kind: 'success', text: await runtime.discardSkill(rest) }
    }
    case 'archive': {
      const scope = rest.trim().toLowerCase()
      if (scope === 'global' || scope === 'project') return { kind: 'success', text: await runtime.archived(session, scope) }
      return { kind: 'success', text: `${await runtime.archived(session, 'global')}\n\n${await runtime.archived(session, 'project')}` }
    }
    case 'restore': {
      if (rest.length === 0) return { kind: 'error', text: 'Usage: /memories restore <id>' }
      return { kind: 'success', text: await runtime.restore(session, rest) }
    }
    case 'sweep': {
      const archived = await runtime.sweepNow()
      return { kind: 'success', text: archived === 0 ? 'Nothing to archive.' : `Archived ${archived} unused memories.` }
    }
    case 'mode': {
      return { kind: 'success', text: runtime.setSessionMode(session, rest.trim().toLowerCase()) }
    }
    case 'on':
      return { kind: 'success', text: runtime.setSessionMode(session, 'on') }
    case 'off':
      return { kind: 'success', text: runtime.setSessionMode(session, 'off') }
    case 'consolidate': {
      const summary = await runtime.consolidateNow(invocation.agent)
      return { kind: 'success', text: summary ?? 'Nothing to consolidate (cooldown active, too few memories, or no subagent support).' }
    }
    case 'mine': {
      const count = await runtime.mineNow(invocation.agent)
      return { kind: 'success', text: count === 0 ? 'Nothing new worth remembering.' : `Stored ${count} memories.` }
    }
    default:
      return { kind: 'error', text: helpText() }
  }
}

/** Loader schema re-exported under the name the Cordis loader discovers. */
export const Config = ConfigSchema
