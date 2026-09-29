/**
 * Tests for the time channel: resolving a turn's window, and the lift it gives
 * entries that fall inside it.
 *
 * Every expectation is built from local `Date` parts rather than from epoch
 * constants, so the suite means the same thing in Shanghai and in UTC — the
 * feature is defined in local time, and a test that hardcoded a Z timestamp
 * would pass in one timezone and fail in the other.
 *
 * @module dsh-memories/test/time.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cnNumber, parseTimeRange, within } from '../time.js'
import { relevanceOf, scoreEntry, TIME_CREATED_BOOST, TIME_MEASURED_BOOST, timeBoost } from '../search.js'
import { rankForSummary } from '../render.js'
import type { MemoryEntry, MemoryKind } from '../types.js'

/** Tuesday, 29 September 2026, 19:00 local. */
const NOW = new Date(2026, 8, 29, 19, 0, 0).getTime()
const DAY = 86_400_000

/** Epoch of a local wall-clock moment. */
function at(year: number, month: number, day: number, hour = 0): number {
  return new Date(year, month - 1, day, hour).getTime()
}

/** One corpus entry. */
function entry(id: string, extra: Partial<MemoryEntry> = {}, kind: MemoryKind = 'fact'): MemoryEntry {
  return {
    id,
    scope: 'global',
    kind,
    title: id,
    body: `body of ${id}`,
    tags: [],
    keys: [],
    createdAt: at(2026, 1, 1),
    updatedAt: at(2026, 1, 1),
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...extra,
  }
}

/** The window a query resolves to, as `[label, start, end]` or `undefined`. */
function span(query: string): readonly [string, number, number] | undefined {
  const range = parseTimeRange(query, NOW)
  return range === undefined ? undefined : [range.label, range.start, range.end]
}

test('cnNumber reads both digit forms dates use', () => {
  assert.equal(cnNumber('3'), 3)
  assert.equal(cnNumber('十'), 10)
  assert.equal(cnNumber('十一'), 11)
  assert.equal(cnNumber('二十'), 20)
  assert.equal(cnNumber('三十一'), 31)
  assert.equal(cnNumber('两'), 2)
  assert.equal(cnNumber('九'), 9)
  assert.equal(cnNumber('很多'), undefined)
  assert.equal(cnNumber(''), undefined)
})

test('relative days resolve to the local calendar day', () => {
  assert.deepEqual(span('今天做了什么'), ['今天', at(2026, 9, 29), at(2026, 9, 30)])
  assert.deepEqual(span('昨天的报错'), ['昨天', at(2026, 9, 28), at(2026, 9, 29)])
  assert.deepEqual(span('前天那次改动'), ['前天', at(2026, 9, 27), at(2026, 9, 28)])
})

test('weeks start on Monday, the way 上周 is read', () => {
  // 2026-09-29 is a Tuesday, so this week starts on 2026-09-28.
  assert.deepEqual(span('上周做的迁移'), ['上周', at(2026, 9, 21), at(2026, 9, 28)])
  assert.deepEqual(span('本周的进度'), ['本周', at(2026, 9, 28), at(2026, 10, 5)])
})

test('months and years resolve to whole calendar periods', () => {
  assert.deepEqual(span('上个月的对账单'), ['上个月', at(2026, 8, 1), at(2026, 9, 1)])
  assert.deepEqual(span('去年定的规矩'), ['去年', at(2025, 1, 1), at(2026, 1, 1)])
  assert.deepEqual(span('明年的排期'), ['明年', at(2027, 1, 1), at(2028, 1, 1)])
})

test('a season is three months, and winter crosses the year boundary', () => {
  assert.deepEqual(span('去年春天在做什么'), ['去年春天', at(2025, 3, 1), at(2025, 6, 1)])
  assert.deepEqual(span('今年夏天'), ['今年夏天', at(2026, 6, 1), at(2026, 9, 1)])
  assert.deepEqual(span('今年冬天'), ['今年冬天', at(2026, 12, 1), at(2027, 3, 1)])
  assert.deepEqual(span('秋季的复盘'), ['秋季', at(2026, 9, 1), at(2026, 12, 1)])})

test('counted intervals distinguish "the last N" from "N ago"', () => {
  assert.deepEqual(span('最近三天'), ['最近三天', at(2026, 9, 27), NOW])
  assert.deepEqual(span('近 3 天'), ['近 3 天', at(2026, 9, 27), NOW])
  assert.deepEqual(span('过去两个月'), ['过去两个月', at(2026, 8, 1), NOW])
  assert.deepEqual(span('3 天前'), ['3 天前', at(2026, 9, 26), at(2026, 9, 27)])
  assert.deepEqual(span('两周前'), ['两周前', at(2026, 9, 14), at(2026, 9, 21)])
  assert.deepEqual(span('5 个月前'), ['5 个月前', at(2026, 4, 1), at(2026, 5, 1)])
})

test('absolute dates win over the looser rules', () => {
  assert.deepEqual(span('2026-09-20 那次事故'), ['2026-9-20', at(2026, 9, 20), at(2026, 9, 21)])
  assert.deepEqual(span('2026年9月20日'), ['2026-9-20', at(2026, 9, 20), at(2026, 9, 21)])
  assert.deepEqual(span('2026年9月'), ['2026-9', at(2026, 9, 1), at(2026, 10, 1)])
  assert.deepEqual(span('2026年'), ['2026年', at(2026, 1, 1), at(2027, 1, 1)])
  assert.deepEqual(span('9 月 20 日'), ['9月20日', at(2026, 9, 20), at(2026, 9, 21)])
  assert.deepEqual(span('去年 9 月'), ['去年9月', at(2025, 9, 1), at(2025, 10, 1)])
})

test('a bare month or season still resolves, a number with no unit does not', () => {
  assert.deepEqual(span('3 月做了什么'), ['3月', at(2026, 3, 1), at(2026, 4, 1)])
  // The unit is required, so 去年3个问题 is not last March — it is simply 去年.
  assert.deepEqual(span('去年3个问题'), ['去年', at(2025, 1, 1), at(2026, 1, 1)])
  // 月 as part of a word is not a date; 这个月 is.
  assert.equal(span('月度报告怎么写'), undefined)
  assert.deepEqual(span('这个月度报告'), ['这个月', at(2026, 9, 1), at(2026, 10, 1)])
})

test('turns that name no time resolve to nothing', () => {
  assert.equal(parseTimeRange('把混装的工作区改动拆成两笔提交', NOW), undefined)
  assert.equal(parseTimeRange('dsh-memories 注入摘要的排序是怎么算的', NOW), undefined)
  assert.equal(parseTimeRange('日志在哪里', NOW), undefined)
  assert.equal(parseTimeRange('', NOW), undefined)
})

test('within() is half-open and rejects missing timestamps', () => {
  const range = parseTimeRange('昨天', NOW)
  assert.ok(range !== undefined)
  assert.equal(within(at(2026, 9, 28), range), true)
  assert.equal(within(at(2026, 9, 28, 23), range), true)
  assert.equal(within(at(2026, 9, 29), range), false, 'the upper bound is exclusive')
  assert.equal(within(at(2026, 9, 27), range), false)
  assert.equal(within(undefined, range), false)
  assert.equal(within(0, range), false)
})

test('timeBoost lifts a measurement above a learning date, and never penalises', () => {
  const range = parseTimeRange('上周', NOW)
  const measured = entry('measured', { asOf: at(2026, 9, 22) })
  const learned = entry('learned', { createdAt: at(2026, 9, 22), updatedAt: at(2026, 9, 22) })
  const older = entry('older', { createdAt: at(2026, 3, 1), updatedAt: at(2026, 3, 1) })
  assert.equal(timeBoost(measured, range), TIME_MEASURED_BOOST)
  assert.equal(timeBoost(learned, range), TIME_CREATED_BOOST)
  assert.equal(timeBoost(older, range), 1, 'outside the window is still returned, just not lifted')
  assert.equal(timeBoost(measured, undefined), 1, 'a turn with no date changes nothing')
})

test('the window reorders entries that match the same words', () => {
  const inWindow = entry('alice-spring', {
    title: 'Alice 在做异步改造',
    body: 'Alice 那阵子在改异步数据库调用。',
    createdAt: at(2025, 4, 10),
    updatedAt: at(2025, 4, 10),
  })
  const outOfWindow = entry('alice-winter', {
    title: 'Alice 在做异步改造',
    body: 'Alice 那阵子在改异步数据库调用。',
    createdAt: at(2025, 11, 10),
    updatedAt: at(2025, 11, 10),
  })
  const query = 'Alice 去年春天在做什么'
  assert.equal(relevanceOf(inWindow, query), relevanceOf(outOfWindow, query), 'same lexical evidence')
  const ranked = [outOfWindow, inWindow].sort((a, b) => scoreEntry(b, query, NOW) - scoreEntry(a, query, NOW))
  assert.deepEqual(ranked.map((item) => item.id), ['alice-spring', 'alice-winter'])
})

test('a turn with no date leaves the ordering untouched', () => {
  const older = entry('older', { createdAt: at(2026, 6, 1), updatedAt: at(2026, 6, 1) })
  const newer = entry('newer', { createdAt: NOW - DAY, updatedAt: NOW - DAY })
  const query = 'Alice 在做异步改造'
  const withoutDate = [newer, older].sort((a, b) => scoreEntry(b, query, NOW) - scoreEntry(a, query, NOW))
  const withDate = [newer, older].sort((a, b) => scoreEntry(b, `${query} 上周`, NOW) - scoreEntry(a, `${query} 上周`, NOW))
  assert.deepEqual(withoutDate.map((item) => item.id), withDate.map((item) => item.id))
})

test('the summary tier orders its in-window entries ahead of equally scored ones', () => {
  const query = '上个月那个发票接口的问题怎么解决的'
  const old = entry('invoice-old', {
    title: '发票接口的问题',
    body: '发票接口返回 500，最后发现是发票号码字段为空。',
    createdAt: at(2026, 3, 1),
    updatedAt: at(2026, 3, 1),
  })
  const recent = entry('invoice-recent', {
    title: '发票接口的问题',
    body: '发票接口返回 500，最后发现是发票号码字段为空。',
    createdAt: at(2026, 8, 20),
    updatedAt: at(2026, 8, 20),
  })
  assert.deepEqual(rankForSummary([old, recent], NOW, query).map((item) => item.id), ['invoice-recent', 'invoice-old'])
})
