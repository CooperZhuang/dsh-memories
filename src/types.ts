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
  /** Short imperative heading shown in the injected summary. */
  readonly title: string
  /** The remembered fact, 1-4 sentences. */
  readonly body: string
  /** Lowercase keyword tags used by search ranking. */
  readonly tags: readonly string[]
  /** Unix epoch milliseconds when the entry was first written. */
  readonly createdAt: number
  /** Unix epoch milliseconds of the most recent write. */
  readonly updatedAt: number
  /** How many times the entry was read or returned by search. */
  readonly uses: number
  /** Unix epoch milliseconds of the last read/search hit, or 0 when never used. */
  readonly lastUsedAt: number
  /** How the entry entered the store. */
  readonly source: MemorySource
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
}

/** The outcome of persisting one draft. */
export interface UpsertResult {
  /** The stored entry. */
  readonly entry: MemoryEntry
  /** `created` for a new entry, `updated` when an existing id was replaced. */
  readonly action: 'created' | 'updated'
}

/** One ranked search hit. */
export interface MemoryHit {
  /** The matching entry. */
  readonly entry: MemoryEntry
  /** Relevance score; higher is better. */
  readonly score: number
}
