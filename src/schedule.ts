/**
 * Timing for the background passes: how long to wait for a session to settle,
 * and which hours the plugin is allowed to spend tokens in.
 *
 * Both exist for the same reason. Stage 1 (extraction) and stage 2
 * (consolidation) are the only parts of this plugin that call a model, so they
 * are the only parts that cost anything, and providers price by time of day:
 * DeepSeek, for one, charges double on weekday mornings and afternoons (Beijing
 * time) and half everywhere else. Deferring those two calls into the cheap
 * window is a straight discount on everything this plugin spends.
 *
 * The window is expressed as the *peak* hours to avoid, not as the hours to run,
 * because that is how providers publish it and how a person reasons about it:
 * "don't spend between 9 and 12". Everything else is implicitly allowed, so
 * weekends need no entry at all.
 *
 * @module dsh-memories/schedule
 */

/** Weekday numbers as `Date.getDay()` reports them, plus their spellings. */
const DAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
}

/** One parsed peak window: local time, minutes since midnight, wrap allowed. */
export interface PeakWindow {
  /** Weekdays the window starts on (`Date.getDay()` numbering). */
  readonly days: ReadonlySet<number>
  /** Start, in minutes since local midnight. */
  readonly from: number
  /** End, in minutes since local midnight; `1440` means midnight tonight. */
  readonly to: number
}

/** The result of parsing one `peakHours` spec. */
export interface PeakSpec {
  /** The windows that parsed. */
  readonly windows: readonly PeakWindow[]
  /** Entries that did not parse, verbatim, so a typo can be reported. */
  readonly invalid: readonly string[]
}

/** Parse `HH:MM` into minutes since midnight. */
function parseClock(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 24 || minutes > 59) return undefined
  if (hours === 24 && minutes !== 0) return undefined
  return hours * 60 + minutes
}

/** Resolve one day token (`mon`, `Mon-Fri`, `sat`) to weekday numbers. */
function parseDays(text: string): Set<number> | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed === '*') return new Set([0, 1, 2, 3, 4, 5, 6])
  const days = new Set<number>()
  for (const part of trimmed.split('+')) {
    const range = part.split('-')
    if (range.length === 2) {
      const start = DAY_NAMES[range[0]?.trim().toLowerCase() ?? '']
      const end = DAY_NAMES[range[1]?.trim().toLowerCase() ?? '']
      if (start === undefined || end === undefined) return undefined
      // A range wraps forward, so `Sat-Mon` is Sat, Sun, Mon.
      for (let step = 0, day = start; step < 7; step += 1, day = (day + 1) % 7) {
        days.add(day)
        if (day === end) break
      }
      continue
    }
    const day = DAY_NAMES[part.trim().toLowerCase()]
    if (day === undefined) return undefined
    days.add(day)
  }
  return days.size > 0 ? days : undefined
}

/**
 * Parse a `peakHours` spec.
 *
 * Grammar, all optional and local time:
 *
 * ```text
 * <days> <HH:MM>-<HH:MM>        Mon-Fri 09:00-12:00
 * <HH:MM>-<HH:MM>               every day
 * <a>+<b> <HH:MM>-<HH:MM>       Mon+Wed+Fri 14:00-18:00
 * `*` for days                  * 09:00-12:00
 * ```
 *
 * Entries are separated by `,` or `;`. A window whose end is not after its start
 * crosses midnight (`Sat 22:00-02:00`). An empty spec means "never peak".
 *
 * @param spec - the configured spec.
 * @returns the windows that parsed, plus any entries that did not.
 */
export function parsePeakHours(spec: string): PeakSpec {
  const windows: PeakWindow[] = []
  const invalid: string[] = []
  for (const raw of spec.split(/[,;]/u)) {
    const entry = raw.trim()
    if (entry.length === 0) continue
    // The day part is everything before the first token that contains a colon.
    const match = /^(.*?)\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/u.exec(entry)
    if (match === null) {
      invalid.push(entry)
      continue
    }
    const days = parseDays(match[1] ?? '')
    const from = parseClock(match[2] ?? '')
    const to = parseClock(match[3] ?? '')
    if (days === undefined || from === undefined || to === undefined || from === to) {
      invalid.push(entry)
      continue
    }
    windows.push({ days, from, to })
  }
  return { windows, invalid }
}

/** Minutes since local midnight. */
function minuteOf(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

/**
 * Whether a moment falls inside a window.
 *
 * A window that crosses midnight is matched on the day it *starts*: `Sat
 * 22:00-02:00` covers Saturday night and Sunday's small hours, because that is
 * what somebody writing it means.
 *
 * @param window - the parsed window.
 * @param now - the moment to test.
 * @returns true when the moment is inside.
 */
export function withinWindow(window: PeakWindow, now: Date): boolean {
  const minutes = minuteOf(now)
  const day = now.getDay()
  if (window.to > window.from) {
    return window.days.has(day) && minutes >= window.from && minutes < window.to
  }
  // Crosses midnight: either late on a listed day, or early on the day after one.
  if (window.days.has(day) && minutes >= window.from) return true
  const yesterday = (day + 6) % 7
  return window.days.has(yesterday) && minutes < window.to
}

/** Merge overlapping windows so the end of a moment is the end of its last window. */
function covering(windows: readonly PeakWindow[], now: Date): PeakWindow[] {
  return windows.filter((window) => withinWindow(window, now))
}

/**
 * Milliseconds until the current peak window ends, or `0` when not in one.
 *
 * The delay is floored one second past the boundary: firing exactly on it would
 * re-enter the same check and defer again.
 *
 * @param spec - the configured `peakHours` spec.
 * @param now - the moment to measure from.
 * @returns milliseconds to wait, or 0 when spending is allowed right now.
 */
export function peakDelayMs(spec: string, now = new Date()): number {
  if (spec.trim().length === 0) return 0
  const { windows } = parsePeakHours(spec)
  const current = covering(windows, now)
  if (current.length === 0) return 0
  const minutes = minuteOf(now)
  let soonest = Number.POSITIVE_INFINITY
  for (const window of current) {
    // Minutes from `now` to this window's end, crossing midnight when needed.
    const remaining = window.to > minutes ? window.to - minutes : 1440 - minutes + window.to
    soonest = Math.min(soonest, remaining)
  }
  if (!Number.isFinite(soonest)) return 0
  return soonest * 60_000 + 1_000
}

/**
 * How long to wait after a session settles before mining it.
 *
 * The delay is the *larger* of the two configured waits, and that is the whole
 * point: scheduling for the idle delay alone produced a pass that always failed
 * the quiet-window gate. The timer fires once and is never re-armed, so a 5
 * minute timer guarding a 6 hour window meant stage 1 never ran at all — the
 * plugin's own store showed dozens of tracked sessions and not one watermark.
 *
 * @param settings - the tunables in force.
 * @returns milliseconds to wait after the session settles.
 */
export function extractionDelayMs(settings: { autoExtractIdleMs: number; minIdleHours: number }): number {
  return Math.max(settings.autoExtractIdleMs, settings.minIdleHours * 3_600_000)
}

/**
 * How long to wait before the next pass, counting both gates.
 *
 * @param settings - the tunables in force.
 * @param now - the moment to measure from.
 * @returns milliseconds to wait.
 */
export function backgroundDelayMs(settings: { autoExtractIdleMs: number; minIdleHours: number; peakHours: string }, now = new Date()): number {
  return Math.max(extractionDelayMs(settings), peakDelayMs(settings.peakHours, now))
}

/** Render a delay as `45s`, `5m`, or `6h30m`, for one diagnostic line. */
export function formatDelay(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h${rest}m`
}

/**
 * Waits between retries of a session whose extraction reply hit the output cap.
 *
 * A capped reply is not a completed extraction, so its window is left unmined
 * and the next attempt reads it again — that is the whole point, and it is also
 * the cost: the cause is usually deterministic (the transcript is bigger than
 * `extractMaxOutputTokens` can describe, or the inherited reasoning level bills
 * its thinking against the same ceiling), so a retry on the pass cadence would
 * repeat a full-price call every `extractIntervalMinutes` and never succeed.
 * Consecutive caps therefore back off geometrically to one attempt per six
 * hours: a ceiling that is simply too small costs a handful of calls a day, and
 * a transient cap is still retried within the hour.
 */
const CAPPED_BACKOFF_LADDER = [30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000]

/**
 * How long to wait before retrying a window whose reply hit the output cap.
 *
 * @param hits - consecutive capped replies for this session, counting this one.
 * @param intervalMs - the configured pass interval. The wait is never shorter
 *   than it, so the ladder's first rung cannot undercut a slower cadence the
 *   user chose deliberately; `0` (periodic checks off) leaves the ladder alone.
 * @returns milliseconds to wait before the next attempt.
 */
export function cappedBackoffMs(hits: number, intervalMs: number): number {
  const last = CAPPED_BACKOFF_LADDER.length - 1
  const index = Math.min(Math.max(Math.trunc(hits), 1), last + 1) - 1
  const rung = CAPPED_BACKOFF_LADDER[index] ?? CAPPED_BACKOFF_LADDER[last] ?? 0
  return Math.max(intervalMs > 0 ? intervalMs : 0, rung)
}
