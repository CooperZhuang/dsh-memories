/**
 * Shared memory vocabulary for `dsh-memories`.
 *
 * Two scopes exist, mirroring the Codex memories split:
 * `global` remembers facts that hold across every project (how the user likes to
 * work, durable preferences, machine/tooling facts), while `project` remembers
 * facts tied to one workspace (architecture decisions, build commands, gotchas)
 * and is shared by every session opened in that workspace.
 *
 * @module dsh-memories/types
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** A memory scope: cross-project (`global`) or workspace-bound (`project`). */
export type MemoryScope = 'global' | 'project'

/**
 * Who produced the content this plugin injects into a conversation.
 *
 * `MessageSource.kind` answers *who*, and durable session format v4 admits only
 * a producer-owned kind: the retired `{ kind: 'plugin', plugin: … }` wrapper is
 * refused outright on write (`format v4 message requires a producer-owned
 * source kind`), which is what made every injection fail on 0.1.7. The platform's
 * own v3→v4 migration derives exactly this spelling from that wrapper, so older
 * logs and new writes carry the same kind — which is what lets a session resumed
 * from an older log still recognise the block it already has.
 *
 * Spelled out rather than derived from the plugin name because the name lives in
 * the plugin entry, which imports this module; a test holds the two together.
 */
export const MEMORY_SOURCE_KIND = 'plugin:memories'

/** Every valid scope, in injection order (broadest first). */
export const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'project']

/**
 * One durable memory entry.
 *
 * `id` is stable and derived from the title, so re-writing the same lesson
 * updates the existing entry instead of growing the store.
 */
export interface MemoryEntry {
  /** Stable slug id, unique within its scope directory. */
  readonly id: string
  /** Owning scope. */
  readonly scope: MemoryScope
  /** What kind of thing this memory is; drives summary grouping and recall order. */
  readonly kind: MemoryKind
  /** Short imperative heading shown in the injected summary. */
  readonly title: string
  /** The remembered fact, 1-4 sentences. */
  readonly body: string
  /** Lowercase keyword tags used by search ranking. */
  readonly tags: readonly string[]
  /**
   * Extra search keys: aliases and keyphrases that should also find this
   * memory.
   *
   * This is the cheap half of what the literature calls key expansion — a
   * memory about "pnpm workspaces" should be found by "monorepo" too — and it
   * buys most of the recall a vector index would, without an index.
   */
  readonly keys: readonly string[]
  /** When this memory is worth recalling, in the author's words. */
  readonly appliesTo?: string
  /**
   * How long the memory stays true.
   *
   * `durable` (the default) is a fact that does not move: a convention, a
   * command, a design constraint. `snapshot` is a reading taken at one moment —
   * a count, a pass rate, a state of the world — and is rendered with the date it
   * was taken and archived once it is old enough, because a stale number is worse
   * than no number: measured on a real store, 43% of entries carried one.
   */
  readonly durability?: MemoryDurability
  /** When a `snapshot` was measured; ignored for `durable`. */
  readonly asOf?: number
  /**
   * Keep this memory in the injected summary whenever it fits.
   *
   * The summary lists a handful of entries out of hundreds, so which ones appear
   * is normally the ranking's decision. A pin is the user's decision instead: it
   * is chosen before the fresh slots and before the ranking. Pins compete with
   * each other only, so a scope cannot be flooded by them.
   */
  readonly pinned?: boolean
  /** Id of the memory this one replaces, when it supersedes one. */
  readonly supersedes?: string
  /**
   * Session this memory was learned in.
   *
   * The evidence behind a memory: `memories/sessions/<id>.md` records what that
   * conversation was about, which is what a reader needs when a memory's wording
   * or chronology could change the answer. Codex keeps the same pointer as a
   * rollout summary its read path can open.
   */
  readonly sourceSession?: string
  /** Unix epoch milliseconds when the entry was first written. */
  readonly createdAt: number
  /** Unix epoch milliseconds of the most recent write. */
  readonly updatedAt: number
  /** How many times the entry was read or returned by search. */
  readonly uses: number
  /** Unix epoch milliseconds of the last read/search hit, or 0 when never used. */
  readonly lastUsedAt: number
  /** Unix epoch milliseconds the entry was last listed in an injected block, or 0. */
  readonly lastSurfacedAt: number
  /** How the entry entered the store. */
  readonly source: MemorySource
}

/**
 * What kind of memory one entry is.
 *
 * The split follows Codex's `MEMORY.md` sections, which exist because the four
 * kinds are recalled differently: a preference applies whenever the situation
 * matches, a failure applies when the same mistake is about to be repeated, a
 * procedure is executed, and a plain fact is just background. Grouping them in
 * the injected summary lets the model see the actionable ones first.
 */
export type MemoryKind =
  /** Durable background: how something works, what a system contains. */
  | 'fact'
  /** How the user wants work done, or a correction they issued. */
  | 'preference'
  /** A non-obvious technique worth reusing. */
  | 'knowledge'
  /** Something that went wrong and how to avoid repeating it. */
  | 'failure'
  /** An ordered recipe for a recurring task. */
  | 'procedure'

/** Every kind, in summary render order (actionable first). */
export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'failure', 'procedure', 'knowledge', 'fact']

/**
 * How long a memory stays true.
 *
 * The distinction exists because a number that was correct when written is the
 * most dangerous kind of memory: it is specific, it is checkable, and it goes
 * wrong on its own. A `snapshot` therefore carries the date it was measured and
 * expires, instead of being repeated forever as though it were a rule.
 */
export type MemoryDurability =
  /** A fact that does not move: a convention, a command, a constraint. */
  | 'durable'
  /** A reading taken at one moment: a count, a pass rate, a current state. */
  | 'snapshot'

/** Every durability value, for validation at the storage seam. */
export const MEMORY_DURABILITIES: readonly MemoryDurability[] = ['durable', 'snapshot']

/**
 * Normalize a raw durability value.
 *
 * An absent value is `durable`, so every memory written before this field
 * existed keeps its old meaning without a migration.
 *
 * @param value - the raw text, or `undefined`.
 * @returns the durability.
 */
export function toMemoryDurability(value: string | undefined): MemoryDurability {
  return value === 'snapshot' ? 'snapshot' : 'durable'
}

/** Heading text for each kind in the injected summary. */
export const MEMORY_KIND_HEADINGS: Record<MemoryKind, string> = {
  preference: 'Preferences',
  failure: 'Failures to avoid',
  procedure: 'Procedures',
  knowledge: 'Reusable knowledge',
  fact: 'Facts',
}

/** Narrow an unknown value to a kind, defaulting to `fact`. */
export function toMemoryKind(value: unknown): MemoryKind {
  return value === 'preference' || value === 'failure' || value === 'procedure' || value === 'knowledge'
    ? value
    : 'fact'
}

/** Provenance of one entry. */
export type MemorySource =
  /** Written by the model through the `memory` tool. */
  | 'tool'
  /** Written by the user through a `/memories` command. */
  | 'user'
  /** Produced by the idle-time background extractor. */
  | 'auto'
  /** Written by the plugin itself (e.g. a scope migration). */
  | 'system'

/** One scope plus the resolved store directories for it. */
export interface ScopeTarget {
  /** The scope this target addresses. */
  readonly scope: MemoryScope
  /** Absolute directory holding this scope's entry files and `index.json`. */
  readonly dir: string
  /** Model-facing label for the scope, e.g. `global` or `project:dsh-memories`. */
  readonly label: string
}

/** A candidate memory as proposed by the model or the extractor, before persistence. */
export interface MemoryDraft {
  /** Target scope. */
  readonly scope: MemoryScope
  /** Short imperative heading. */
  readonly title: string
  /** The remembered fact. */
  readonly body: string
  /** Optional keyword tags. */
  readonly tags: readonly string[]
  /** What kind of memory this is; defaults to `fact`. */
  readonly kind?: MemoryKind
  /** When this memory is worth recalling. */
  readonly appliesTo?: string
  /** How long the memory stays true; see {@link MemoryEntry.durability}. */
  readonly durability?: MemoryDurability
  /** When a `snapshot` was measured. */
  readonly asOf?: number
  /** Whether the injected summary must list this memory whenever it fits. */
  readonly pinned?: boolean
  /** Id of a memory this one replaces. */
  readonly supersedes?: string
  /** Session the draft came from, recorded as {@link MemoryEntry.sourceSession}. */
  readonly sourceSession?: string
  /** Extra search keys (aliases, keyphrases) that should also find this memory. */
  readonly keys?: readonly string[]
}

/** The outcome of persisting one draft. */
export interface UpsertResult {
  /** The stored entry. */
  readonly entry: MemoryEntry
  /** `created` for a new entry, `updated` when an existing id was replaced. */
  readonly action: 'created' | 'updated'
}

/**
 * Per-session memory switch.
 *
 * `off` suspends injection and extraction for one session without touching the
 * workspace it runs in: a repository full of credentials can be worked in
 * without turning memory off everywhere.
 */
export type SessionMode = 'on' | 'off'

/**
 * What one memory's usage says about whether it still earns its place.
 *
 * These counters live in the state database rather than in the entry file,
 * because every session in the process updates them concurrently; `surfacedAt`
 * is the weaker signal that keeps a memory good enough to be read straight out
 * of the injected summary from looking unused.
 */
export interface RetentionRow {
  /** Owning scope. */
  readonly scope: string
  /** Entry id within that scope. */
  readonly id: string
  /** How many times the entry was read or returned by search. */
  readonly uses: number
  /** Unix epoch milliseconds of the last read/search hit, or 0. */
  readonly lastUsedAt: number
  /** Unix epoch milliseconds the entry was last listed in an injected block, or 0. */
  readonly surfacedAt: number
  /** Unix epoch milliseconds a consolidation pass last reviewed it, or 0. */
  readonly consolidatedAt: number
}

/** One ranked search hit. */
export interface MemoryHit {
  /** The matching entry. */
  readonly entry: MemoryEntry
  /** Relevance score; higher is better. */
  readonly score: number
}

/** The source this plugin stamps on every message it injects. */
export type MemoryMessageSource = { kind: typeof MEMORY_SOURCE_KIND } & ContextFormed

/**
 * Add this plugin's producer kind to the shared source vocabulary.
 *
 * The augmentation names `@deepseek-ai/dsh-llm/message` — the module that
 * declares the map — rather than the package root, which only re-exports it: a
 * re-export carries the type but not the merge point.
 */
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** Injected memory context: the summary block or an on-demand recall delta. */
    memories: MemoryMessageSource
  }
}
