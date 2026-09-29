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
import { parseTimeRange, within, type TimeRange } from './time.js'

/** A CJK ideograph, including the extension blocks in common use. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
/** A CJK character inside a query or a memory field. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
/** A maximal run of CJK characters. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu
/**
 * Shortest shared CJK run that counts as strong evidence.
 *
 * Two, and this is the single most consequential constant in the file. At three,
 * a Chinese query only matched a memory when the two shared the same *phrase* —
 * the right idea and the wrong threshold. Natural turns and titles restate the
 * same topic in different words, so 「帮我把这次改动提交一下」 shares no
 * three-character run with 「把混装的工作区改动拆成两笔提交」 even though both are
 * unmistakably about committing changes. Measured on the real store, six
 * realistic mid-conversation turns recalled nothing at all, and every one had a
 * memory sitting right there: 「抽取任务好像没在跑」 against 「后台抽取 2026-09-22
 * 起停摆」 is the clearest — one shared pair, 抽取, and no shared phrase.
 *
 * At two, each shared pair counts as its own unit of evidence and the
 * *structural* gate does the work instead: recall requires two of them
 * ({@link DEFAULT_RECALL_MIN_TERMS}), so an isolated common pair still cannot
 * carry a match. That is the case three was introduced for — 「该插件是否有日志」
 * shares 插件, and only 插件, with a memory about plugin registration order — and
 * it stays rejected, because it is one term rather than two. Three was buying a
 * proxy for "more than one"; two counts that directly, and it counts pairs that
 * are not adjacent to each other.
 */
const MIN_SHARED_RUN = 2
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
 * Deliberately short next to the store's own lifetime. It was 90 days, which on
 * an eleven-day-old store distinguishes almost nothing: the recency term spanned
 * 0.94–1.00 while the use-count term spanned 1.0–4.5, so the injected summary
 * was decided by how often a memory had been read before. Measured on a real
 * store that pinned the same six entries — a plugin's logger threshold, a
 * sidebar adapter, a model catalog — into every unrelated session, because those
 * are the memories the harness's own plugin work kept reading. Thirty days keeps
 * recency meaningful against the use term without letting a quarter-old
 * convention fall out of reach.
 */
export const RECENCY_HALF_LIFE_DAYS = 30

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
 *
 * Raised from 1.25 because that was not enough to matter: against a use term
 * spanning 1.0–4.5 with a ten-use cap, a deliberately written entry lost to a
 * heavily-read extracted one every time. Measured on a real store, all six
 * hand-written global rules — including "never break the prompt cache" and
 * "reconnaissance is read-only GET" — failed to reach any session's summary,
 * while the twelve that did were all extracted notes.
 *
 * Two, because the bonus has to clear {@link AUTO_IMPORTANCE_CEILING} rather
 * than merely approach it: at 1.6 a written rule still tied with a note that had
 * been read five times, and the measured global half kept preferring the note.
 */
export const EXPLICIT_SOURCE_BONUS = 2

/**
 * How much one recorded read is worth, and the cap on how far it can climb.
 *
 * Previously `1 + min(uses, 10) * 0.35`, which let a single read-count term
 * outrank recency by four to one and flattened the top of the ranking into a
 * four-way tie at the cap. The slope is smaller and the cap lower so that
 * recency, explicitness and use count each still move the order.
 */
export const USE_BONUS = 0.15

/** @see USE_BONUS */
export const USE_CAP = 5

/**
 * Ceiling a purely read-accumulated entry can reach (see {@link importanceOf}).
 *
 * Exported because {@link EXPLICIT_SOURCE_BONUS} has to clear it for a hand
 * written rule to outrank the busiest extracted note: with the bonus below
 * `1 + USE_CAP * USE_BONUS` the injected global half stays a list of whatever
 * the harness's own tooling happened to read most, which is exactly the state
 * the slot audit measured.
 */
export const AUTO_IMPORTANCE_CEILING = 1 + USE_CAP * USE_BONUS

/**
 * How much an entry has earned its place: a small bonus per recorded use, and a
 * larger one for having been written deliberately rather than inferred.
 */
export function importanceOf(entry: MemoryEntry): number {
  const used = 1 + Math.min(entry.uses, USE_CAP) * USE_BONUS
  return entry.source === 'auto' ? used : used * EXPLICIT_SOURCE_BONUS
}

/**
 * How much a turn's time window lifts an entry whose *measurement* falls in it.
 *
 * A `snapshot` carries `asOf` — the day the number was read — and that is the
 * one timestamp in the store that answers a date question exactly. The lift is
 * roughly a body hit's worth: enough to reorder memories that all match the
 * words of the turn, never enough to outrank a memory that matches them better.
 * It multiplies relevance rather than joining it, so a time match alone can
 * never recall an entry — the lexical gate still runs first.
 */
export const TIME_MEASURED_BOOST = 1.5

/**
 * How much the window lifts an entry that was *learned* inside it.
 *
 * Weaker than {@link TIME_MEASURED_BOOST} on purpose: `createdAt` is when the
 * memory was written, which for a conversation-derived memory is a good proxy
 * for when the thing happened, but for a hand-written rule it is just when
 * somebody typed it. Measured on the real store, 306 of 613 entries carry a
 * session pointer, so the proxy holds for the extracted half and is a
 * tie-breaker for the rest.
 */
export const TIME_CREATED_BOOST = 1.15

/**
 * The multiplier a turn's time window applies to one entry.
 *
 * `undefined` (no time expression, or an entry with no timestamps) returns 1, so
 * turns that name no date are scored exactly as before. An entry is never
 * *penalised* for falling outside the window: a durable fact learned in March
 * can still be the answer to a question about last week, and punishing it would
 * hide the answer more often than it would sharpen the list.
 *
 * @param entry - candidate entry.
 * @param range - the turn's window, when it named one.
 * @returns a multiplier of at least 1.
 */
export function timeBoost(entry: MemoryEntry, range: TimeRange | undefined): number {
  if (range === undefined) return 1
  if (within(entry.asOf, range)) return TIME_MEASURED_BOOST
  if (within(entry.createdAt, range)) return TIME_CREATED_BOOST
  return 1
}

/**
 * Score one entry against a query: relevance × importance × recency decay × time.
 *
 * One formula for every ordering in the plugin — tool search, the injected
 * summary, and the on-demand recall threshold — so "worth recalling" means the
 * same thing everywhere and a knob tuned in one place holds in the others.
 *
 * @param entry - candidate entry.
 * @param query - raw user/model query.
 * @param now - clock used for the decay.
 * @param range - the turn's time window, or `undefined` to resolve it from the
 *   query. Callers that score many entries for one turn should parse once with
 *   {@link parseTimeRange} and pass it in.
 * @returns a non-negative score; `0` means the entry does not match.
 */
export function scoreEntry(entry: MemoryEntry, query: string, now = Date.now(), range?: TimeRange | null): number {
  return rankEntry(entry, query, now, range).score
}

/**
 * Both halves of one entry's number: what it matches, and what it deserves.
 *
 * They are multiplied together everywhere else, which makes a loss impossible to
 * attribute by reading the output — and the two surfaces want opposite orders.
 * Measured on the real store, ranking by `relevance` alone puts the expected
 * entry in the top eight for **every** probe (7/7), while the multiplied score
 * manages 5/7: 「怎么给 dsh 插件加日志才看得到」 loses to eight heavily-read
 * explicit memories that share the word `dsh`, which 100 of the scope's 176
 * entries carry. A caller that asked a *question* wants the first; a caller
 * deciding what to volunteer unasked wants the second.
 *
 * @param entry - candidate entry.
 * @param query - raw user/model query.
 * @param now - clock used for the decay.
 * @param range - the turn's time window, or `undefined` to resolve it.
 * @returns relevance (`0` when the entry does not match) and the attention score.
 */
export function rankEntry(entry: MemoryEntry, query: string, now = Date.now(), range?: TimeRange | null): { relevance: number; score: number } {
  const relevance = relevanceOf(entry, query)
  if (relevance === 0) return { relevance: 0, score: 0 }
  const window = range === undefined ? parseTimeRange(query, now) : range ?? undefined
  return { relevance, score: relevance * importanceOf(entry) * decayOf(entry, now) * timeBoost(entry, window) }
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
 * @param range - the turn's time window, or `undefined` to resolve it.
 * @returns relevance, the decayed score, the matching sentence, and evidence.
 */
export function explainEntry(entry: MemoryEntry, query: string, now = Date.now(), range?: TimeRange | null): {
  relevance: number
  score: number
  best: string
  evidence: MatchEvidence
} {
  const match = bestMatch(entry, query)
  const window = range === undefined ? parseTimeRange(query, now) : range ?? undefined
  return {
    relevance: match.relevance,
    score: match.relevance * importanceOf(entry) * decayOf(entry, now) * timeBoost(entry, window),
    best: match.best,
    evidence: match.evidence,
  }
}

/**
 * How much clearer than the floor a single strong term has to be on its own.
 *
 * One substantive term is half the evidence two are, so it only counts when the
 * score it produced is decisive rather than marginal. Without this the structural
 * gate would admit a memory that shares one distinctive word with the turn.
 */
export const QUALIFIED_SCORE_FACTOR = 2

/** One entry's verdict on whether a turn is actually about it. */
export interface MatchCredit {
  /** True when the entry is about the turn, not merely adjacent to it. */
  readonly about: boolean
  /** True when the score is decisive enough to carry a single strong term. */
  readonly distinctive: boolean
  /** True when the evidence gate is satisfied on its own terms. */
  readonly credited: boolean
  /** Lexical relevance, before importance and decay. */
  readonly relevance: number
  /** Relevance weighted by importance and recency, for ordering candidates. */
  readonly score: number
  /** The sentence that produced the score. */
  readonly best: string
  /** The structural evidence behind the score. */
  readonly evidence: MatchEvidence
}

/** How strictly {@link matchCredit} applies its structural gate. */
export interface CreditOptions {
  /**
   * Whether ONE strong term plus a decisive score is enough on its own.
   *
   * Right for a recall delta, wrong for the summary's topical tier. The recall
   * path exists to answer "does this turn touch something already known", and a
   * one-keyword turn ("端口 3080") is exactly what it must catch. The summary
   * instead decides who outranks a well-read memory, so it demands the full
   * term count: with the escape hatch on, measured on the real store, a query
   * about how the summary is ranked put twelve memories in the topical tier on
   * one shared term each, and the tier stopped discriminating — the ranking
   * reverted to history with a gate in front of it.
   */
  readonly singleTerm?: boolean
  /** Clock used for the decayed score. */
  readonly now?: number
  /**
   * The turn's time window, or `null` for "none".
   *
   * Omitted, the window is resolved from the query — right for a one-off call,
   * wrong for a loop over the whole store, where the same regex sweep would run
   * once per entry on every step. The recall path parses once per turn and
   * passes the result here.
   */
  readonly range?: TimeRange | null
}

/**
 * Whether one entry is genuinely about one turn — the single decision behind
 * both the injected summary's topical tier and the on-demand recall gate.
 *
 * Two gates that answer different questions, and neither replaces the other:
 *
 * - **FLOOR** (`minScore`) is the caller's strictness knob: the relevance an
 *   entry has to reach at all.
 * - **CREDIT** is structural, and a score threshold cannot replace it for
 *   Chinese. Measured on a real 54-memory store, 「该插件是否有日志」 shares the
 *   isolated bigram 插件 with a memory about an unrelated cost-meter bug and
 *   scores 12 — above any floor low enough to admit a paraphrase. Credit asks
 *   instead for substantive terms: a Latin word of three characters or more, or
 *   a CJK pair inside a shared run of three or more, which is the only Chinese
 *   term a merely common pair cannot fake.
 *
 * A whole-query hit stands alone; otherwise `minTerms` are required, with one
 * allowed when the score is {@link QUALIFIED_SCORE_FACTOR} times the floor and
 * {@link CreditOptions.singleTerm} leaves that escape hatch open.
 *
 * This lives here, once, because the summary and the recall path used to spell
 * the rule out separately and the two copies had already drifted apart.
 *
 * @param entry - candidate entry.
 * @param query - the raw turn or search text.
 * @param minScore - the relevance floor.
 * @param minTerms - strong terms required when the score is not decisive.
 * @param options - gate strictness and clock.
 * @returns the verdict with the evidence behind it.
 */
export function matchCredit(
  entry: MemoryEntry,
  query: string,
  minScore: number,
  minTerms: number,
  options: CreditOptions = {},
): MatchCredit {
  const now = options.now ?? Date.now()
  const singleTerm = options.singleTerm ?? true
  const window = options.range === undefined ? parseTimeRange(query, now) : options.range ?? undefined
  const match = bestMatch(entry, query)
  const distinctive = match.relevance >= minScore * QUALIFIED_SCORE_FACTOR
  const credited = match.evidence.phrase
    || match.evidence.strongTerms >= minTerms
    || (singleTerm && match.evidence.strongTerms >= 1 && distinctive)
  return {
    about: match.relevance >= minScore && credited,
    distinctive,
    credited,
    relevance: match.relevance,
    best: match.best,
    evidence: match.evidence,
    score: match.relevance * importanceOf(entry) * decayOf(entry, now) * timeBoost(entry, window),
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
  /**
   * Follow the top hits one hop along shared keys and tags, and let what they
   * link to fill the slots the direct matches left empty.
   *
   * Off by default because a caller that wants "what matches these words" — the
   * settings page's search box is exactly that — should get what it asked for.
   * The model-facing search turns it on: it is asking "what do we know about
   * this", and the answer includes the entries filed under the same aliases.
   */
  readonly expand?: boolean
}

/**
 * Most direct hits used as seeds for the one-hop expansion.
 *
 * Three, because a hop from a weak match is a guess about a guess: the seeds are
 * the entries the turn actually matched, and only their own links are followed.
 */
export const EXPAND_SEEDS = 3

/**
 * Keys or tags two entries must share before either can pull the other in.
 *
 * Two, for the same reason the recall gate asks for two substantive terms: one
 * shared tag is the memory equivalent of a common word. `sqlite` alone links
 * every database note in the store; `sqlite` plus `state.db` is a claim that the
 * two entries are about the same thing.
 */
export const EXPAND_MIN_SHARED = 2

/**
 * A related entry's score, as a fraction of the seed it was reached from.
 *
 * Spreading activation, in one line: a neighbour inherits a fixed fraction of
 * the activation of the node that lit it up. It was first written as a fraction
 * of the WEAKEST direct hit, so that a hop could never displace a real match —
 * which sounds safe and is useless. The real-store eval showed why: a query can
 * match forty entries on one shared word each, and every one of them outranks a
 * hop that is pegged to the weakest of the top three. 「注入相关性的排查一共分了
 * 几轮」 left all four rounds out of the top five in every configuration.
 *
 * Tying the score to its own seed keeps the useful part of the old property —
 * a hop never outranks the node it came from — while letting a neighbour of the
 * *best* match beat entries that merely share a common word with the turn.
 */
export const EXPAND_FACTOR = 0.4

/**
 * Share of a scope that may carry a link before it stops being an edge.
 *
 * A key or tag on more than half the entries is the scope's own name, not a
 * relationship: in the plugin's own project scope `dsh-memories` sits on 22 of
 * 29 entries, and `--links` measured 18 of that scope's 48 hop-able pairs
 * sharing nothing but such links (against 0 of 785 in the global scope). Those
 * hops fired, scored like real ones, and carried no information. Ignoring the
 * ubiquitous links removes them without a rarity threshold that would have
 * silently disabled the mechanism in small scopes, where every link looks
 * common because the scope has four entries.
 */
export const EXPAND_GENERIC_SHARE = 0.5

/**
 * The link information that earns the full allowance.
 *
 * Two, because that is what two wholly specific links are worth (`1 - 1/N` each
 * in a scope of any size). A hop backed by one rare alias and one common tag
 * lands around half; a hop backed by two broad tags lands at a quarter and
 * stays behind everything else.
 */
export const EXPAND_WEIGHT_FULL = 2

/** Most related entries one search may add. */
export const EXPAND_MAX = 3

/**
 * The words an entry is filed under: its keys and its tags.
 *
 * Only these two fields, deliberately. The body mentions many things, and a hop
 * through a body word would link entries that merely share vocabulary; `keys`
 * exists to hold the *other names* for a memory, which is exactly the edge a
 * graph walk should follow.
 *
 * @param entry - candidate entry.
 * @returns lowercased, non-empty link words.
 */
function linksOf(entry: MemoryEntry): Set<string> {
  const links = new Set<string>()
  for (const value of [...entry.keys, ...entry.tags]) {
    const link = value.trim().toLowerCase()
    if (link.length > 0) links.add(link)
  }
  return links
}

/**
 * Entries reachable from the direct hits by following shared keys/tags.
 *
 * The deterministic stand-in for the graph channel in a memory architecture like
 * Hindsight's: instead of embedding entities, it uses the aliases a memory is
 * already filed under as edges. 「你了解我的账户吗」 matches one fragment about
 * the account; the other three carry the same `keys`, and this is what surfaces
 * them together — without a model call and without an index.
 *
 * @param groups - per-scope entry lists, broadest first.
 * @param seeds - the direct hits whose links are followed.
 * @param options - the same filters as {@link searchMemories}, plus the ids to
 *   exclude (the seeds themselves: an entry is not its own neighbour).
 * @returns related hits, strongest first, with the seed each came from.
 */
export function relatedHits(
  groups: readonly ScopeEntries[],
  seeds: readonly MemoryHit[],
  options: SearchOptions & { readonly exclude?: ReadonlySet<string> } = {},
): MemoryHit[] {
  const limit = options.limit ?? EXPAND_MAX
  if (seeds.length === 0 || limit <= 0) return []
  const wantedScopes = options.scopes
  const wantedTags = (options.tags ?? []).map((tag) => tag.toLowerCase())
  const wantedKinds = options.kinds
  const exclude = options.exclude ?? new Set<string>()
  // How many entries carry each link, over exactly the entries this search can
  // see. One pass, and it is what turns "shared two links" into "shares two
  // links that mean something here": `dsh-memories` on 22 of 29 entries is the
  // scope's own name, and a hop built on it carries nothing.
  const carried = new Map<string, number>()
  let considered = 0
  for (const group of groups) {
    if (wantedScopes !== undefined && !wantedScopes.includes(group.scope)) continue
    for (const entry of group.entries) {
      if (wantedKinds !== undefined && !wantedKinds.includes(entry.kind)) continue
      if (wantedTags.length > 0 && !wantedTags.every((tag) => entry.tags.includes(tag))) continue
      considered += 1
      for (const link of linksOf(entry)) carried.set(link, (carried.get(link) ?? 0) + 1)
    }
  }
  /** A ubiquitous link is not an edge; a rare one is worth nearly all of itself. */
  const information = (link: string): number => {
    if (considered <= 0) return 0
    const share = (carried.get(link) ?? 0) / considered
    return share > EXPAND_GENERIC_SHARE ? 0 : 1 - share
  }
  const links = seeds.map((seed) => ({ id: seed.entry.id, score: seed.score, words: linksOf(seed.entry) }))
  const best = new Map<string, { entry: MemoryEntry; score: number; shared: number; via: string }>()
  for (const group of groups) {
    if (wantedScopes !== undefined && !wantedScopes.includes(group.scope)) continue
    for (const entry of group.entries) {
      if (exclude.has(entry.id)) continue
      if (wantedKinds !== undefined && !wantedKinds.includes(entry.kind)) continue
      if (wantedTags.length > 0 && !wantedTags.every((tag) => entry.tags.includes(tag))) continue
      const own = linksOf(entry)
      if (own.size === 0) continue
      let shared = 0
      let weight = 0
      let via = ''
      let from = 0
      for (const seed of links) {
        let here = 0
        let hereWeight = 0
        for (const word of own) {
          if (!seed.words.has(word)) continue
          const value = information(word)
          if (value <= 0) continue
          here += 1
          hereWeight += value
        }
        // The seed that lights this entry up is the one carrying the most
        // information into it; ties keep the better-ranked seed.
        if (hereWeight > weight || (hereWeight === weight && here > shared && here > 0)) {
          shared = here
          weight = hereWeight
          via = seed.id
          from = seed.score
        }
      }
      if (shared < EXPAND_MIN_SHARED) continue
      // Two fully specific links earn half the allowance, four or more earn all
      // of it; a pair of broad tags lands at a quarter and stays behind every
      // entry the turn actually matched.
      const score = from * EXPAND_FACTOR * Math.min(1, weight / EXPAND_WEIGHT_FULL)
      const previous = best.get(entry.id)
      if (previous === undefined || score > previous.score) best.set(entry.id, { entry, score, shared, via })
    }
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score
      || right.shared - left.shared
      || right.entry.updatedAt - left.entry.updatedAt
      || left.entry.title.localeCompare(right.entry.title))
    .slice(0, limit)
    .map((hit) => ({ entry: hit.entry, score: hit.score, via: hit.via }))
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
 * @returns hits ordered by descending relevance, the attention score breaking ties.
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
  const window = parseTimeRange(query, now)
  // The search surface orders by the WORDS, not by the attention model. The
  // caller asked a question; the entry that matches it best is the answer, and
  // an entry that merely gets read a lot is not. Measured on the real store:
  // ordering by relevance puts the expected entry in the top eight for 7 of 7
  // probes, the multiplied score for 5 of 7 — the difference is entirely
  // 「怎么给 dsh 插件加日志才看得到」 losing to eight tool-written notes that
  // share `dsh` (100 of 176 entries) and have been read five times each.
  //
  // The injector keeps the opposite order on purpose: it volunteers memories
  // nobody asked for, and there the track record is the point. Both numbers are
  // computed here, so neither surface has to guess.
  const hits: (MemoryHit & { readonly relevance: number })[] = []
  for (const group of groups) {
    if (wantedScopes !== undefined && !wantedScopes.includes(group.scope)) continue
    for (const entry of group.entries) {
      if (wantedKinds !== undefined && !wantedKinds.includes(entry.kind)) continue
      if (wantedTags.length > 0 && !wantedTags.every((tag) => entry.tags.includes(tag))) continue
      const { relevance, score } = rankEntry(entry, query, now, window)
      if (relevance <= 0) continue
      hits.push({ entry, score, relevance })
    }
  }
  const byWords = (left: MemoryHit & { readonly relevance: number }, right: MemoryHit & { readonly relevance: number }): number =>
    right.relevance - left.relevance
    || right.score - left.score
    || right.entry.updatedAt - left.entry.updatedAt
    || left.entry.title.localeCompare(right.entry.title)
  hits.sort(byWords)
  if (options.expand !== true) return hits.slice(0, limit)
  // One hop, never two: a second hop from a guess is a different guess.
  //
  // Only the seeds are excluded, and for one reason: an entry cannot be its own
  // neighbour. Two narrower-looking rules were tried first and both were wrong
  // on the real store — excluding every entry with any lexical score at all
  // (a memory that shares one word scores 2 and lands at rank 40, so the hop
  // could never reach the case it exists for), and excluding the top `limit`
  // (the eighth direct hit is exactly the entry a hop can lift; its rank went
  // 8 → 9, the one entry that would have benefited being the one removed).
  //
  // The seeds are handed over in RELEVANCE units, because that is the currency
  // this surface ranks in: a hop scored against the seed's attention score would
  // be sorting apples against oranges. The injector passes attention scores
  // instead, for the same reason.
  const seeds = hits.slice(0, EXPAND_SEEDS)
  const related = relatedHits(groups, seeds.map((hit) => ({ entry: hit.entry, score: hit.relevance })), {
    ...options,
    limit: EXPAND_MAX,
    exclude: new Set(seeds.map((hit) => hit.entry.id)),
  })
  // An entry the query did match keeps its own relevance when that is the higher
  // one, and never carries `via`: it matched, and saying otherwise would be a
  // lie about the one thing the marker exists to state.
  const directById = new Map(hits.map((hit) => [hit.entry.id, hit]))
  const merged: (MemoryHit & { readonly relevance: number })[] = [...hits]
  for (const hit of related) {
    const direct = directById.get(hit.entry.id)
    // A hop ranks in word units too (`hit.score`), but reports an attention
    // score like every other hit: `score` means one thing on every row, and the
    // row's *place* is decided by the other number.
    const attention = hit.score * importanceOf(hit.entry) * decayOf(hit.entry, now)
    if (direct === undefined) {
      merged.push({
        entry: hit.entry,
        score: attention,
        relevance: hit.score,
        ...hit.via === undefined ? {} : { via: hit.via },
      })
    } else if (hit.score > direct.relevance) {
      merged.push({ entry: direct.entry, score: direct.score, relevance: hit.score })
    }
  }
  // Keep the best record per id. The direct list comes first, so keeping the
  // first occurrence would silently discard every upgrade — which is exactly
  // what the first version of this did, and what the eval caught.
  const unique = new Map<string, MemoryHit & { readonly relevance: number }>()
  for (const hit of merged) {
    const previous = unique.get(hit.entry.id)
    if (previous === undefined || hit.relevance > previous.relevance) unique.set(hit.entry.id, hit)
  }
  return [...unique.values()].sort(byWords).slice(0, limit)
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
