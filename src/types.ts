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

/** A memory scope: cross-project (`global`) or workspace-bound (`project`). */
export type MemoryScope = 'global' | 'project'

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
