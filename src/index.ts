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
import { browseMemories, relevanceOf, scoreEntry, searchMemories } from './search.js'
import type { ScopeEntries } from './search.js'
import { MEMORY_OPEN, rankForSummary, renderEntry, renderHit, renderMemorySummary, renderRecall, renderScopeListing } from './render.js'
import type { SummaryScope } from './render.js'
import { findProjectRoot } from './workspace.js'
import { planRetention, retentionKey } from './retention.js'
import { MemoryLog, createFileSink, createLogExporter } from './log.js'
import type { LoggerLike } from './log.js'
import { collectWindow, runExtraction } from './extract.js'
import { applyPlan, denyToolsFor, runConsolidation, selectForConsolidation } from './consolidate.js'
import { discardDraft, listDrafts, promote, writeDraft } from './skills.js'
import type { ConsolidationTarget, SubagentSeam } from './consolidate.js'
import { MEMORY_KINDS } from './types.js'
import type { MemoryEntry, MemoryKind, MemoryScope, SessionMode } from './types.js'
import { registerMemoryTool } from './tool.js'
import { REMOTE_CONTRIBUTION, REMOTE_SERVICE, createRemoteService } from './remote.js'
import type { TypertRegistryLike } from './remote.js'

/** Plugin name; also the source tag of every injected message. */
export const name = 'memories'

/** Budget for the extraction a shutdown is allowed to wait for. */
const EXIT_FLUSH_TIMEOUT_MS = 8_000

/** State key holding the last periodic sweep, so it survives a restart. */
const SWEEP_META_KEY = 'sweep-at'

/** Hard byte budget for one on-demand recall block. */
const RECALL_MAX_BYTES = 400

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
  private readonly rootCache = new WeakMap<Session, Promise<string>>()
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
    this.log = new MemoryLog(ctx.logger as unknown as LoggerLike, () => this.settings.traceMaintenance)
  }

  /** The tunables in force right now. */
  get settings(): MemoriesSettings {
    return this.settingsThunk()
  }

  /** Abort every owned background activity and release the state store. */
  dispose(): void {
    this.lifecycle.abort(new Error('dsh-memories disposed'))
    this.state.close()
  }

  /** Resolve (and cache) one session's workspace root. */
  async projectRoot(session: Session): Promise<string> {
    const cached = this.rootCache.get(session)
    if (cached !== undefined) return cached
    const cwd = session.header.cwd ?? process.cwd()
    const pending = findProjectRoot(cwd, this.deployment.projectRootMarkers)
    this.rootCache.set(session, pending)
    return pending
  }

  /** Load one scope's entries plus its model-facing labels. */
  async scopeState(scope: MemoryScope, session: Session): Promise<ScopeState> {
    const root = scope === 'project' ? await this.projectRoot(session) : undefined
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
    await Promise.all(entries.map((entry) => this.touchEntry(entry, entry.scope === 'project' ? root : undefined)))
  }

  /** Write one entry, choosing the scope. */
  async write(
    session: Session,
    draft: { scope: MemoryScope; title: string; body: string; tags: readonly string[] },
    source: MemoryEntry['source'],
  ) {
    const root = draft.scope === 'project' ? await this.projectRoot(session) : undefined
    return await this.store.upsert(draft, root, source)
  }

  /** Delete one entry. */
  async forget(session: Session, scope: MemoryScope, id: string): Promise<boolean> {
    const root = scope === 'project' ? await this.projectRoot(session) : undefined
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
   * @param session - session whose scopes to summarize.
   * @returns the framed block plus the entries it lists, or `undefined`.
   */
  private async summaryWithSurfaced(session: Session): Promise<{ text: string; surfaced: readonly MemoryEntry[] } | undefined> {
    if (this.settings.maxSummaryBytes <= 0) return undefined
    if (this.settings.recallMode === 'off') return undefined
    const states = await this.allScopes(session)
    const scopes: SummaryScope[] = states.map((state) => ({
      label: state.label,
      heading: state.heading,
      entries: state.entries,
      total: state.entries.length,
    }))
    const text = renderMemorySummary(scopes, {
      maxBytes: this.settings.maxSummaryBytes,
      maxEntriesPerScope: this.settings.maxSummaryEntries,
    })
    if (text === undefined) return undefined
    const surfaced = states.flatMap((state) => state.entries.slice(0, this.settings.maxSummaryEntries))
    return { text, surfaced }
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
    await Promise.all(entries.map(async (entry) => {
      seen.add(entry.id)
      const at = this.state.bumpSurfaced(entry.scope, entry.id)
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
    if (used >= this.settings.recallMaxPerConversation) return undefined
    if (this.sessionOff(session)) return undefined
    const query = this.latestUserText(session)
    if (query === undefined) return undefined
    const seen = this.seenIds(session)
    const states = await this.allScopes(session)
    let best: { entry: MemoryEntry; score: number; relevance: number } | undefined
    let near: { id: string; relevance: number } | undefined
    for (const state of states) {
      for (const entry of state.entries) {
        if (seen.has(entry.id)) continue
        const score = scoreEntry(entry, query)
        const relevance = relevanceOf(entry, query)
        // The gate is a RELEVANCE floor, not the decayed score: a title, key, or
        // tag hit. Recency then decides which eligible memory wins, so an old
        // but exact memory is still reachable in conversation.
        if (relevance < this.settings.recallMinScore) {
          // Remember the closest miss, so "why was nothing recalled?" has an
          // answer in the log instead of being a silence.
          if (relevance > 0 && (near === undefined || relevance > near.relevance)) near = { id: entry.id, relevance }
          continue
        }
        if (best === undefined || score > best.score) best = { entry, score, relevance }
      }
    }
    if (best === undefined) {
      this.log.decision('dsh-memories: session %s recalled nothing (closest: %s at relevance %.1f, gate %.0f)',
        session.id, near?.id ?? 'none', near?.relevance ?? 0, this.settings.recallMinScore)
      return undefined
    }
    const text = renderRecall([best.entry], RECALL_MAX_BYTES)
    if (text === undefined) return undefined
    this.log.decision('dsh-memories: session %s recalled %s (relevance %.1f, score %.1f)',
      session.id, best.entry.id, best.relevance, best.score)
    this.recallCounts.set(session, used + 1)
    await this.markSurfaced(session, [best.entry])
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
    this.ctx.logger.warn(
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
    const existing = this.idleTimers.get(agent)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.idleTimers.delete(agent)
      void this.mine(agent).then(
        async (stored) => {
          // New material is what makes a consolidation pass worth running; the
          // pass itself waits out its own cooldown. The workspace root is
          // recorded so the pass covers THIS session's project scope.
          if (stored > 0) this.enqueueConsolidation(Date.now(), false, await this.projectRoot(agent.session))
          // Retention costs no quota and needs no new material, so it runs on
          // its own interval; consolidation still needs a dirty job.
          void this.sweepIfDue()
          void this.consolidateIfDue(agent)
        },
        (error: unknown) => {
          if (!this.lifecycle.signal.aborted) this.log.warn('dsh-memories: extraction failed for session %s: %o', agent.session.id, error)
        },
      )
    }, this.settings.autoExtractIdleMs)
    timer.unref?.()
    this.idleTimers.set(agent, timer)
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
   * @returns how many drafts were stored.
   */
  private async mine(agent: Agent): Promise<number> {
    if (this.sessionOff(agent.session)) return 0
    if (agent.status !== 'idle') return 0
    if (!this.idleEnough(agent)) return 0
    try {
      return await agent.runMaintenance(async (signal) => this.runExtraction(agent, signal))
    } catch {
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
      if (this.mined.has(agent.session.id)) continue
      if (budget.aborted || mined >= limit) break
      mined += 1
      try {
        stored += await this.mine(agent)
      } catch (error) {
        if (!budget.aborted) this.log.warn('dsh-memories: exit extraction failed for session %s: %o', agent.session.id, error)
      }
    }
    return stored
  }

  /** Whether an extraction has already run for this session in this process. */
  private mined = new Set<string>()

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
   * @returns how many drafts were stored.
   */
  async runExtraction(agent: Agent, budget?: AbortSignal): Promise<number> {
    if (!this.settings.autoExtract) return 0
    if (this.backgroundPaused()) {
      const limit = this.state.getLimit()
      this.ctx.logger.debug?.('dsh-memories: background pass paused until %s (%d refusals)', new Date(limit?.until ?? 0).toISOString(), limit?.failures ?? 0)
      return 0
    }
    if (agent.status !== 'idle') return 0
    const session = agent.session
    const key = session.id
    if (this.extracting.has(key)) return 0
    const llm = this.llm
    if (llm === undefined) return 0
    this.extracting.add(key)
    this.mined.add(key)
    // Keep the event loop alive for the duration: a one-shot run has nothing
    // else scheduled, and Node would exit mid-request. Released in `finally`.
    const hold = setTimeout(() => undefined, this.settings.extractTimeoutMs + 1_000)
    try {
      const watermark = this.state.getSession(key)
      const afterSeq = watermark?.lastSeq ?? 0
      const window = collectWindow(session, afterSeq, this.settings.extractWindowMessages, this.settings.extractMaxInputChars)
      if (window.lastSeq === undefined || window.text.trim().length === 0) return 0
      const root = await this.projectRoot(session)
      const projectLabel = this.store.target('project', root).label
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
          const result = await this.store.upsert(draft, draft.scope === 'project' ? root : undefined, 'auto')
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
          this.ctx.logger.warn('dsh-memories: could not write the evidence note for %s: %o', key, error)
        })
        this.log.info('dsh-memories: stored %d memories from session %s (%s)', outcome.drafts.length, key, stored.join(', '))
      }
      this.state.putSession(key, {
        lastSeq: window.lastSeq,
        at: Date.now(),
        root,
        activityAt: Date.now(),
        ...outcome.kind === 'memories' ? { contributed: true } : {},
      })
      return outcome.kind === 'memories' ? outcome.drafts.length : 0
    } finally {
      clearTimeout(hold)
      this.extracting.delete(key)
    }
  }

  /** Force an extraction now, ignoring the idle timer (used by `/memories mine`). */
  async mineNow(agent: Agent): Promise<number> {
    this.cancelExtraction(agent)
    const stored = await this.runExtraction(agent)
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
      const project = await this.store.list('project', root, { fresh: true })
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
        projectLabel: this.store.target('project', root).label,
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
          this.ctx.logger.warn('dsh-memories: could not stage skill draft %s: %o', draft.name, error)
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
    for (const slug of await this.store.listProjects()) {
      const descriptor = await this.store.readProjectDescriptor(slug)
      if (descriptor === undefined) continue
      archived += await this.retain('project', descriptor.root, now)
    }
    if (archived > 0) this.ctx.logger.info('dsh-memories: archived %d unused memories', archived)
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
    const lines = [
      `memory home: ${this.store.memoriesDir}`,
      ...states.map((scope) => `${scope.label}: ${scope.entries.length} memories`),
      `auto-extract: ${this.settings.autoExtract ? `on (idle ${Math.round(this.settings.autoExtractIdleMs / 1000)}s, ≥${this.settings.minIdleHours}h, ≤${this.settings.maxAgeDays}d)` : 'off'}`,
      `recall: ${this.settings.recallMode} (score ≥${this.settings.recallMinScore}, ≤${this.settings.recallMaxPerConversation} per conversation)`,
      `retention: ${this.settings.maxUnusedDays > 0 ? `archive after ${this.settings.maxUnusedDays}d unused` : 'off'}${this.sweepLine()}`,
      `session mode: ${this.sessionMode(session)}`,
      `logging: ${this.settings.logLevel}${this.settings.traceMaintenance ? ' + maintenance trace' : ''} → ${this.deployment.logFile.length > 0 ? this.deployment.logFile : 'off'}`,
      `sessions mined: ${this.state.sessionCount()}`,
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
      }), 'dsh-memories.settingsWatch')
    } catch (error) {
      ctx.logger.warn('dsh-memories: settings registration failed, using row defaults: %o', error)
    }
  }

  // The host logger drops `warn` and `debug` before any sink sees them: the only
  // exporter a stock composition installs declares no level, so the threshold
  // falls back to 1 and `warn` (2) is filtered out. Registering our own exporter
  // with `levels.default = 3` overrides that, and the file then records whatever
  // `logLevel` allows — which is what makes a failed extraction, a quota refusal,
  // or a retention decision observable at all.
  const sink = createFileSink(deployment.logFile)
  if (sink !== undefined) {
    ctx.logger.exporter(createLogExporter(sink, () => current.logLevel))
  } else if (deployment.logFile.trim().length > 0) {
    ctx.logger.warn('dsh-memories: could not open the log file %s', deployment.logFile)
  }

  const runtime = new MemoriesRuntime(ctx, config, read)
  ctx.effect(() => () => runtime.dispose(), 'dsh-memories.lifecycle')
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
      ctx.logger.warn('dsh-memories: remote registration failed, the settings page stays unavailable: %o', error)
    }
  }
  // Import (and remove) a pre-SQLite watermark file once, so upgrading does not
  // re-mine conversations that were already processed.
  void importLegacyState(runtime.state, runtime.store.memoriesDir).then((imported) => {
    if (imported === undefined) return
    ctx.logger.info('dsh-memories: imported %d watermarks from the legacy state file', imported)
  }).catch((error: unknown) => {
    ctx.logger.warn('dsh-memories: legacy state import failed: %o', error)
  })
  // The first sweep runs here rather than waiting for a session to settle: a
  // process that starts and stops (a script, a one-shot task) then still gets
  // the periodic cleanup it would otherwise never reach.
  void runtime.sweepIfDue().catch((error: unknown) => {
    ctx.logger.warn('dsh-memories: startup sweep failed: %o', error)
  })
  ctx.logger.info(
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
