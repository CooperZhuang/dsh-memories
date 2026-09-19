/**
 * Turning one user turn into the strings a memory is actually compared against.
 *
 * A turn is a wall of text: instructions, pasted logs, code, a question at the
 * end. Scoring an entire 2 000-character message as one query buries a precise
 * hit inside all of that, and — worse — makes the result depend on the message's
 * length rather than on what it is about. Splitting the turn into sentences and
 * scoring each one independently is what lets "这段 PowerShell 该怎么写" reach a
 * memory about `git commit -F` while the surrounding paragraphs match nothing.
 *
 * The splitter is CJK-aware on purpose: Chinese sentences end with `。！？` and
 * often use a full-width comma as a clause boundary, so a whitespace-only split
 * would hand the scorer one enormous "sentence" per paragraph. Character-level
 * expansion (CJK bigrams) belongs to the scorer, not here — this module only
 * decides *what text* is compared, and `search.ts` decides *how*.
 *
 * @module dsh-memories/query
 */

/** Characters that end a sentence worth scoring on its own. */
const BREAK = /[。！？；!?;\n\r]+/u
/** A clause separator that joins closely related text (full- and half-width). */
const CLAUSE = /[，,、]+/u

/** Longest single query string handed to the scorer, in characters. */
export const MAX_MESSAGE_CHARS = 240

/** Most sentences and clauses one turn contributes. */
export const MAX_MESSAGES = 12

/**
 * Shortest candidate worth scoring on its own.
 *
 * One character, because a one-character query is still a query: the recall path
 * refuses a bare "好" as a turn, but a caller that searches for a single letter
 * or ideograph means it, and dropping the text before the scorer sees it would
 * turn a miss into a silence.
 */
const MIN_MESSAGE_CHARS = 1

/** Trim, collapse whitespace, and cap one candidate query. */
function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, MAX_MESSAGE_CHARS)
}

/**
 * The strings one user turn is scored as.
 *
 * The whole turn comes first, so a memory whose title spans a clause boundary
 * is still reachable verbatim; then sentences and clauses, most specific
 * (longest) first, because a long sentence shares more with an entry than a
 * stray "好的" does. The scorer keeps the best hit, so this ordering only
 * matters for the cap. The result is deduplicated, bounded, and deterministic.
 *
 * @param text - the raw user turn, or any search string.
 * @returns candidate queries; empty when the input carries no usable text.
 */
export function queryMessages(text: string): string[] {
  const trimmed = normalize(text)
  if (trimmed.length < MIN_MESSAGE_CHARS || !isSubstantiveTurn(trimmed)) return []
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    const query = normalize(value)
    if (query.length < MIN_MESSAGE_CHARS || seen.has(query)) return
    seen.add(query)
    candidates.push(query)
  }
  push(trimmed)
  const parts: string[] = []
  for (const sentence of trimmed.split(BREAK)) {
    const whole = sentence.trim()
    if (whole.length === 0) continue
    parts.push(whole)
    for (const clause of whole.split(CLAUSE)) {
      if (clause.trim().length > 0) parts.push(clause)
    }
  }
  parts.sort((left, right) => right.length - left.length)
  for (const part of parts.slice(0, MAX_MESSAGES)) push(part)
  return candidates
}

/**
 * Whether a turn carries enough text to be worth a recall decision.
 *
 * A bare "好" or "ok" cannot express what a memory would have to be about, and
 * letting it through only produces a full scan of the store on every step.
 *
 * @param text - the raw user turn.
 * @returns true when the turn has at least one letter, digit, or ideograph.
 */
export function isSubstantiveTurn(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}
