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

/** Settings namespace owning every tunable. */
export const SETTINGS_NS = 'memories'

/** Default child-name markers that identify a workspace root. */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

/** Default byte budget for the injected memory summary. */
export const DEFAULT_MAX_SUMMARY_BYTES = 4096

/** Default cap on entries listed in the injected summary per scope. */
export const DEFAULT_MAX_SUMMARY_ENTRIES = 12

/** Default cap on stored entries per scope before the oldest are evicted. */
export const DEFAULT_MAX_ENTRIES_PER_SCOPE = 200

/** Default idle delay before a finished session is mined for memories. */
export const DEFAULT_AUTO_EXTRACT_IDLE_MS = 300_000

/** Default number of surface messages handed to the extractor. */
export const DEFAULT_EXTRACT_WINDOW_MESSAGES = 30

/** Default character budget for the extraction transcript. */
export const DEFAULT_EXTRACT_MAX_INPUT_CHARS = 24_000

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

/**
 * The tunable settings section: one schema shared by the settings seam, the
 * GUI form, and the runtime. Every field carries its default, so an absent
 * `memories:` section in `settings.yaml` resolves to exactly the shipped
 * behaviour.
 */
export const MemoriesSettingsSchema = z.object({
  /** Byte budget for the injected summary. `0` disables injection. */
  maxSummaryBytes: z.number().default(DEFAULT_MAX_SUMMARY_BYTES).description('Byte budget for the memory summary injected into each turn. 0 disables injection and leaves only the memory tool.'),
  /** Max entries listed per scope in the injected summary. */
  maxSummaryEntries: z.number().default(DEFAULT_MAX_SUMMARY_ENTRIES).description('How many memories each scope lists in the injected summary.'),
  /** Max stored entries per scope; the least-recently-updated are evicted. */
  maxEntriesPerScope: z.number().default(DEFAULT_MAX_ENTRIES_PER_SCOPE).description('Stored memories per scope; past this cap the least recently used are deleted.'),
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
  /** Explicit extraction provider route; empty reuses the session route. */
  extractProvider: z.string().default('').description("Provider route for extraction. Empty reuses the session's own logged route."),
  /** Explicit extraction model; empty reuses the session route. */
  extractModel: z.string().default('').description("Model for extraction. Empty reuses the session's own logged route."),
  /** Whether the `memory` tool is registered for the model. */
  enableTool: z.boolean().default(true).description('Register the model-facing memory tool.'),
  /** Whether `/memories` is registered. */
  enableCommand: z.boolean().default(true).description('Register the /memories slash command.'),
})

/** The tunable section's value type, inferred from the settings schema. */
export type MemoriesSettings = Schemastery.TypeT<typeof MemoriesSettingsSchema>

/** The shipped tunables, used as the composition base and fallback. */
export const MEMORIES_SETTINGS_DEFAULTS: MemoriesSettings = {
  maxSummaryBytes: DEFAULT_MAX_SUMMARY_BYTES,
  maxSummaryEntries: DEFAULT_MAX_SUMMARY_ENTRIES,
  maxEntriesPerScope: DEFAULT_MAX_ENTRIES_PER_SCOPE,
  autoExtract: true,
  autoExtractIdleMs: DEFAULT_AUTO_EXTRACT_IDLE_MS,
  extractWindowMessages: DEFAULT_EXTRACT_WINDOW_MESSAGES,
  extractMaxInputChars: DEFAULT_EXTRACT_MAX_INPUT_CHARS,
  extractMaxOutputTokens: DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS,
  extractTimeoutMs: DEFAULT_EXTRACT_TIMEOUT_MS,
  extractMaxMemories: DEFAULT_EXTRACT_MAX_MEMORIES,
  minIdleHours: DEFAULT_MIN_IDLE_HOURS,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  maxSessionsPerPass: DEFAULT_MAX_SESSIONS_PER_PASS,
  consolidate: true,
  consolidateCooldownHours: DEFAULT_CONSOLIDATE_COOLDOWN_HOURS,
  consolidateMaxEntries: DEFAULT_CONSOLIDATE_MAX_ENTRIES,
  consolidateTimeoutMs: DEFAULT_CONSOLIDATE_TIMEOUT_MS,
  extractProvider: '',
  extractModel: '',
  enableTool: true,
  enableCommand: true,
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
  /** Deployment-layer tunable defaults, below the settings user layer. */
  defaults?: Partial<MemoriesSettings>
  /** Legacy flat spellings, accepted so an existing row keeps working. */
  maxSummaryBytes?: number
  maxSummaryEntries?: number
  maxEntriesPerScope?: number
  autoExtract?: boolean
  autoExtractIdleMs?: number
  extractWindowMessages?: number
  extractMaxInputChars?: number
  extractMaxOutputTokens?: number
  extractTimeoutMs?: number
  extractMaxMemories?: number
  extractProvider?: string
  extractModel?: string
  enableTool?: boolean
  enableCommand?: boolean
}

/** Fully resolved deployment configuration. */
export interface ResolvedConfig {
  readonly dshHome: string
  readonly memoriesDir: string
  readonly projectRootMarkers: readonly string[]
  /** Deployment-layer tunable defaults (below the settings user layer). */
  readonly defaults: MemoriesSettings
}

/** Clamp one tunable into a usable range. */
function positive(value: number | undefined, fallback: number, min = 1): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value < min ? min : Math.trunc(value)
}

/** Coerce one possibly-absent tunable set into a complete, clamped section. */
export function normalizeSettings(input: Partial<MemoriesSettings> | undefined): MemoriesSettings {
  const value = input ?? {}
  const provider = value.extractProvider?.trim() ?? ''
  const model = value.extractModel?.trim() ?? ''
  const route = provider.length > 0 && model.length > 0
    ? { extractProvider: provider, extractModel: model }
    : { extractProvider: '', extractModel: '' }
  return {
    maxSummaryBytes: positive(value.maxSummaryBytes, DEFAULT_MAX_SUMMARY_BYTES, 0),
    maxSummaryEntries: positive(value.maxSummaryEntries, DEFAULT_MAX_SUMMARY_ENTRIES),
    maxEntriesPerScope: positive(value.maxEntriesPerScope, DEFAULT_MAX_ENTRIES_PER_SCOPE),
    autoExtract: value.autoExtract ?? true,
    autoExtractIdleMs: positive(value.autoExtractIdleMs, DEFAULT_AUTO_EXTRACT_IDLE_MS, 1000),
    extractWindowMessages: positive(value.extractWindowMessages, DEFAULT_EXTRACT_WINDOW_MESSAGES),
    extractMaxInputChars: positive(value.extractMaxInputChars, DEFAULT_EXTRACT_MAX_INPUT_CHARS),
    extractMaxOutputTokens: positive(value.extractMaxOutputTokens, DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS),
    extractTimeoutMs: positive(value.extractTimeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS),
    extractMaxMemories: positive(value.extractMaxMemories, DEFAULT_EXTRACT_MAX_MEMORIES),
    minIdleHours: positive(value.minIdleHours, DEFAULT_MIN_IDLE_HOURS, 0),
    maxAgeDays: positive(value.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 0),
    maxSessionsPerPass: positive(value.maxSessionsPerPass, DEFAULT_MAX_SESSIONS_PER_PASS),
    consolidate: value.consolidate ?? true,
    consolidateCooldownHours: positive(value.consolidateCooldownHours, DEFAULT_CONSOLIDATE_COOLDOWN_HOURS, 0),
    consolidateMaxEntries: positive(value.consolidateMaxEntries, DEFAULT_CONSOLIDATE_MAX_ENTRIES),
    consolidateTimeoutMs: positive(value.consolidateTimeoutMs, DEFAULT_CONSOLIDATE_TIMEOUT_MS),
    ...route,
    enableTool: value.enableTool ?? true,
    enableCommand: value.enableCommand ?? true,
  }
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
    defaults: normalizeSettings({ ...legacy, ...config.defaults }),
  }
}
