/**
 * Deterministic retention: which memories no longer earn their place.
 *
 * This is the cheap half of maintenance. It costs no model call, so it can run
 * on a schedule instead of only when new material happens to arrive, and it is
 * the only thing in the plugin that ever retires a memory for being unused.
 *
 * The rule is deliberately one rule: a memory that has not been read, surfaced,
 * or written for `maxUnusedDays` is archived. Archived, not deleted — see
 * `MemoryStore.archive` — because a judgement made without a model's help must
 * be reversible.
 *
 * @module dsh-memories/retention
 */
import type { MemoryEntry, MemoryScope, RetentionRow } from './types.js'

/** Everything one retention pass needs. */
export interface RetentionOptions {
  /** Days an unused memory survives. `0` disables retention entirely. */
  readonly maxUnusedDays: number
  /** Clock, injected for deterministic tests. */
  readonly now: number
}

/** One entry selected for archival. */
export interface RetentionDecision {
  /** Owning scope. */
  readonly scope: MemoryScope
  /** Entry id. */
  readonly id: string
  /** Days since the entry was last read, surfaced, or written. */
  readonly ageDays: number
}

/** Key one entry or usage row the same way, so the two lists can be joined. */
export function retentionKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`
}

/**
 * The moment an entry last earned attention.
 *
 * Deliberately not `updatedAt` alone: consolidation rewrites entries without
 * anyone using them, and counting that as attention would let a memory be
 * rewritten every sweep and never expire. Reading and being surfaced are the
 * signals that count, and the state database is the authority for both, because
 * a concurrent session may hold a newer counter than the entry file does.
 *
 * @param entry - the entry file's view.
 * @param row - the state database's view, when one exists.
 * @returns Unix epoch milliseconds.
 */
export function lastAttention(entry: MemoryEntry, row: RetentionRow | undefined): number {
  return Math.max(
    entry.createdAt,
    entry.lastUsedAt,
    entry.lastSurfacedAt,
    row?.lastUsedAt ?? 0,
    row?.surfacedAt ?? 0,
  )
}

/**
 * Choose the entries to archive.
 *
 * A `user`-sourced entry is never chosen: somebody typed it, and a schedule is
 * not entitled to overrule a person. Everything else is judged purely by age,
 * so the outcome is explainable — "unused for N days" — rather than a score
 * nobody can reconstruct.
 *
 * @param entries - every entry in one scope.
 * @param rows - usage rows from the state database.
 * @param options - the age limit and the clock.
 * @returns the entries to archive, longest-unused first.
 */
export function planRetention(entries: readonly MemoryEntry[], rows: readonly RetentionRow[], options: RetentionOptions): RetentionDecision[] {
  if (options.maxUnusedDays <= 0) return []
  const usage = new Map(rows.map((row) => [retentionKey(row.scope, row.id), row]))
  const limitMs = options.maxUnusedDays * 86_400_000
  const decisions: RetentionDecision[] = []
  for (const entry of entries) {
    if (entry.source === 'user') continue
    const attention = lastAttention(entry, usage.get(retentionKey(entry.scope, entry.id)))
    const ageMs = options.now - attention
    if (ageMs <= limitMs) continue
    decisions.push({ scope: entry.scope, id: entry.id, ageDays: ageMs / 86_400_000 })
  }
  return decisions.sort((left, right) => right.ageDays - left.ageDays || left.id.localeCompare(right.id))
}
