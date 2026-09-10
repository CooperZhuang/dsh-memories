#!/usr/bin/env node
/**
 * Offline extraction eval.
 *
 * The extractor's prompt is the highest-leverage text in this plugin and the
 * hardest thing to change safely, because a live run costs quota and there are
 * no fixtures for "the model read the session the way a person would". This
 * harness closes the loop cheaply: capture a real reply once, pin what it must
 * contain, and re-score it on every prompt change.
 *
 * A fixture is one JSON file under `eval/`:
 *
 *   {
 *     "name": "pnpm-workspace-session",
 *     "maxMemories": 5,
 *     "transcript": "...",            // for the reader, not scored
 *     "reply": "{\"summary\":...,\"memories\":[...]}",   // what the model returned
 *     "expected": [{ "scope": "project", "title": "Prefer pnpm workspaces" }],
 *     "forbidden": ["sk-"]            // text that must never survive redaction
 *   }
 *
 * Scoring runs the real parser (`parseExtraction`, including secret redaction),
 * matches produced drafts to expected ones by title overlap (so a re-worded
 * title still counts), and reports recall and precision.
 *
 * Usage:
 *   node scripts/eval-extract.mjs [fixtureDir] [--min-recall=0.8]
 *
 * @module dsh-memories/scripts/eval-extract
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExtraction } from '../lib/extract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = resolve(HERE, '..', 'eval')

/** Split text into lowercase tokens for a loose title comparison. */
function tokens(text) {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length > 1))
}

/** Jaccard overlap, so a re-worded title still counts as a hit. */
function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** Whether one produced draft covers one expected memory. */
function matches(draft, expected) {
  return draft.scope === expected.scope && overlap(tokens(draft.title), tokens(expected.title)) >= 0.5
}

/** Every fixture in a directory, sorted by name. */
async function loadFixtures(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort()
  const fixtures = []
  for (const name of names) {
    fixtures.push({ name, ...JSON.parse(await readFile(join(dir, name), 'utf8')) })
  }
  return fixtures
}

/** Score one fixture against what its reply must contain. */
function score(fixture) {
  const maxMemories = fixture.maxMemories ?? 5
  const parsed = parseExtraction(fixture.reply, maxMemories, 'eval')
  const expected = fixture.expected ?? []
  const used = new Set()
  let hit = 0
  for (const want of expected) {
    const index = parsed.drafts.findIndex((draft, position) => !used.has(position) && matches(draft, want))
    if (index >= 0) {
      used.add(index)
      hit += 1
    }
  }
  const produced = parsed.drafts.length
  return {
    produced,
    expected: expected.length,
    hit,
    recall: expected.length === 0 ? 1 : hit / expected.length,
    precision: produced === 0 ? (expected.length === 0 ? 1 : 0) : hit / produced,
    leaked: (fixture.forbidden ?? []).filter((secret) => JSON.stringify(parsed).includes(secret)),
  }
}

const args = process.argv.slice(2)
const floorArg = args.find((arg) => arg.startsWith('--min-recall='))
const floor = floorArg === undefined ? 1 : Number(floorArg.slice('--min-recall='.length))
const dir = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_DIR

const fixtures = await loadFixtures(dir)
if (fixtures.length === 0) {
  console.error(`dsh-memories: no eval fixtures in ${dir}`)
  process.exit(2)
}

console.log(`extraction eval: ${fixtures.length} fixture(s) from ${dir}, recall floor ${floor}`)
let failed = 0
for (const fixture of fixtures) {
  const row = score(fixture)
  const ok = row.recall >= floor && row.leaked.length === 0
  if (!ok) failed += 1
  console.log([
    ok ? 'ok  ' : 'FAIL',
    String(fixture.name).padEnd(28),
    `recall ${row.recall.toFixed(2)}`,
    `precision ${row.precision.toFixed(2)}`,
    `(${row.hit}/${row.expected} expected, ${row.produced} produced)`,
  ].join(' '))
  for (const secret of row.leaked) console.log(`     leaked ${secret} past redaction`)
}
console.log(failed === 0 ? 'all fixtures met the floor' : `${failed} fixture(s) below the floor`)
process.exit(failed === 0 ? 0 : 1)
