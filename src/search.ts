/**
 * Lexical search over stored memories.
 *
 * Deliberately dependency-free and deterministic: tokens are matched
 * case-insensitively against title, body, and tags, with weights that put a
 * title hit above a body hit. `all` filters by tag or scope without a query.
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
 * Score one entry against a query. Exact substring hits in the title dominate;
 * per-token hits in title, tags, and body follow.
 * @param entry - candidate entry.
 * @param query - raw user/model query.
 * @param now - clock used for the recency tie-break.
 * @returns a non-negative score; `0` means no match.
 */
export function scoreEntry(entry: MemoryEntry, query: string, now = Date.now()): number {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return 0
  const title = entry.title.toLowerCase()
  const body = entry.body.toLowerCase()
  const tags = entry.tags.join(' ')
  let score = 0
  if (title.includes(normalized)) score += 40
  if (body.includes(normalized)) score += 12
  if (tags.includes(normalized)) score += 20
  for (const token of tokenize(normalized)) {
    if (isNoise(token)) continue
    if (title.includes(token)) score += 8 + occurrences(title, token)
    if (tags.includes(token)) score += 6
    score += Math.min(4, occurrences(body, token)) * 2
  }
  if (score === 0) return 0
  const ageDays = Math.max(0, (now - entry.updatedAt) / 86_400_000)
  return score + Math.max(0, 4 - ageDays / 30)
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
