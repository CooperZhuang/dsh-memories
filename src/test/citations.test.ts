/**
 * Tests for the citation check.
 *
 * The rule under test is what makes "this memory points at a file that no longer
 * exists" visible without turning every cross-checkout reference into noise.
 *
 * @module dsh-memories/test/citations.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { citationRoots, citationWarning, extractCitations, missingCitations } from '../citations.js'

/** A probe backed by a set of paths, so the rule is tested without a filesystem. */
function probe(paths: readonly string[]) {
  const normalized = new Set(paths.map((path) => path.replace(/\\/gu, '/').toLowerCase()))
  return (path: string) => normalized.has(path.replace(/\\/gu, '/').toLowerCase())
}

test('extractCitations keeps real relative paths and drops prose', () => {
  const body = 'Report lives at output/market_report.json, script at ./scripts/verify_all.py, and/or in tools/check.py.'
  assert.deepEqual(extractCitations(body), ['output/market_report.json', 'scripts/verify_all.py', 'tools/check.py'])
  assert.deepEqual(extractCitations('config.ts/index.ts/consolidate.ts'), [], 'a slash-joined list is not a path')
  assert.deepEqual(extractCitations('see https://example.com/a/b.js'), [])
  assert.deepEqual(extractCitations('a single index.js is not checkable'), [])
  assert.deepEqual(extractCitations('fonts live in app/.tools and are installed'), [], 'a hidden directory is not a file')
})

test('a citation is reported only when its directory exists but the file does not', () => {
  const roots = ['C:\\repo']
  const exists = probe(['C:/repo/output', 'C:/repo/output/other.json'])
  // The directory is there, the cited file is not: that is evidence of deletion.
  assert.deepEqual(missingCitations('the report is output/market_report.json', roots, exists), ['output/market_report.json'])
  // The whole directory is unknown: this checkout may simply not be the one the
  // memory was written in, so the check stays silent.
  assert.deepEqual(missingCitations('the report is elsewhere/market_report.json', roots, exists), [])
})

test('a citation that resolves is never reported', () => {
  const roots = ['C:\\repo']
  const exists = probe(['C:/repo/scripts/verify_all.py'])
  assert.deepEqual(missingCitations('run scripts/verify_all.py', roots, exists), [])
})

test('nothing is checked without a root', () => {
  assert.deepEqual(missingCitations('the report is output/x.json', [], probe([])), [])
})

test('citationRoots puts the project first and de-duplicates', () => {
  assert.deepEqual(citationRoots('C:\\repo', ['C:\\repo', 'C:\\home']), ['C:\\repo', 'C:\\home'])
  assert.deepEqual(citationRoots(undefined, ['C:\\home']), ['C:\\home'])
})

test('the warning names at most two paths and counts the rest', () => {
  assert.equal(citationWarning([]), '')
  assert.match(citationWarning(['a/b.py']), /a\/b\.py/u)
  assert.match(citationWarning(['a/b.py', 'c/d.py', 'e/f.py']), /等 3 处/u)
})
