/**
 * Configuration for `dsh-memories`.
 *
 * Two layers, deliberately separated:
 *
 * - **Deployment** (cordis row config): where the store lives and how a
 *   workspace root is identified. These are composition facts; changing them
 *   means restarting the surface.
 * - **Tunables** (the `memories` settings namespace): every behavioural knob,
 *   hot-reloaded from `$DSH_HOME/settings.yaml` and editable from the DSH
 *   Settings shell. {@link MemoriesSettingsSchema} is exactly the schema the
 *   settings seam publishes, so the GUI form and the runtime read one
 *   definition.
 *
 * @module dsh-memories/config
 */
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { logPath, toLogLevel } from './log.js'

/** Settings namespace owning every tunable. */
export const SETTINGS_NS = 'memories'

/** Default child-name markers that identify a workspace root. */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

/** Default byte budget for the injected memory summary. */
export const DEFAULT_MAX_SUMMARY_BYTES = 4096

/** Default cap on entries listed in the injected summary per scope. */
export const DEFAULT_MAX_SUMMARY_ENTRIES = 12

/**
 * Default cap on the GLOBAL section's bullets, below {@link DEFAULT_MAX_SUMMARY_ENTRIES}.
 *
 * The two scopes share one byte budget and the global section renders first, so
 * an uncapped global scope absorbs whatever the project scope leaves over.
 * Measured on a real store: a two-memory project session spent 87% of its budget
 * on global entries, and in every session the same six were unrelated to the
 * workspace (a plugin's logger threshold, a sidebar adapter, a model catalog).
 * Four keeps the portable half visible without letting it bury the scope that is
 * actually about this conversation.
 */
export const DEFAULT_GLOBAL_SUMMARY_ENTRIES = 4

/**
 * Default byte budget for the global section alone, inside {@link DEFAULT_MAX_SUMMARY_BYTES}.
 *
 * A count cap is not enough. Chinese entries cost roughly three bytes per
 * character, so four of them fill about 2.6 KB of a 4 KB block — measured on a
 * real store the global half still took 45–81% of every session after the count
 * cap was added. Reserving bytes is what actually leaves room for the scope that
 * is about this conversation.
 *
 * 1200 is about a third of the content budget: the block's frame (intro and
 * guidance) costs ~700 bytes of the 4096, so the two scopes divide ~3400, and a
 * third to the half that every session shares leaves two thirds to the half that
 * is actually about this workspace.
 */
export const DEFAULT_GLOBAL_SUMMARY_BYTES = 1200

/**
 * Default number of those entries reserved for memories never listed before.
 *
 * Three, because the reservation is a queue that drains: once an entry has been
 * listed it leaves the pool, and unused slots fall back to the ranking, so the
 * steady-state cost is one slot per newly written memory. It only ever costs
 * more than that while there is a backlog of never-listed memories — which is
 * exactly when showing them matters. Measured on a real store, two slots pushed
 * the correction of an already-listed memory to the *next* session and three
 * showed both in the first one. `0` restores pure ranking, which on a saturated
 * scope is a fixed point that never shows anything new.
 */
export const DEFAULT_SUMMARY_FRESH_SLOTS = 3

/** Default cap on stored entries per scope before the oldest are evicted. */
export const DEFAULT_MAX_ENTRIES_PER_SCOPE = 200

/** Default hours between periodic maintenance sweeps; `0` disables the sweep. */
export const DEFAULT_SWEEP_INTERVAL_HOURS = 12

/** Default days an unused memory survives before it is archived; `0` disables archival. */
export const DEFAULT_MAX_UNUSED_DAYS = 90

/**
 * Default days a `snapshot` memory survives before it is archived; `0` disables.
 *
 * A reading taken at one moment is wrong from the day after it was taken, and
 * reading it does not make it right, so it cannot be judged by the unused clock
 * that a convention is judged by. Sixty days is long enough to be useful as
 * history and short enough that a stale number stops being quoted.
 */
export const DEFAULT_SNAPSHOT_MAX_AGE_DAYS = 60

/** Default share of title/body tokens two memories must have in common to be merged. */
export const DEFAULT_DEDUPE_SIMILARITY = 0.7

/** Default recall mode: how much of a conversation pays for cross-session memory. */
export const DEFAULT_RECALL_MODE = 'on-demand'

/**
 * Default minimum relevance a recall delta must reach.
 *
 * 20 was the old value and it silently disabled Chinese recall: a Chinese
 * paraphrase that shares two bigrams with a title scores around 9-12, so nothing
 * ever cleared it. The floor is now a strictness knob, and the PRECISION lives in
 * `recallMinTerms` — the structural evidence gate, which a score threshold cannot
 * replace. 9 is just above one shared bigram in a title (8) so that a single
 * common word is never sufficient on its own.
 */
export const DEFAULT_RECALL_MIN_SCORE = 9

/** Default cap on recall deltas injected into one conversation. */
export const DEFAULT_RECALL_MAX_PER_CONVERSATION = 4

/**
 * Default byte budget for one recall delta block.
 *
 * Sized for the several short entries a single turn can legitimately match, not
 * for one: the frame and the preamble cost roughly 250 bytes, and a one-line
 * entry costs about 90. At 800 a two-entry block would not fit, which is why
 * this is not 400 as it was when a delta could only ever hold one memory.
 */
export const DEFAULT_RECALL_MAX_BYTES = 1_200

/** Default minimum length of a user turn worth a recall decision. */
export const DEFAULT_RECALL_MIN_QUERY_CHARS = 2

/**
 * Default number of distinct strong-field terms a recall needs.
 *
 * Two is what makes a paraphrased question reachable without letting a shared
 * common word in: "这个插件的日志在哪里" shares 插件 and 日志 with a memory titled
 * "插件日志的查看方式" (two terms, credited), while "该插件是否有日志" shares only
 * 插件 with a title about plugin registration order (one term, not credited).
 */
export const DEFAULT_RECALL_MIN_TERMS = 2

/**
 * Every valid recall mode.
 *
 * `once` is the original behaviour (one bounded summary per conversation, every
 * later recall through the tool); `on-demand` additionally injects a small delta
 * when the current turn clearly matches a stored memory; `off` leaves only the
 * tool. The mode decides what a conversation pays for, so it is a user knob.
 */
export const RECALL_MODES = ['once', 'on-demand', 'off'] as const

/** How much cross-session memory one conversation pays for. */
export type RecallMode = (typeof RECALL_MODES)[number]

/** Narrow an unknown value to a recall mode, defaulting to `on-demand`. */
export function toRecallMode(value: unknown): RecallMode {
  return typeof value === 'string' && (RECALL_MODES as readonly string[]).includes(value)
    ? value as RecallMode
    : DEFAULT_RECALL_MODE
}

/** Default idle delay before a finished session is mined for memories. */
export const DEFAULT_AUTO_EXTRACT_IDLE_MS = 300_000

/** Default number of surface messages handed to the extractor. */
export const DEFAULT_EXTRACT_WINDOW_MESSAGES = 60

/** Default character budget for the extraction transcript. */
export const DEFAULT_EXTRACT_MAX_INPUT_CHARS = 48_000

/**
 * Default minutes between periodic extraction checks; `0` disables them.
 *
 * A settle-only pass mines a session once, after it has been quiet for the whole
 * quiet window, and reads only the newest slice of it — so a long working session
 * loses everything before that slice for good, because the watermark moves past
 * it. A periodic check mines in slices as the session runs, which is also why the
 * window above is sized for one interval rather than for a whole conversation.
 */
export const DEFAULT_EXTRACT_INTERVAL_MINUTES = 30

/** Default output-token cap for one extraction call. */
export const DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS = 2048

/** Default timeout for one extraction call. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 120_000

/** Default max drafts one extraction may produce. */
export const DEFAULT_EXTRACT_MAX_MEMORIES = 5

/** Default idle hours a session must accumulate before it is mined. */
export const DEFAULT_MIN_IDLE_HOURS = 6

/** Default age limit: sessions idle longer than this are never mined. */
export const DEFAULT_MAX_AGE_DAYS = 10

/** Default cap on sessions mined per pass. */
export const DEFAULT_MAX_SESSIONS_PER_PASS = 2

/** Default hours between consolidation passes. */
export const DEFAULT_CONSOLIDATE_COOLDOWN_HOURS = 6

/** Default cap on entries one consolidation pass considers. */
export const DEFAULT_CONSOLIDATE_MAX_ENTRIES = 64

/** Default timeout for one consolidation sub-agent run. */
export const DEFAULT_CONSOLIDATE_TIMEOUT_MS = 180_000

/** Default wait after a provider refuses a background pass for quota or rate. */
export const DEFAULT_QUOTA_COOLDOWN_MINUTES = 30

/** Default ceiling for that wait as consecutive refusals double it. */
export const DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES = 480

/** Default verbosity of the plugin's own log file. */
export const DEFAULT_LOG_LEVEL = 'info' as const

/** Default for logging every maintenance decision rather than only pass summaries. */
export const DEFAULT_TRACE_MAINTENANCE = false

/**
 * Default peak-hours spec: none.
 *
 * Deliberately empty rather than pre-filled with one provider's timetable: this
 * plugin can run on any route, and silently refusing to work at certain hours
 * would be a surprising default. The description names a value that suits
 * DeepSeek.
 */
export const DEFAULT_PEAK_HOURS = ''
/**
 * The tunable settings section: one schema shared by the settings seam, the
 * GUI form, and the runtime. Every field carries its default, so an absent
 * `memories:` section in `settings.yaml` resolves to exactly the shipped
 * behaviour.
 */
export const MemoriesSettingsSchema = z.object({
  /** Byte budget for the injected summary. `0` disables injection. */
  maxSummaryBytes: z.number().default(DEFAULT_MAX_SUMMARY_BYTES).description('Byte budget for the memory summary injected once per conversation. 0 disables injection and leaves only the memory tool.'),
  /** Max entries listed per scope in the injected summary. */
  maxSummaryEntries: z.number().default(DEFAULT_MAX_SUMMARY_ENTRIES).description('How many memories each scope lists in the injected summary.'),
  /** Max entries listed for the global scope, which every session shares. */
  globalSummaryEntries: z.number().default(DEFAULT_GLOBAL_SUMMARY_ENTRIES).description('How many memories the GLOBAL section may list, capped below maxSummaryEntries. Both scopes share one byte budget and global renders first, so without this the global half grows to fill whatever the project half leaves (measured: 87% of a small project\'s summary). 0 removes the global section entirely.'),
  /** Byte budget for the global section alone. */
  globalSummaryBytes: z.number().default(DEFAULT_GLOBAL_SUMMARY_BYTES).description('Byte budget for the GLOBAL section, inside maxSummaryBytes. A count cap is not enough because Chinese entries are ~3 bytes per character: four of them still filled 60% of a 4 KB block. 0 removes the global section entirely.'),
  /** How many of those entries are reserved for never-listed memories. */
  summaryFreshSlots: z.number().default(DEFAULT_SUMMARY_FRESH_SLOTS).description('How many of each scope\'s summary entries are reserved for memories that have never been listed before, preferring ones written deliberately over extracted ones. 0 leaves selection to the ranking alone, which on a full scope never shows anything new.'),
  /** How the injected summary is refreshed as the conversation moves on. */
  recallMode: z.string().default(DEFAULT_RECALL_MODE).description('once injects the summary once per conversation; on-demand also injects a small delta when the current turn clearly matches a memory; off disables injection and leaves only the memory tool.'),
  /** Minimum relevance a recall delta must reach. */
  recallMinScore: z.number().default(DEFAULT_RECALL_MIN_SCORE).description('Minimum relevance a memory must reach before it is injected as a recall delta. A strictness knob, not the precision gate: recallMinTerms is what keeps generic overlap out. Raise it to demand a stronger lexical match.'),
  /** Cap on recall deltas injected into one conversation. */
  recallMaxPerConversation: z.number().default(DEFAULT_RECALL_MAX_PER_CONVERSATION).description('Maximum recall deltas injected into one conversation, counted per memory. 0 disables them.'),
  /** Byte budget for one recall delta block. */
  recallMaxBytes: z.number().default(DEFAULT_RECALL_MAX_BYTES).description('Byte budget for one on-demand recall block. 0 disables recall deltas.'),
  /** Shortest user turn worth a recall decision. */
  recallMinQueryChars: z.number().default(DEFAULT_RECALL_MIN_QUERY_CHARS).description('Shortest user turn, in characters, that may trigger a recall delta. Short acknowledgements are skipped instead of scanning the store.'),
  /** Distinct strong-field terms a recall needs before it is credited. */
  recallMinTerms: z.number().default(DEFAULT_RECALL_MIN_TERMS).description('Distinct query terms that must land in the title, keys, tags, or appliesTo before a memory may be recalled on demand. This is what keeps a Chinese turn from recalling every memory that shares a common word like 插件 or 日志. 1 makes the relevance floor the only gate, which is noticeably noisier for Chinese; 0 disables the check.'),
  /** Max stored entries per scope; the least-recently-updated are evicted. */
  maxEntriesPerScope: z.number().default(DEFAULT_MAX_ENTRIES_PER_SCOPE).description('Stored memories per scope; past this cap the least recently used are deleted.'),
  /** Days an unused memory survives before it is archived. `0` disables archival. */
  maxUnusedDays: z.number().default(DEFAULT_MAX_UNUSED_DAYS).description('Days an unused memory survives before it is archived. Archived entries are recoverable with /memories restore. 0 disables archival.'),
  /** Days a snapshot memory survives regardless of use. `0` disables. */
  snapshotMaxAgeDays: z.number().default(DEFAULT_SNAPSHOT_MAX_AGE_DAYS).description('Days a memory marked durability=snapshot survives before it is archived, counted from when it was measured rather than from when it was last read. A stale number is worse than no number, and being read does not make it right. 0 disables snapshot expiry.'),
  /** Token overlap above which a new memory supersedes an existing one. */
  dedupeSimilarity: z.number().default(DEFAULT_DEDUPE_SIMILARITY).description('Share of title and body tokens two memories must have in common before the newer one supersedes the older. 0 keeps only the exact-match rule.'),
  /** Hours between periodic maintenance sweeps. `0` disables the sweep. */
  sweepIntervalHours: z.number().default(DEFAULT_SWEEP_INTERVAL_HOURS).description('Hours between periodic maintenance sweeps, which apply retention across every known workspace. 0 disables the sweep.'),
  /** Whether the idle-time background extractor runs at all. */
  autoExtract: z.boolean().default(true).description('Mine finished sessions for durable facts after they have been idle.'),
  /** Idle milliseconds before a session is mined. */
  autoExtractIdleMs: z.number().default(DEFAULT_AUTO_EXTRACT_IDLE_MS).description('How long a session must stay idle before it is mined.'),
  /** Surface messages included in one extraction window. */
  extractWindowMessages: z.number().default(DEFAULT_EXTRACT_WINDOW_MESSAGES).description('How many recent conversation messages one extraction reads.'),
  /** Character budget for the extraction transcript. */
  extractMaxInputChars: z.number().default(DEFAULT_EXTRACT_MAX_INPUT_CHARS).description('Character budget for the transcript handed to the extractor.'),
  /** Output-token cap for one extraction call. */
  extractMaxOutputTokens: z.number().default(DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS).description('Output token cap for one extraction call.'),
  /** Timeout for one extraction call. */
  extractTimeoutMs: z.number().default(DEFAULT_EXTRACT_TIMEOUT_MS).description('Timeout for one extraction call.'),
  /** Max drafts one extraction may produce. */
  extractMaxMemories: z.number().default(DEFAULT_EXTRACT_MAX_MEMORIES).description('Maximum memories one extraction pass may store.'),
  /** Minutes between periodic extraction checks over every open session. */
  extractIntervalMinutes: z.number().default(DEFAULT_EXTRACT_INTERVAL_MINUTES).description('How often to check every open session for new material and mine it in slices. Fractions are allowed. 0 disables the periodic check, leaving mining to the settle timer and the exit flush. Peak hours and the quota gate still apply; a session with nothing new costs no model call.'),
  /** A session must have been idle this long before it is mined. */
  minIdleHours: z.number().default(DEFAULT_MIN_IDLE_HOURS).description('A session must have been idle at least this many hours before it is mined.'),
  /** Sessions older than this are never mined. */
  maxAgeDays: z.number().default(DEFAULT_MAX_AGE_DAYS).description('Sessions whose last activity is older than this are never mined.'),
  /** Sessions mined per pass; bounds one pass\'s quota cost. */
  maxSessionsPerPass: z.number().default(DEFAULT_MAX_SESSIONS_PER_PASS).description('How many sessions one extraction pass may mine, newest first.'),
  consolidate: z.boolean().default(true).description('After new memories land, merge and reconcile them through a restricted sub-agent.'),
  consolidateCooldownHours: z.number().default(DEFAULT_CONSOLIDATE_COOLDOWN_HOURS).description('Minimum hours between consolidation passes; bounds background quota use.'),
  consolidateMaxEntries: z.number().default(DEFAULT_CONSOLIDATE_MAX_ENTRIES).description('How many memories one consolidation pass may consider.'),
  consolidateTimeoutMs: z.number().default(DEFAULT_CONSOLIDATE_TIMEOUT_MS).description('Timeout for one consolidation sub-agent run.'),
  /** Stop background passes while the provider is refusing for quota or rate. */
  pauseOnQuotaError: z.boolean().default(true).description('Stop background extraction and consolidation after a rate-limit or exhausted-quota error, until the cooldown elapses.'),
  /** Wait after the first such refusal; doubles per consecutive refusal. */
  quotaCooldownMinutes: z.number().default(DEFAULT_QUOTA_COOLDOWN_MINUTES).description('Minutes to wait after a rate-limit or quota refusal. Doubles per consecutive refusal.'),
  /** Ceiling for that doubling. */
  quotaCooldownMaxMinutes: z.number().default(DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES).description('Upper bound for the quota cooldown.'),
  /** Explicit extraction provider route; empty reuses the session route. */
  extractProvider: z.string().default('').description("Provider route for extraction. Empty reuses the session's own logged route."),
  /** Explicit extraction model; empty reuses the session route. */
  extractModel: z.string().default('').description("Model for extraction. Empty reuses the session's own logged route."),
  /** Explicit consolidation provider route; empty falls back to the extraction route. */
  consolidateProvider: z.string().default('').description('Provider route for consolidation. Empty falls back to the extraction route, then the session route.'),
  /** Explicit consolidation model; empty falls back to the extraction route. */
  consolidateModel: z.string().default('').description('Model for consolidation. Empty falls back to the extraction route, then the session route.'),
  /** Whether the `memory` tool is registered for the model. */
  enableTool: z.boolean().default(true).description('Register the model-facing memory tool.'),
  /** Whether `/memories` is registered. */
  enableCommand: z.boolean().default(true).description('Register the /memories slash command.'),
  /** How much this plugin records in its own log file. */
  logLevel: z.string().default(DEFAULT_LOG_LEVEL).description('How much dsh-memories writes to its log file: off, error, warn, info, or debug. info keeps errors, warnings, and pass summaries; debug adds per-entry decisions.'),
  /** Whether maintenance decisions are logged at info, where a stock logLevel keeps them. */
  traceMaintenance: z.boolean().default(DEFAULT_TRACE_MAINTENANCE).description('Log every retention, recall, and selection decision at info instead of debug. Off keeps the file to one line per pass.'),
  /** Local-time windows whose tokens are the expensive ones. */
  peakHours: z.string().default(DEFAULT_PEAK_HOURS).description('Local-time peak windows to keep the plugin\'s model calls out of, for example "Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00" (DeepSeek charges double then, Beijing time). Background extraction and consolidation are deferred to the next off-peak moment; /memories mine and /memories consolidate ignore this. Empty disables the restriction.'),
})

/** The tunable section's value type, inferred from the settings schema. */
export type MemoriesSettings = Schemastery.TypeT<typeof MemoriesSettingsSchema>

/** The shipped tunables, used as the composition base and fallback. */
export const MEMORIES_SETTINGS_DEFAULTS: MemoriesSettings = {
  maxSummaryBytes: DEFAULT_MAX_SUMMARY_BYTES,
  maxSummaryEntries: DEFAULT_MAX_SUMMARY_ENTRIES,
  globalSummaryEntries: DEFAULT_GLOBAL_SUMMARY_ENTRIES,
  globalSummaryBytes: DEFAULT_GLOBAL_SUMMARY_BYTES,
  summaryFreshSlots: DEFAULT_SUMMARY_FRESH_SLOTS,
  recallMode: DEFAULT_RECALL_MODE,
  recallMinScore: DEFAULT_RECALL_MIN_SCORE,
  recallMaxPerConversation: DEFAULT_RECALL_MAX_PER_CONVERSATION,
  recallMaxBytes: DEFAULT_RECALL_MAX_BYTES,
  recallMinQueryChars: DEFAULT_RECALL_MIN_QUERY_CHARS,
  recallMinTerms: DEFAULT_RECALL_MIN_TERMS,
  maxEntriesPerScope: DEFAULT_MAX_ENTRIES_PER_SCOPE,
  maxUnusedDays: DEFAULT_MAX_UNUSED_DAYS,
  snapshotMaxAgeDays: DEFAULT_SNAPSHOT_MAX_AGE_DAYS,
  dedupeSimilarity: DEFAULT_DEDUPE_SIMILARITY,
  sweepIntervalHours: DEFAULT_SWEEP_INTERVAL_HOURS,
  autoExtract: true,
  autoExtractIdleMs: DEFAULT_AUTO_EXTRACT_IDLE_MS,
  extractWindowMessages: DEFAULT_EXTRACT_WINDOW_MESSAGES,
  extractMaxInputChars: DEFAULT_EXTRACT_MAX_INPUT_CHARS,
  extractMaxOutputTokens: DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS,
  extractTimeoutMs: DEFAULT_EXTRACT_TIMEOUT_MS,
  extractMaxMemories: DEFAULT_EXTRACT_MAX_MEMORIES,
  extractIntervalMinutes: DEFAULT_EXTRACT_INTERVAL_MINUTES,
  minIdleHours: DEFAULT_MIN_IDLE_HOURS,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  maxSessionsPerPass: DEFAULT_MAX_SESSIONS_PER_PASS,
  consolidate: true,
  consolidateCooldownHours: DEFAULT_CONSOLIDATE_COOLDOWN_HOURS,
  consolidateMaxEntries: DEFAULT_CONSOLIDATE_MAX_ENTRIES,
  consolidateTimeoutMs: DEFAULT_CONSOLIDATE_TIMEOUT_MS,
  pauseOnQuotaError: true,
  quotaCooldownMinutes: DEFAULT_QUOTA_COOLDOWN_MINUTES,
  quotaCooldownMaxMinutes: DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES,
  extractProvider: '',
  extractModel: '',
  consolidateProvider: '',
  consolidateModel: '',
  enableTool: true,
  enableCommand: true,
  logLevel: DEFAULT_LOG_LEVEL,
  traceMaintenance: DEFAULT_TRACE_MAINTENANCE,
  peakHours: DEFAULT_PEAK_HOURS,
}

/** Deployment-layer configuration: paths and workspace discovery. */
export const Config = z.object({
  /** Harness home; defaults to `$DSH_HOME` (or `~/.dsh`). */
  dshHome: z.string(),
  /** Directory holding every memory store; defaults to `<dshHome>/memories`. */
  memoriesDir: z.string(),
  /** Child names that mark a workspace root during the upward walk. */
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
})

/** The raw, possibly partial deployment configuration the loader hands `apply`. */
export interface MemoriesConfig {
  dshHome?: string
  memoriesDir?: string
  projectRootMarkers?: string[]
  /** Plugin log file; defaults to `<dshHome>/logs/dsh-memories.log`. Empty disables file logging. */
  logFile?: string
  /** Deployment-layer tunable defaults, below the settings user layer. */
  defaults?: Partial<MemoriesSettings>
  /** Legacy flat spellings, accepted so an existing row keeps working. */
  maxSummaryBytes?: number
  maxSummaryEntries?: number
  globalSummaryEntries?: number
  globalSummaryBytes?: number
  summaryFreshSlots?: number
  maxEntriesPerScope?: number
  maxUnusedDays?: number
  snapshotMaxAgeDays?: number
  dedupeSimilarity?: number
  sweepIntervalHours?: number
  recallMode?: string
  recallMinScore?: number
  recallMaxPerConversation?: number
  recallMaxBytes?: number
  recallMinQueryChars?: number
  recallMinTerms?: number
  autoExtract?: boolean
  autoExtractIdleMs?: number
  extractWindowMessages?: number
  extractMaxInputChars?: number
  extractMaxOutputTokens?: number
  extractTimeoutMs?: number
  extractMaxMemories?: number
  extractIntervalMinutes?: number
  minIdleHours?: number
  maxAgeDays?: number
  maxSessionsPerPass?: number
  consolidate?: boolean
  consolidateCooldownHours?: number
  consolidateMaxEntries?: number
  consolidateTimeoutMs?: number
  extractProvider?: string
  extractModel?: string
  consolidateProvider?: string
  consolidateModel?: string
  pauseOnQuotaError?: boolean
  quotaCooldownMinutes?: number
  quotaCooldownMaxMinutes?: number
  enableTool?: boolean
  enableCommand?: boolean
  logLevel?: string
  traceMaintenance?: boolean
  peakHours?: string
}

/** Fully resolved deployment configuration. */
export interface ResolvedConfig {
  readonly dshHome: string
  readonly memoriesDir: string
  readonly projectRootMarkers: readonly string[]
  /**
   * Log file for the plugin's own lines; empty disables file logging.
   *
   * A deployment fact rather than a tunable: it is a path. The knob that matters
   * day to day is `logLevel`.
   */
  readonly logFile: string
  /** Deployment-layer tunable defaults (below the settings user layer). */
  readonly defaults: MemoriesSettings
}

/** Clamp one tunable into a usable range. */
function positive(value: number | undefined, fallback: number, min = 1): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value < min ? min : Math.trunc(value)
}

/** Clamp one ratio into `[0, 1]`, where `0` disables the behaviour it gates. */
function clampUnit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

/**
 * Clamp one tunable that accepts fractions, such as a wait in hours.
 *
 * `positive` truncates, which would turn `minIdleHours: 0.5` — half an hour —
 * into `0`, silently disabling the gate it configures.
 */
function decimal(value: number | undefined, fallback: number, min = 0): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value < min ? min : value
}

/** Coerce one possibly-absent tunable set into a complete, clamped section. */
export function normalizeSettings(input: Partial<MemoriesSettings> | undefined): MemoriesSettings {
  const value = input ?? {}
  const provider = value.extractProvider?.trim() ?? ''
  const model = value.extractModel?.trim() ?? ''
  const route = provider.length > 0 && model.length > 0
    ? { extractProvider: provider, extractModel: model }
    : { extractProvider: '', extractModel: '' }
  const consolidateProvider = value.consolidateProvider?.trim() ?? ''
  const consolidateModel = value.consolidateModel?.trim() ?? ''
  // A lone half is not a route: the pair resolves together or not at all, and an
  // empty consolidation route falls back to the extraction one at call time.
  const consolidateRoute = consolidateProvider.length > 0 && consolidateModel.length > 0
    ? { consolidateProvider, consolidateModel }
    : { consolidateProvider: '', consolidateModel: '' }
  return {
    maxSummaryBytes: positive(value.maxSummaryBytes, DEFAULT_MAX_SUMMARY_BYTES, 0),
    maxSummaryEntries: positive(value.maxSummaryEntries, DEFAULT_MAX_SUMMARY_ENTRIES),
    globalSummaryEntries: positive(value.globalSummaryEntries, DEFAULT_GLOBAL_SUMMARY_ENTRIES, 0),
    globalSummaryBytes: positive(value.globalSummaryBytes, DEFAULT_GLOBAL_SUMMARY_BYTES, 0),
    summaryFreshSlots: positive(value.summaryFreshSlots, DEFAULT_SUMMARY_FRESH_SLOTS, 0),
    recallMode: toRecallMode(value.recallMode),
    recallMinScore: positive(value.recallMinScore, DEFAULT_RECALL_MIN_SCORE, 0),
    recallMaxPerConversation: positive(value.recallMaxPerConversation, DEFAULT_RECALL_MAX_PER_CONVERSATION, 0),
    recallMaxBytes: positive(value.recallMaxBytes, DEFAULT_RECALL_MAX_BYTES, 0),
    recallMinQueryChars: positive(value.recallMinQueryChars, DEFAULT_RECALL_MIN_QUERY_CHARS, 0),
    recallMinTerms: positive(value.recallMinTerms, DEFAULT_RECALL_MIN_TERMS, 0),
    maxEntriesPerScope: positive(value.maxEntriesPerScope, DEFAULT_MAX_ENTRIES_PER_SCOPE),
    maxUnusedDays: positive(value.maxUnusedDays, DEFAULT_MAX_UNUSED_DAYS, 0),
    snapshotMaxAgeDays: positive(value.snapshotMaxAgeDays, DEFAULT_SNAPSHOT_MAX_AGE_DAYS, 0),
    dedupeSimilarity: clampUnit(value.dedupeSimilarity, DEFAULT_DEDUPE_SIMILARITY),
    sweepIntervalHours: decimal(value.sweepIntervalHours, DEFAULT_SWEEP_INTERVAL_HOURS),
    autoExtract: value.autoExtract ?? true,
    autoExtractIdleMs: positive(value.autoExtractIdleMs, DEFAULT_AUTO_EXTRACT_IDLE_MS, 1000),
    extractWindowMessages: positive(value.extractWindowMessages, DEFAULT_EXTRACT_WINDOW_MESSAGES),
    extractMaxInputChars: positive(value.extractMaxInputChars, DEFAULT_EXTRACT_MAX_INPUT_CHARS),
    extractMaxOutputTokens: positive(value.extractMaxOutputTokens, DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS),
    extractTimeoutMs: positive(value.extractTimeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS),
    extractMaxMemories: positive(value.extractMaxMemories, DEFAULT_EXTRACT_MAX_MEMORIES),
    extractIntervalMinutes: decimal(value.extractIntervalMinutes, DEFAULT_EXTRACT_INTERVAL_MINUTES),
    minIdleHours: decimal(value.minIdleHours, DEFAULT_MIN_IDLE_HOURS),
    maxAgeDays: positive(value.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 0),
    maxSessionsPerPass: positive(value.maxSessionsPerPass, DEFAULT_MAX_SESSIONS_PER_PASS),
    consolidate: value.consolidate ?? true,
    consolidateCooldownHours: decimal(value.consolidateCooldownHours, DEFAULT_CONSOLIDATE_COOLDOWN_HOURS),
    consolidateMaxEntries: positive(value.consolidateMaxEntries, DEFAULT_CONSOLIDATE_MAX_ENTRIES),
    consolidateTimeoutMs: positive(value.consolidateTimeoutMs, DEFAULT_CONSOLIDATE_TIMEOUT_MS),
    pauseOnQuotaError: value.pauseOnQuotaError ?? true,
    quotaCooldownMinutes: positive(value.quotaCooldownMinutes, DEFAULT_QUOTA_COOLDOWN_MINUTES, 0),
    quotaCooldownMaxMinutes: positive(value.quotaCooldownMaxMinutes, DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES, 0),
    ...route,
    ...consolidateRoute,
    enableTool: value.enableTool ?? true,
    enableCommand: value.enableCommand ?? true,
    logLevel: toLogLevel(value.logLevel, DEFAULT_LOG_LEVEL),
    traceMaintenance: value.traceMaintenance ?? false,
    peakHours: (value.peakHours ?? '').replace(/\s+/gu, ' ').trim(),
  }
}

/**
 * The route one consolidation pass runs on.
 *
 * Codex keeps `memories.extract_model` and `memories.consolidation_model`
 * separate; here an unset consolidation route falls back to the extraction one
 * and then to the session's own logged route, so an existing configuration that
 * only names `extractProvider`/`extractModel` keeps behaving as before.
 *
 * @param settings - the tunables in force.
 * @returns the provider/model pair, or `{}` to reuse the session route.
 */
export function consolidationRouteOf(settings: MemoriesSettings): { provider?: string; model?: string } {
  if (settings.consolidateProvider.length > 0 && settings.consolidateModel.length > 0) {
    return { provider: settings.consolidateProvider, model: settings.consolidateModel }
  }
  if (settings.extractProvider.length > 0 && settings.extractModel.length > 0) {
    return { provider: settings.extractProvider, model: settings.extractModel }
  }
  return {}
}
/**
 * Resolve deployment paths and the tunable defaults.
 *
 * Flat legacy keys are read first so an existing single-level row keeps
 * working; `defaults` wins over them when both are present.
 * @param config - user-facing plugin configuration.
 * @returns normalized deployment configuration.
 */
export function resolveConfig(config: MemoriesConfig = {}): ResolvedConfig {
  const dshHome = resolveDshHome(config.dshHome)
  const memoriesDir = config.memoriesDir !== undefined && config.memoriesDir.trim().length > 0
    ? config.memoriesDir
    : `${dshHome}/memories`
  const markers = (config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS])
    .filter((marker) => marker.trim().length > 0)
  const legacySource = config as Record<string, unknown>
  const legacy: Partial<MemoriesSettings> = {}
  for (const key of Object.keys(MEMORIES_SETTINGS_DEFAULTS) as (keyof MemoriesSettings)[]) {
    const value = legacySource[key]
    if (value !== undefined) (legacy as Record<string, unknown>)[key] = value
  }
  return {
    dshHome,
    memoriesDir,
    projectRootMarkers: markers.length > 0 ? markers : [...DEFAULT_PROJECT_ROOT_MARKERS],
    // Only `undefined` falls back to the default location, so an explicit empty
    // string disables file logging.
    logFile: config.logFile?.trim() ?? logPath(dshHome),
    defaults: normalizeSettings({ ...legacy, ...config.defaults }),
  }
}
