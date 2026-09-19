/**
 * Lexical search over stored memories.
 *
 * Deliberately dependency-free and deterministic: one score ranks everything —
 * lexical relevance, the entry's track record, and how recently it was
 * touched — so tool search, the injected summary, and on-demand recall all
 * agree on what is worth recalling.
 *
 * Chinese is a first-class case here, not a fallback. A query with no spaces
 * ("该插件是否有日志") tokenizes to one indivisible run under any whitespace
 * splitter, so a whole-run substring test is the only thing that could match —
 * and a memory almost never contains a whole question verbatim. Every
 * comparison therefore runs over CJK character bigrams as well, which is what
 * makes "日志" find a memory titled "…的日志在哪里" without a model call.
 *
 * @module dsh-memories/search
 */
import type { MemoryEntry, MemoryHit, MemoryKind, MemoryScope } from './types.js'
import { queryMessages } from './query.js'

/** A CJK ideograph, including the extension blocks in common use. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
/** A CJK character inside a query or a memory field. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
/** A maximal run of CJK characters. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu
/** Shortest shared CJK run that counts as strong evidence. */
const MIN_SHARED_RUN = 3
/** Lowercase Latin, digits, and underscore — the "word" case. */
const WORD = /[a-z0-9_]+/gu

/** Score added when the whole query appears verbatim in one field. */
export const FIELD_WEIGHTS = {
  title: 40,
  keys: 26,
  tags: 20,
  appliesTo: 18,
  body: 12,
} as const

/**
 * Score added per query term that appears in one field.
 *
 * Much smaller than {@link FIELD_WEIGHTS} because a term is one signal among
 * many; the whole-query match is the strong claim. `body` is capped per term so
 * a long memory that happens to repeat a word cannot dominate.
 */
export const TERM_WEIGHTS = {
  title: 8,
  keys: 7,
  tags: 6,
  appliesTo: 5,
  body: 2,
} as const

/**
 * How much evidence one entry has for one query.
 *
 * `strongTerms` is not a sum over bigrams, because a Chinese query and a Chinese
 * memory share a *run*, not a bag of pairs: "插件日志" enters the scorer as the
 * overlapping pair 插件/件日/日志, so counting pairs would score one real phrase
 * as three, while two independently common pairs would also score two. Counting
 * substantive units instead — a shared CJK run of at least three characters, or
 * a Latin word of at least three characters — is what makes "两个信号" mean two
 * pieces of evidence rather than two accidental character overlaps.
 */
export interface MatchEvidence {
  /**
   * Distinct query terms shared with the title, keys, tags, or `appliesTo` that
   * count as real evidence:
   *
   * - a Latin word of three characters or more (`dsh`, `pnpm`, `3080`), or
   * - a CJK bigram sitting inside a shared run of at least three characters.
   *
   * The run requirement is the whole design. A pair of CJK characters is the
   * unit that makes Chinese retrievable at all — without it a space-free turn is
   * one indivisible token — but it is also the unit that makes Chinese noisy:
   * measured on a real 54-memory store, "该插件是否有日志" shares the isolated
   * pair 插件 with a memory about an unrelated cost-meter bug and scores 12,
   * above any floor low enough to admit a paraphrase. Requiring the pair to sit
   * inside a shared run of three characters means the query and the memory must
   * use the same *phrase* (插件日志), not merely the same characters.
   */
  readonly strongTerms: number
  /** True when the whole query appears in a strong field. */
  readonly phrase: boolean
}

/** Most body occurrences of one term that still earn score. */
export const BODY_TERM_CAP = 4

/**
 * Every CJK run of a query, longest first.
 *
 * Runs are the right unit for evidence because a run is what a bigram list
 * loses: "插件日志" enters the scorer as the overlapping pair 插件/件日/日志, so a
 * shared *run* is invisible to per-term counting, while a shared common pair
 * looks like two independent hits.
 *
 * @param text - the lowercased query.
 * @returns each maximal CJK run.
 */
function cjkRuns(text: string): string[] {
  return text.match(CJK_RUN) ?? []
}

/**
 * The windows of the query's CJK runs that one field contains.
 *
 * Every window of at least `minimum` characters that the field also contains is
 * returned, so the caller can ask whether a *particular* bigram is backed by a
 * run rather than by an isolated pair. Adjacent windows overlap, and the set
 * collapses them.
 *
 * @param queryRuns - the query's CJK runs.
 * @param field - the lowercased field text.
 * @param minimum - shortest shared run that counts.
 * @returns the shared windows, as a set of substrings.
 */
function sharedRuns(queryRuns: readonly string[], field: string, minimum: number): Set<string> {
  const shared = new Set<string>()
  if (field.length === 0) return shared
  for (const run of queryRuns) {
    for (let start = 0; start + minimum <= run.length; start += 1) {
      for (let end = start + minimum; end <= run.length; end += 1) {
        const window = run.slice(start, end)
        if (field.includes(window)) shared.add(window)
      }
    }
  }
  return shared
}

/** Split text into searchable terms: ASCII words and CJK character bigrams.
 *
 * A CJK run also contributes bigrams of its neighbours, so "该插件是否有日志"
 * yields "该插","插件","件是","是否","否有","有日","日志". A one-character run
 * contributes itself, since a lone ideograph has no bigram.
 *
 * @param text - raw text.
 * @returns lowercase terms; a run that yields nothing contributes nothing.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const terms: string[] = []
  for (const word of lower.match(WORD) ?? []) terms.push(word)
  const chars = lower.match(CJK_CHAR) ?? []
  if (chars.length === 1) terms.push(chars[0] as string)
  for (let index = 0; index + 1 < chars.length; index += 1) {
    terms.push(`${chars[index]}${chars[index + 1]}`)
  }
  return terms
}

/**
 * A term's weight for scoring purposes.
 *
 * One CJK bigram is a much weaker claim than one Latin word — "日志" occurs in
 * countless texts where "logging" does not — so a bigram earns less. Without
 * this every Chinese question would clear the recall gate on noise alone.
 *
 * @param term - one term from {@link tokenize}.
 * @returns a multiplier in `(0, 1]`.
 */
export function termWeight(term: string): number {
  const cjk = (term.match(CJK_CHAR) ?? []).length
  if (cjk === 0) return 1
  // Two-character bigram: half credit. A longer CJK term cannot occur (the
  // tokenizer emits bigrams), but treat it as stronger if it ever does.
  return cjk <= 2 ? 0.5 : Math.min(1, 0.5 + (cjk - 2) * 0.15)
}

/** A short token carries little signal and is skipped as a query term. */
function isNoise(token: string): boolean {
  if (CJK.test(token)) return false
  return token.length < 2
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

/** One entry's searchable fields, lowercased once per comparison. */
interface Searchable {
  readonly title: string
  readonly body: string
  readonly keys: string
  readonly tags: string
  readonly appliesTo: string
  /** Latin words present in each field, for whole-word matching. */
  readonly titleWords: ReadonlySet<string>
  readonly bodyWords: ReadonlySet<string>
  readonly keyWords: ReadonlySet<string>
  readonly tagWords: ReadonlySet<string>
  readonly appliesWords: ReadonlySet<string>
}

/** Words of one field, for exact-token tests. */
function words(field: string): Set<string> {
  return new Set(field.match(WORD) ?? [])
}

/** Lowercase one entry's fields once. */
function searchable(entry: MemoryEntry): Searchable {
  const title = entry.title.toLowerCase()
  const body = entry.body.toLowerCase()
  const keys = entry.keys.join(' ').toLowerCase()
  const tags = entry.tags.join(' ').toLowerCase()
  const appliesTo = (entry.appliesTo ?? '').toLowerCase()
  return {
    title,
    body,
    keys,
    tags,
    appliesTo,
    titleWords: words(title),
    bodyWords: words(body),
    keyWords: words(keys),
    tagWords: words(tags),
    appliesWords: words(appliesTo),
  }
}

/**
 * Whether one term matches one field.
 *
 * Latin terms are matched as whole words: "log" must not match "logging" or
 * "login", or every memory mentioning a login screen would answer a question
 * about logging. CJK has no such boundaries — a bigram inside a longer run is
 * a real morphological hit — so those stay substring tests.
 *
 * @param field - the lowercased field text.
 * @param fieldWords - the field's Latin words.
 * @param term - one query term.
 * @returns true when the field contains the term.
 */
function matches(field: string, fieldWords: ReadonlySet<string>, term: string): boolean {
  if (CJK.test(term)) return field.includes(term)
  return fieldWords.has(term)
}

/**
 * Score one entry against one already-extracted query string, with evidence.
 *
 * Exact and per-term hits are counted in the title, keys, tags, `appliesTo`,
 * and body, weighted so a title hit dominates a body hit. `appliesTo` is
 * included because it is the field that says *when* a memory matters — the
 * single most useful signal for a conversational turn that shares no noun with
 * the memory's title.
 *
 * @param entry - candidate entry.
 * @param normalized - one lowercased, trimmed query string.
 * @returns the score and the evidence behind it.
 */
function matchOne(entry: MemoryEntry, normalized: string): { score: number; evidence: MatchEvidence } {
  const fields = searchable(entry)
  let score = 0
  // The whole query as a phrase. CJK quirk: `tags`/`keys` hold several values in
  // one string, and Japanese/Chinese text has no word boundaries, so a phrase
  // test is meaningful there; for Latin fields it means the query is a phrase
  // in that field, which is exactly the strong signal it should be.
  let phrase = false
  if (matches(fields.title, fields.titleWords, normalized)) {
    score += FIELD_WEIGHTS.title
    phrase = true
  }
  if (matches(fields.keys, fields.keyWords, normalized)) {
    score += FIELD_WEIGHTS.keys
    phrase = true
  }
  if (matches(fields.tags, fields.tagWords, normalized)) {
    score += FIELD_WEIGHTS.tags
    phrase = true
  }
  if (matches(fields.appliesTo, fields.appliesWords, normalized)) {
    score += FIELD_WEIGHTS.appliesTo
    phrase = true
  }
  if (matches(fields.body, fields.bodyWords, normalized)) score += FIELD_WEIGHTS.body
  const strong = new Set<string>()
  // Only the strong fields feed the evidence count: a term in the BODY is
  // deliberately excluded, because a long memory mentions many things and a body
  // word is the weakest claim available.
  const queryRuns = cjkRuns(normalized)
  const cjkBacked = new Set<string>()
  for (const field of [fields.title, fields.keys, fields.tags, fields.appliesTo]) {
    for (const run of sharedRuns(queryRuns, field, MIN_SHARED_RUN)) {
      // Every bigram of a shared run is marked, so a query sharing 插件日志的
      // counts 插件, 插件日, and 日志 rather than one anonymous run.
      for (let index = 0; index + 2 <= run.length; index += 1) cjkBacked.add(run.slice(index, index + 2))
    }
  }
  for (const term of tokenize(normalized)) {
    if (isNoise(term)) continue
    const weight = termWeight(term)
    let strongHit = false
    if (matches(fields.title, fields.titleWords, term)) {
      score += (TERM_WEIGHTS.title + (CJK.test(term) ? 0 : occurrences(fields.title, term))) * weight
      strongHit = true
    }
    if (matches(fields.keys, fields.keyWords, term)) {
      score += TERM_WEIGHTS.keys * weight
      strongHit = true
    }
    if (matches(fields.tags, fields.tagWords, term)) {
      score += TERM_WEIGHTS.tags * weight
      strongHit = true
    }
    if (matches(fields.appliesTo, fields.appliesWords, term)) {
      score += TERM_WEIGHTS.appliesTo * weight
      strongHit = true
    }
    if (strongHit) {
      if (CJK.test(term)) {
        if (cjkBacked.has(term)) strong.add(term)
      } else if (term.length >= 3) {
        strong.add(term)
      }
    }
    score += Math.min(BODY_TERM_CAP, occurrences(fields.body, term)) * TERM_WEIGHTS.body * weight
  }
  return { score, evidence: { strongTerms: strong.size, phrase } }
}

/**
 * Score and evidence of one entry against one already-extracted query.
 *
 * Prefer this over {@link relevanceOfOne} when the caller has to *justify* a
 * decision: a recall delta is bounded by evidence, not only by score.
 *
 * @param entry - candidate entry.
 * @param query - one query string; empty scores zero.
 * @returns the score and the evidence behind it.
 */
export function matchOf(entry: MemoryEntry, query: string): { score: number; evidence: MatchEvidence } {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return { score: 0, evidence: { strongTerms: 0, phrase: false } }
  return matchOne(entry, normalized)
}

/**
 * Relevance of one entry to one already-extracted query string.
 *
 * @param entry - candidate entry.
 * @param query - one query string; empty scores zero.
 * @returns a non-negative score; `0` means no match.
 */
export function relevanceOfOne(entry: MemoryEntry, query: string): number {
  return matchOf(entry, query).score
}

/** The best sentence-level match for one entry, with its evidence. */
interface TurnMatch {
  readonly relevance: number
  readonly evidence: MatchEvidence
  readonly best: string
}

/** Score every candidate query of a turn and keep the strongest. */
function bestMatch(entry: MemoryEntry, query: string): TurnMatch {
  const messages = queryMessages(query)
  let bestScore = 0
  let bestEvidence: MatchEvidence = { strongTerms: 0, phrase: false }
  let best = ''
  let mentions = 0
  for (const message of messages) {
    const { score, evidence } = matchOne(entry, message)
    if (score > 0) mentions += 1
    if (score > bestScore || (score === bestScore && evidence.strongTerms > bestEvidence.strongTerms)) {
      bestScore = score
      bestEvidence = evidence
      best = message
    }
  }
  if (bestScore === 0) return { relevance: 0, evidence: bestEvidence, best: '' }
  // Two independent mentions: +15%, capped so it reorders near-ties only.
  const relevance = bestScore * Math.min(1.15, 1 + (mentions - 1) * 0.15)
  return { relevance, evidence: bestEvidence, best }
}

/**
 * Relevance of one entry to a whole user turn.
 *
 * A turn is many sentences and only one of them is usually about any single
 * memory, so scoring the turn as one string buries a precise hit inside a wall
 * of unrelated words. Each sentence is scored on its own and the best one wins;
 * an entry that several sentences mention earns a small bonus, because two
 * independent mentions is stronger evidence than one.
 *
 * @param entry - candidate entry.
 * @param query - the raw turn or search text.
 * @returns a non-negative score; `0` means no match.
 */
export function relevanceOf(entry: MemoryEntry, query: string): number {
  return bestMatch(entry, query).relevance
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

/**
 * The most recent moment an entry was written or actually read.
 *
 * Being *surfaced* is deliberately not part of this. The summary lists a bounded
 * number of entries, and counting "listed in the summary" as fresh attention
 * turns that bound into a lock: an entry that makes the cut refreshes its own
 * recency on every injection and keeps every newcomer out. Measured on a real
 * store, the injected set sat at exactly the 12-per-scope cap, every member at
 * maximum recency, while two thirds of the store had never been read at all —
 * including the entry that explicitly corrected one of the listed ones.
 *
 * Surfacing still counts where the question is "does this memory still earn its
 * place on disk"; that rule is `lastAttention` in `retention.ts`, which is the
 * only thing that ever archives a memory.
 *
 * @param entry - candidate entry.
 * @returns Unix epoch milliseconds.
 */
export function recencyOf(entry: MemoryEntry): number {
  return Math.max(entry.updatedAt, entry.lastUsedAt)
}

/**
 * How fast an entry's recency weight decays.
 *
 * A memory not read or rewritten for a quarter is worth half as much as one
 * touched today, and the weight never falls below {@link DECAY_FLOOR}: recency
 * orders memories, it does not erase them.
 * @param entry - candidate entry.
 * @param now - injected clock.
 * @returns a weight in `[DECAY_FLOOR, 1]`.
 */
export function decayOf(entry: MemoryEntry, now = Date.now()): number {
  const ageDays = Math.max(0, (now - recencyOf(entry)) / 86_400_000)
  return Math.max(DECAY_FLOOR, 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS))
}

/**
 * Multiplier for a memory a person or the model wrote deliberately.
 *
 * `auto` entries are a background extractor's guess about a transcript;
 * `tool`/`user` entries are somebody's statement. When they disagree the
 * explicit one is the newer truth, and without a thumb on the scale the guess
 * wins purely because it has been around long enough to collect reads.
 */
export const EXPLICIT_SOURCE_BONUS = 1.25

/**
 * How much an entry has earned its place: a small bonus per recorded use, and a
 * smaller one for having been written deliberately rather than inferred.
 */
export function importanceOf(entry: MemoryEntry): number {
  const used = 1 + Math.min(entry.uses, 10) * 0.35
  return entry.source === 'auto' ? used : used * EXPLICIT_SOURCE_BONUS
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

/**
 * Rank one entry against a query, reporting the evidence behind the number.
 *
 * The recall gate compares relevance AND evidence, so a caller that has to
 * explain a decision ("why was nothing recalled?") needs both parts plus the
 * sentence that produced them.
 *
 * @param entry - candidate entry.
 * @param query - raw turn or search text.
 * @param now - clock used for the decay.
 * @returns relevance, the decayed score, the matching sentence, and evidence.
 */
export function explainEntry(entry: MemoryEntry, query: string, now = Date.now()): {
  relevance: number
  score: number
  best: string
  evidence: MatchEvidence
} {
  const match = bestMatch(entry, query)
  return {
    relevance: match.relevance,
    score: match.relevance * importanceOf(entry) * decayOf(entry, now),
    best: match.best,
    evidence: match.evidence,
  }
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
  /** Model-facing label, e.g. `global` or `project:dsh-memories`. */
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
