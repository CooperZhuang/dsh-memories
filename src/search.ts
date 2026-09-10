/**
 * Lexical search over stored memories.
 *
 * Deliberately dependency-free and deterministic: one score ranks everything —
 * lexical relevance, the entry's track record, and how recently it was
 * touched — so tool search, the injected summary, and on-demand recall all
 * agree on what is worth recalling.
 *
 * @module dsh-memories/search
 */
import type { MemoryEntry, MemoryHit, MemoryKind, MemoryScope } from './types.js'

/** Split text into lowercase tokens, keeping CJK runs intact. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
}

/** A short token carries little signal and is skipped as a query term. */
function isNoise(token: string): boolean {
  return token.length < 2 && !/[\u4e00-\u9fff]/u.test(token)
}

/** Count occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Lexical relevance: exact and per-token hits in the title, keys, tags, and
 * body, weighted so a title hit dominates a body hit.
 * @param entry - candidate entry.
 * @param query - raw user/model query.
 * @returns a non-negative relevance score; `0` means no match.
 */
export function relevanceOf(entry: MemoryEntry, query: string): number {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return 0
  const title = entry.title.toLowerCase()
  const body = entry.body.toLowerCase()
  const tags = entry.tags.join(' ')
  const keys = entry.keys.join(' ')
  let score = 0
  if (title.includes(normalized)) score += 40
  if (keys.includes(normalized)) score += 26
  if (tags.includes(normalized)) score += 20
  if (body.includes(normalized)) score += 12
  for (const token of tokenize(normalized)) {
    if (isNoise(token)) continue
    if (title.includes(token)) score += 8 + occurrences(title, token)
    if (keys.includes(token)) score += 7
    if (tags.includes(token)) score += 6
    score += Math.min(4, occurrences(body, token)) * 2
  }
  return score
}

/**
 * Half-life of a memory's recency weight, in days.
 *
 * Deliberately long: this is durable memory, and a project convention from last
 * quarter is usually still true. Recency orders equally relevant memories; it
 * does not decide by itself whether an old one is worth showing at all.
 */
export const RECENCY_HALF_LIFE_DAYS = 90

/**
 * Floor on the recency weight.
 *
 * Without it a two-year-old memory scores essentially zero and can never
 * outrank a fresh, weaker match, however exact its own — the opposite of what
 * durable memory is for.
 */
export const DECAY_FLOOR = 0.25

/** The most recent moment an entry was read, surfaced, or rewritten. */
export function recencyOf(entry: MemoryEntry): number {
  return Math.max(entry.updatedAt, entry.lastUsedAt, entry.lastSurfacedAt)
}

/**
 * How fast an entry's recency weight decays.
 *
 * A memory not read, surfaced, or rewritten for a quarter is worth half as much
 * as one touched today, and the weight never falls below {@link DECAY_FLOOR}:
 * recency orders memories, it does not erase them.
 * @param entry - candidate entry.
 * @param now - injected clock.
 * @returns a weight in `[DECAY_FLOOR, 1]`.
 */
export function decayOf(entry: MemoryEntry, now = Date.now()): number {
  const ageDays = Math.max(0, (now - recencyOf(entry)) / 86_400_000)
  return Math.max(DECAY_FLOOR, 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS))
}

/** How much an entry has earned its place: a small bonus per recorded use. */
export function importanceOf(entry: MemoryEntry): number {
  return 1 + Math.min(entry.uses, 10) * 0.35
}

/**
 * Score one entry against a query: relevance × importance × recency decay.
 *
 * One formula for every ordering in the plugin — tool search, the injected
 * summary, and the on-demand recall threshold — so "worth recalling" means the
 * same thing everywhere and a knob tuned in one place holds in the others.
 * @param entry - candidate entry.
 * @param query - raw user/model query.
 * @param now - clock used for the decay.
 * @returns a non-negative score; `0` means the entry does not match.
 */
export function scoreEntry(entry: MemoryEntry, query: string, now = Date.now()): number {
  const relevance = relevanceOf(entry, query)
  if (relevance === 0) return 0
  return relevance * importanceOf(entry) * decayOf(entry, now)
}

/** Filter options accepted by {@link searchMemories}. */
export interface SearchOptions {
  /** Only consider these scopes. */
  readonly scopes?: readonly MemoryScope[]
  /** Only consider entries carrying every one of these tags. */
  readonly tags?: readonly string[]
  /** Only consider entries of these kinds. */
  readonly kinds?: readonly MemoryKind[]
  /** Maximum hits returned. */
  readonly limit?: number
  /** Clock used for the recency tie-break; injected for deterministic tests. */
  readonly now?: number
}

/** One scope's entries plus the label to report them under. */
export interface ScopeEntries {
  /** The scope these entries came from. */
  readonly scope: MemoryScope
  /** Model-facing scope label, e.g. `global` or `project:dsh-memories`. */
  readonly label: string
  /** The entries. */
  readonly entries: readonly MemoryEntry[]
}

/**
 * Rank stored entries against a query across the supplied scopes.
 * @param groups - per-scope entry lists, broadest first.
 * @param query - raw query; empty returns nothing.
 * @param options - scope, tag, and limit filters.
 * @returns hits ordered by descending score.
 */
export function searchMemories(
  groups: readonly ScopeEntries[],
  query: string,
  options: SearchOptions = {},
): MemoryHit[] {
  const limit = options.limit ?? 10
  const wantedScopes = options.scopes
  const wantedTags = (options.tags ?? []).map((tag) => tag.toLowerCase())
  const wantedKinds = options.kinds
  const now = options.now ?? Date.now()
  const hits: MemoryHit[] = []
  for (const group of groups) {
    if (wantedScopes !== undefined && !wantedScopes.includes(group.scope)) continue
    for (const entry of group.entries) {
      if (wantedKinds !== undefined && !wantedKinds.includes(entry.kind)) continue
      if (wantedTags.length > 0 && !wantedTags.every((tag) => entry.tags.includes(tag))) continue
      const score = scoreEntry(entry, query, now)
      if (score <= 0) continue
      hits.push({ entry, score })
    }
  }
  hits.sort((left, right) => right.score - left.score
    || right.entry.updatedAt - left.entry.updatedAt
    || left.entry.title.localeCompare(right.entry.title))
  return hits.slice(0, limit)
}

/**
 * Select entries without a text query — used by `memory_search`'s browse mode
 * and by the injector.
 * @param groups - per-scope entry lists, broadest first.
 * @param options - scope, tag, and limit filters.
 * @returns entries ordered by descending update time.
 */
export function browseMemories(
  groups: readonly ScopeEntries[],
  options: SearchOptions = {},
): MemoryHit[] {
  const limit = options.limit ?? 10
  const wantedScopes = options.scopes
  const wantedTags = (options.tags ?? []).map((tag) => tag.toLowerCase())
  const wantedKinds = options.kinds
  const hits: MemoryHit[] = []
  for (const group of groups) {
    if (wantedScopes !== undefined && !wantedScopes.includes(group.scope)) continue
    for (const entry of group.entries) {
      if (wantedKinds !== undefined && !wantedKinds.includes(entry.kind)) continue
      if (wantedTags.length > 0 && !wantedTags.every((tag) => entry.tags.includes(tag))) continue
      hits.push({ entry, score: 0 })
    }
  }
  hits.sort((left, right) => right.entry.updatedAt - left.entry.updatedAt
    || left.entry.title.localeCompare(right.entry.title))
  return hits.slice(0, limit)
}
