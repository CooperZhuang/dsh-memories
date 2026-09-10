/**
 * Tests for the timing rules: how long a session waits to settle, and which
 * hours the plugin may spend tokens in.
 *
 * Providers price by time of day — DeepSeek doubles its rate on weekday mornings
 * and afternoons (Beijing time) and halves it everywhere else — so these two
 * calculations are what the plugin's entire cost profile hangs on. Both are pure
 * functions with an injected clock, which is why they live in their own module.
 *
 * @module dsh-memories/test/schedule
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../config.js'
import { backgroundDelayMs, extractionDelayMs, formatDelay, parsePeakHours, peakDelayMs, withinWindow } from '../schedule.js'

/** The DeepSeek rule this feature was written for: weekday mornings and afternoons. */
const DEEPSEEK_PEAK = 'Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00'

/** A date on a given weekday at a given local time, so tests never guess. */
function at(weekday: number, hour: number, minute = 0): Date {
  const date = new Date(2026, 8, 1, hour, minute, 0, 0)
  while (date.getDay() !== weekday) date.setDate(date.getDate() + 1)
  return date
}

test('a peak spec parses days, times, and reports what it could not read', () => {
  const parsed = parsePeakHours(DEEPSEEK_PEAK)
  assert.deepEqual(parsed.invalid, [])
  assert.equal(parsed.windows.length, 2)
  assert.deepEqual([...parsed.windows[0]?.days ?? []].sort(), [1, 2, 3, 4, 5])
  assert.equal(parsed.windows[0]?.from, 9 * 60)
  assert.equal(parsed.windows[0]?.to, 12 * 60)
  assert.equal(parsed.windows[1]?.from, 14 * 60)

  // Day spellings and shapes.
  assert.deepEqual([...parsePeakHours('* 09:00-10:00').windows[0]?.days ?? []].sort(), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual([...parsePeakHours('09:00-10:00').windows[0]?.days ?? []].sort(), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual([...parsePeakHours('Mon+Wed 09:00-10:00').windows[0]?.days ?? []].sort(), [1, 3])
  assert.deepEqual([...parsePeakHours('Sat-Mon 09:00-10:00').windows[0]?.days ?? []].sort(), [0, 1, 6])
  assert.deepEqual([...parsePeakHours('sat 22:00-02:00').windows[0]?.days ?? []], [6])

  // An empty spec is "never peak"; nonsense is reported rather than swallowed.
  assert.deepEqual(parsePeakHours('   ').windows, [])
  const broken = parsePeakHours('Mon-Fri 9-12, Xyz 09:00-10:00, Mon-Fri 09:00-09:00')
  assert.equal(broken.windows.length, 0)
  assert.equal(broken.invalid.length, 3)
})

test('a peak window covers exactly its own minutes, on exactly its own days', () => {
  const windows = parsePeakHours(DEEPSEEK_PEAK).windows
  const inside = (date: Date): boolean => windows.some((window) => withinWindow(window, date))
  // 2026-09-01 is a Tuesday, and `at` walks forward from it.
  assert.equal(inside(at(2, 9, 0)), true, 'the first minute counts')
  assert.equal(inside(at(2, 11, 59)), true)
  assert.equal(inside(at(2, 12, 0)), false, 'the last minute does not')
  assert.equal(inside(at(2, 13, 0)), false, 'the lunch gap is off-peak')
  assert.equal(inside(at(2, 14, 0)), true)
  assert.equal(inside(at(2, 18, 0)), false)
  assert.equal(inside(at(2, 3, 0)), false, 'nights are off-peak')
  assert.equal(inside(at(6, 10, 0)), false, 'weekends are entirely off-peak')
  assert.equal(inside(at(0, 15, 0)), false)
})

test('peakDelayMs reports the wait to the end of the window, and 0 when free', () => {
  assert.equal(peakDelayMs('', at(2, 10, 0)), 0, 'an empty spec never defers')
  assert.equal(peakDelayMs(DEEPSEEK_PEAK, at(2, 8, 59)), 0)
  assert.equal(peakDelayMs(DEEPSEEK_PEAK, at(2, 10, 0)), 120 * 60_000 + 1_000)
  assert.equal(peakDelayMs(DEEPSEEK_PEAK, at(2, 11, 59)), 61_000, 'one minute left, plus the boundary tick')
  assert.equal(peakDelayMs(DEEPSEEK_PEAK, at(6, 10, 0)), 0)
  // A window that crosses midnight ends the next morning, not tonight.
  assert.equal(peakDelayMs('Sat 22:00-02:00', at(6, 23, 0)), 3 * 3_600_000 + 1_000)
  assert.equal(peakDelayMs('Sat 22:00-02:00', at(0, 1, 0)), 3_600_000 + 1_000)
})

test('the settle delay is the larger of the two waits, fractions included', () => {
  // Scheduling for `autoExtractIdleMs` alone produced a pass that could never
  // satisfy `minIdleHours`, and the timer is never re-armed — so with the old
  // defaults (5 minutes against 6 hours) stage 1 never ran at all.
  assert.equal(extractionDelayMs({ autoExtractIdleMs: 300_000, minIdleHours: 6 }), 6 * 3_600_000)
  assert.equal(extractionDelayMs({ autoExtractIdleMs: 300_000, minIdleHours: 0 }), 300_000)
  assert.equal(extractionDelayMs({ autoExtractIdleMs: 300_000, minIdleHours: 0.5 }), 30 * 60_000)
  assert.equal(extractionDelayMs({ autoExtractIdleMs: 8 * 3_600_000, minIdleHours: 6 }), 8 * 3_600_000)
})

test('the combined delay also waits out a peak window', () => {
  const settings = { autoExtractIdleMs: 300_000, minIdleHours: 0.5, peakHours: DEEPSEEK_PEAK }
  assert.equal(backgroundDelayMs(settings, at(2, 10, 0)), 120 * 60_000 + 1_000, 'peak dominates a 30 minute wait')
  assert.equal(backgroundDelayMs(settings, at(2, 3, 0)), 30 * 60_000, 'off-peak falls back to the settle wait')
})

test('formatDelay reads the way a person would say it', () => {
  assert.equal(formatDelay(45_000), '45s')
  assert.equal(formatDelay(300_000), '5m')
  assert.equal(formatDelay(1_800_000), '30m')
  assert.equal(formatDelay(6 * 3_600_000), '6h')
  assert.equal(formatDelay(6.5 * 3_600_000), '6h30m')
})

test('the hour knobs keep fractions instead of truncating them to zero', () => {
  // `minIdleHours: 0.5` used to be truncated to 0, silently disabling the gate
  // the user was trying to tighten.
  const settings = normalizeSettings({ minIdleHours: 0.5, consolidateCooldownHours: 1.5, sweepIntervalHours: 0.5 })
  assert.equal(settings.minIdleHours, 0.5)
  assert.equal(settings.consolidateCooldownHours, 1.5)
  assert.equal(settings.sweepIntervalHours, 0.5)
  assert.equal(normalizeSettings({ minIdleHours: -1 }).minIdleHours, 0, 'still clamps at zero')
  assert.equal(normalizeSettings({ peakHours: '  Mon-Fri   09:00-12:00  ' }).peakHours, 'Mon-Fri 09:00-12:00')
})
