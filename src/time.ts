/**
 * Resolving the stretch of time a turn is talking about.
 *
 * The store has always *carried* time — `createdAt` says when a fact was
 * learned, `asOf` says when a `snapshot` reading was measured — but nothing ever
 * *asked* about it. A turn like 「上个月那个发票接口的问题是怎么解决的」 shares
 * 发票/接口 with every invoice memory ever written, so the ranking falls back to
 * importance and recency and hands back the same three entries it hands back for
 * every other invoice question. The date the user actually said, which is the
 * one thing that would cut the list down to the right week, was ignored.
 *
 * This module is the missing half: turn free text into a half-open epoch range,
 * deterministically and without a model call. It is deliberately narrow. It
 * recognises the shapes people really type — 今天/昨天/前天, 上周/上个月/去年,
 * 去年春天, 最近三天, 3 天前, 2026-09-20, 9 月 20 日 — and returns `undefined`
 * for everything else. A false positive is worse than a miss: it silently
 * reorders results for a turn that was not about time at all, and the reader has
 * no way to see why.
 *
 * Two design choices worth keeping:
 *
 * - **Local time.** Windows are computed with the host's local calendar, the
 *   same way `peakHours` is, because the user's "昨天" means their wall clock,
 *   not UTC. A memory system that answered 今天 with yesterday's date between
 *   00:00 and 08:00 in Shanghai would be worse than one that ignored dates.
 * - **Half-open ranges.** `[start, end)` so an entry measured exactly at
 *   midnight belongs to one day, not two.
 *
 * @module dsh-memories/time
 */

/** A resolved half-open window `[start, end)` in epoch milliseconds. */
export interface TimeRange {
  /** Inclusive lower bound. */
  readonly start: number
  /** Exclusive upper bound. */
  readonly end: number
  /** The text that produced it, for logs and tests. */
  readonly label: string
}

/** Chinese digit characters that appear in dates. */
const DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/**
 * Read a number written as Arabic digits or Chinese numerals.
 *
 * Only the shapes dates use: 3, 三, 十, 十一, 二十, 三十一.
 *
 * @param text - the matched text.
 * @returns the number, or `undefined` when it is neither form.
 */
export function cnNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) {
    const value = Number(text)
    return Number.isFinite(value) ? value : undefined
  }
  if (!/^[一二两三四五六七八九十]+$/u.test(text)) return undefined
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(text)
  if (tens !== null) {
    const high = tens[1] === undefined ? 1 : DIGITS[tens[1]] ?? 0
    const low = tens[2] === undefined ? 0 : DIGITS[tens[2]] ?? 0
    return high * 10 + low
  }
  return DIGITS[text]
}

/** Midnight local time of the day `date` falls in, shifted by whole days. */
function startOfDay(now: number, dayOffset = 0): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset).getTime()
}

/** Midnight local time of the Monday of `now`'s week, shifted by whole weeks. */
function startOfWeek(now: number, weekOffset = 0): number {
  const date = new Date(now)
  const monday = (date.getDay() + 6) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - monday + weekOffset * 7).getTime()
}

/** First instant of the month `months` away from the one `now` falls in. */
function startOfMonth(now: number, months = 0): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth() + months, 1).getTime()
}

/** First instant of the year `years` away from the one `now` falls in. */
function startOfYear(now: number, years = 0): number {
  return new Date(new Date(now).getFullYear() + years, 0, 1).getTime()
}

/** Month index (0-based) a season starts in. Winter is handled separately. */
const SEASON_START: Record<string, number> = { 春: 2, 夏: 5, 秋: 8, 冬: 11 }

/**
 * The window a season covers in a given year.
 *
 * Winter is the awkward one: 冬天 spans December into the next March, so its
 * end is computed from the following year. That is what 「去年冬天」 means to a
 * reader — the December-to-February stretch, not "December only".
 *
 * @param now - the clock.
 * @param season - one of 春/夏/秋/冬.
 * @param yearOffset - years relative to `now`'s year.
 * @returns the half-open window.
 */
function seasonRange(now: number, season: string, yearOffset: number): TimeRange {
  const year = new Date(now).getFullYear() + yearOffset
  const start = SEASON_START[season]
  if (start === undefined) return { start: now, end: now, label: season }
  const from = new Date(year, start, 1).getTime()
  const to = season === '冬' ? new Date(year + 1, 2, 1).getTime() : new Date(year, start + 3, 1).getTime()
  return { start: from, end: to, label: `${yearOffset === 0 ? '今年' : yearOffset === -1 ? '去年' : `${year}年`}${season}天` }
}

/** Year words, mapped to their offset from the current year. */
const YEAR_WORDS: Record<string, number> = {
  今年: 0, 本年: 0, 这一年: 0,
  去年: -1, 上年: -1, 上一年: -1, 前年: -2,
  明年: 1, 下一年: 1,
}

/** Day words, mapped to their offset from today. */
const DAY_WORDS: Record<string, number> = {
  今天: 0, 今日: 0, 本日: 0,
  昨天: -1, 昨日: -1, 前天: -2, 前日: -2,
  明天: 1, 明日: 1, 后天: 2,
}

/** Week words, mapped to their offset from this week. */
const WEEK_WORDS: Record<string, number> = {
  本周: 0, 这周: 0, 这一周: 0, 本星期: 0, 这星期: 0, 这个星期: 0,
  上周: -1, 上星期: -1, 上个星期: -1, 上一周: -1, 上个周: -1,
  下周: 1, 下星期: 1, 下个星期: 1, 下一周: 1,
}

/** Month words, mapped to their offset from this month. */
const MONTH_WORDS: Record<string, number> = {
  本月: 0, 这个月: 0, 这一个月: 0,
  上个月: -1, 上月: -1, 上一个月: -1,
  下个月: 1, 下月: 1, 下一个月: 1,
}

/** Unit words for "N units ago" / "the last N units", in days. */
const UNIT_DAYS: Record<string, number> = {
  天: 1, 日: 1, 周: 7, 星期: 7, 个星期: 7, 个月: 30, 月: 30, 年: 365,
}

/**
 * The window a turn refers to, or `undefined` when it names no time.
 *
 * Rules are tried most-specific first, so "2026 年 3 月" resolves as a month
 * rather than falling through to the bare "3 月" rule, and "去年春天" resolves
 * as last year's spring rather than this year's.
 *
 * @param text - the raw turn or query.
 * @param now - clock the relative expressions are resolved against.
 * @returns the half-open window, or `undefined` when the text names no time.
 */
export function parseTimeRange(text: string, now: number = Date.now()): TimeRange | undefined {
  const query = text.trim()
  if (query.length === 0) return undefined

  // ── Absolute dates ──────────────────────────────────────────────────────
  // 2026-09-20, 2026/9/20, 2026年9月20日, 2026年9月, 2026-09
  const absolute = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*(?:[-/月]\s*(\d{1,2})\s*日?)?/.exec(query)
  if (absolute !== null) {
    const year = Number(absolute[1])
    const month = Number(absolute[2])
    if (month >= 1 && month <= 12) {
      if (absolute[3] === undefined) {
        return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime(), label: `${year}-${month}` }
      }
      const day = Number(absolute[3])
      if (day >= 1 && day <= 31) {
        return {
          start: new Date(year, month - 1, day).getTime(),
          end: new Date(year, month - 1, day + 1).getTime(),
          label: `${year}-${month}-${day}`,
        }
      }
    }
  }

  // A bare year: 2026年 / 2026 年
  const bareYear = /(\d{4})\s*年/u.exec(query)
  if (bareYear !== null) {
    const year = Number(bareYear[1])
    return { start: new Date(year, 0, 1).getTime(), end: new Date(year + 1, 0, 1).getTime(), label: `${year}年` }
  }

  // ── Year-qualified seasons and months ───────────────────────────────────
  // 去年春天, 今年冬天, 去年 9 月, 前年3月. The unit is required: 去年3个问题 must
  // not resolve to last March.
  const YEARS = '今年|本年|去年|上年|上一年|前年|明年'
  const qualifiedSeason = new RegExp(`(${YEARS})\\s*(春天|春季|夏天|夏季|秋天|秋季|冬天|冬季)`, 'u').exec(query)
  if (qualifiedSeason !== null) {
    const offset = YEAR_WORDS[qualifiedSeason[1] as string]
    if (offset !== undefined) return seasonRange(now, (qualifiedSeason[2] as string)[0] as string, offset)
  }
  const qualifiedMonth = new RegExp(`(${YEARS})\\s*([一二两三四五六七八九十\\d]{1,3})\\s*月`, 'u').exec(query)
  if (qualifiedMonth !== null) {
    const offset = YEAR_WORDS[qualifiedMonth[1] as string]
    const month = cnNumber(qualifiedMonth[2] as string)
    if (offset !== undefined && month !== undefined && month >= 1 && month <= 12) {
      const year = new Date(now).getFullYear() + offset
      return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime(), label: `${qualifiedMonth[1]}${month}月` }
    }
  }

  // ── Bare month-day and bare month ───────────────────────────────────────
  // 9 月 20 日 / 九月二十日, then 3 月 / 三月
  const monthDay = /([一二两三四五六七八九十\d]{1,3})\s*月\s*([一二两三四五六七八九十\d]{1,3})\s*[日号]/u.exec(query)
  if (monthDay !== null) {
    const month = cnNumber(monthDay[1] as string)
    const day = cnNumber(monthDay[2] as string)
    if (month !== undefined && day !== undefined && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = new Date(now).getFullYear()
      return {
        start: new Date(year, month - 1, day).getTime(),
        end: new Date(year, month - 1, day + 1).getTime(),
        label: `${month}月${day}日`,
      }
    }
  }
  const bareMonth = /(?:^|[^\d])([一二两三四五六七八九十\d]{1,3})\s*月(?!\s*[\d一二两三四五六七八九十])/u.exec(query)
  if (bareMonth !== null) {
    const month = cnNumber(bareMonth[1] as string)
    if (month !== undefined && month >= 1 && month <= 12) {
      const year = new Date(now).getFullYear()
      return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime(), label: `${month}月` }
    }
  }

  // ── Bare seasons ────────────────────────────────────────────────────────
  // 春天/春季/夏天 … (a lone 春 only counts when it is written as 春天/春季)
  const season = /(春天|春季|夏天|夏季|秋天|秋季|冬天|冬季)/u.exec(query)
  if (season !== null) {
    const range = seasonRange(now, (season[1] as string)[0] as string, 0)
    return { ...range, label: season[1] as string }
  }

  // ── Counted intervals ───────────────────────────────────────────────────
  // Two shapes, and they mean different things. 最近三天 / 近 3 天 / 过去两个月 is
  // a window that *ends now* and *includes* the current day/month — three days
  // means today and the two before it, so the start is `-(count - 1)`; 3 天前 /
  // 两周前 / 5 个月前 is the single period that far back. Merging them would turn
  // "三个月前那次事故" into "the last three months", which is exactly the kind of
  // wrong-every-time answer the whole module exists to avoid.
  const WINDOW = /(?:最近|近|过去)\s*([一二两三四五六七八九十\d]{1,3})\s*(个?[天日周月]|个?星期|年)/u.exec(query)
  if (WINDOW !== null) {
    const count = cnNumber(WINDOW[1] as string)
    const unit = WINDOW[2] as string
    const days = UNIT_DAYS[unit]
    if (count !== undefined && days !== undefined && count > 0) {
      const label = WINDOW[0] as string
      if (unit === '年') return { start: startOfYear(now, -(count - 1)), end: now, label }
      if (unit === '月' || unit === '个月') return { start: startOfMonth(now, -(count - 1)), end: now, label }
      if (unit === '周' || unit === '星期' || unit === '个星期') return { start: startOfWeek(now, -(count - 1)), end: now, label }
      return { start: startOfDay(now, -(count * days) + 1), end: now, label }
    }
  }
  const AGO = /([一二两三四五六七八九十\d]{1,3})\s*(个?[天日周月]|个?星期|年)\s*前/u.exec(query)
  if (AGO !== null) {
    const count = cnNumber(AGO[1] as string)
    const unit = AGO[2] as string
    const days = UNIT_DAYS[unit]
    if (count !== undefined && days !== undefined && count > 0) {
      const label = AGO[0] as string
      if (unit === '年') return { start: startOfYear(now, -count), end: startOfYear(now, -count + 1), label }
      if (unit === '月' || unit === '个月') return { start: startOfMonth(now, -count), end: startOfMonth(now, -count + 1), label }
      if (unit === '周' || unit === '星期' || unit === '个星期') return { start: startOfWeek(now, -count), end: startOfWeek(now, -count + 1), label }
      return { start: startOfDay(now, -(count * days)), end: startOfDay(now, -(count * days) + 1), label }
    }
  }

  // ── Single words ────────────────────────────────────────────────────────
  for (const [word, offset] of Object.entries(DAY_WORDS)) {
    if (query.includes(word)) {
      return { start: startOfDay(now, offset), end: startOfDay(now, offset + 1), label: word }
    }
  }
  for (const [word, offset] of Object.entries(WEEK_WORDS)) {
    if (query.includes(word)) {
      return { start: startOfWeek(now, offset), end: startOfWeek(now, offset + 1), label: word }
    }
  }
  for (const [word, offset] of Object.entries(MONTH_WORDS)) {
    if (query.includes(word)) {
      return { start: startOfMonth(now, offset), end: startOfMonth(now, offset + 1), label: word }
    }
  }
  for (const [word, offset] of Object.entries(YEAR_WORDS)) {
    if (query.includes(word)) {
      return { start: startOfYear(now, offset), end: startOfYear(now, offset + 1), label: word }
    }
  }

  // ── English, just the shapes a mixed-language turn actually uses ────────
  const lower = query.toLowerCase()
  const english: readonly (readonly [RegExp, TimeRange])[] = [
    [/\byesterday\b/, { start: startOfDay(now, -1), end: startOfDay(now, 0), label: 'yesterday' }],
    [/\btoday\b/, { start: startOfDay(now, 0), end: startOfDay(now, 1), label: 'today' }],
    [/\blast week\b/, { start: startOfWeek(now, -1), end: startOfWeek(now, 0), label: 'last week' }],
    [/\blast month\b/, { start: startOfMonth(now, -1), end: startOfMonth(now, 0), label: 'last month' }],
    [/\blast year\b/, { start: startOfYear(now, -1), end: startOfYear(now, 0), label: 'last year' }],
  ]
  for (const [pattern, range] of english) if (pattern.test(lower)) return range

  return undefined
}

/**
 * Whether one instant falls inside a window.
 * @param at - epoch milliseconds, or `undefined` when the entry carries no time.
 * @param range - the window, or `undefined` when the turn named no time.
 * @returns true when `at` is inside `[start, end)`.
 */
export function within(at: number | undefined, range: TimeRange | undefined): boolean {
  if (at === undefined || range === undefined || at <= 0) return false
  return at >= range.start && at < range.end
}
