/**
 * Offline retrieval eval against a REAL memory store.
 *
 * The unit tests in `src/test/eval.test.ts` run on hand-built corpora: they prove
 * the scorer behaves as designed, and they can never say whether the design is
 * worth anything on the store this plugin actually serves. This script closes
 * that gap. It reads `$DSH_HOME/memories` read-only, runs a labelled probe file
 * against it, and reports every probe under three configurations:
 *
 * | config    | time channel | one-hop expansion | what it is |
 * | ---       | ---          | ---               | --- |
 * | `lexical` | off          | off               | the retriever as it was before 2026-09-29 |
 * | `time`    | on           | off               | temporal range only |
 * | `full`    | on           | on                | what the model and the injector actually get |
 *
 * The difference between the columns is the honest answer to "how much did those
 * two mechanisms buy on real memories".
 *
 * Probes are labelled by hand and live OUTSIDE the repository
 * (`eval/retrieval.local.json`, gitignored) because they quote real memory ids
 * and the repo is public. The shape is:
 *
 * ```json
 * {
 *   "probes": [
 *     {
 *       "id": "belief-1",
 *       "shape": "belief",
 *       "scopes": ["global", "project:dsh-memories-714ebfcf"],
 *       "query": "改这个插件的代码要不要重启宿主",
 *       "expect": ["some-real-id"],
 *       "mode": "first",
 *       "premise": "unreachable",
 *       "note": "why that entry is the right answer"
 *     }
 *   ]
 * }
 * ```
 *
 * `mode: "first"` demands rank 1; `mode: "include"` demands presence in the top
 * `--top`. `premise: "unreachable"` asserts that every expected entry has ZERO
 * lexical relevance to the query — without that, a "hit" could be an ordinary
 * match and the probe would prove nothing about the hop.
 *
 * Usage:
 *
 * ```bash
 * node scripts/eval-retrieval.mjs                          # eval/retrieval.local.json
 * node scripts/eval-retrieval.mjs --probes=path.json --top=5 --verbose
 * node scripts/eval-retrieval.mjs --min-full=0.8           # exit 1 below the floor
 * ```
 *
 * @module dsh-memories/scripts/eval-retrieval
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntry } from '../lib/storage.js'
import { scoreEntry, searchMemories } from '../lib/search.js'

/** Where the memory store lives. */
function storeRoot() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Every entry of one scope, parsed read-only. */
function loadScope(scope) {
  const root = join(storeRoot(), 'memories')
  const name = scope.replace(/^project:/u, '')
  const dir = scope === 'global' ? join(root, 'entries') : join(root, 'projects', name, 'entries')
  if (!existsSync(dir)) return []
  const kind = scope === 'global' ? 'global' : 'project'
  const entries = []
  for (const file of readdirSync(dir).filter((fileName) => fileName.endsWith('.md'))) {
    const entry = parseEntry(readFileSync(join(dir, file), 'utf8'), kind, file.replace(/\.md$/u, ''))
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * Rank the scopes the way `searchMemories` does, minus what the config turns off.
 *
 * The `lexical` column cannot go through `searchMemories`: the time channel is
 * not optional there, and adding a production switch that only an eval ever sets
 * would be worse than the ten lines below. `scoreEntry` takes the window as an
 * argument, so passing `null` is exactly "no window" — the same call the search
 * path makes, with one term removed.
 */
function rank(groups, query, config, limit, now) {
  if (config.time) {
    return searchMemories(groups, query, { limit, now, ...config.expand ? { expand: true } : {} })
  }
  const hits = []
  for (const group of groups) {
    for (const entry of group.entries) {
      const score = scoreEntry(entry, query, now, null)
      if (score > 0) hits.push({ entry, score })
    }
  }
  hits.sort((left, right) => right.score - left.score
    || right.entry.updatedAt - left.entry.updatedAt
    || left.entry.title.localeCompare(right.entry.title))
  return hits.slice(0, limit)
}

/** Parse `--flag=value` arguments. */
function options(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(arg)
    if (match !== null) flags[match[1]] = match[2] ?? 'true'
  }
  return flags
}

const flags = options(process.argv.slice(2))
const here = fileURLToPath(new URL('..', import.meta.url))
const probePath = flags.probes ?? join(here, 'eval', 'retrieval.local.json')
const top = Number(flags.top ?? 3)
const now = flags.now === undefined ? Date.now() : Number(flags.now)
if (!existsSync(probePath)) {
  console.error(`No probe file at ${probePath}.`)
  console.error('Copy eval/retrieval.example.json to eval/retrieval.local.json and label it against your own store.')
  process.exit(2)
}
const probes = JSON.parse(readFileSync(probePath, 'utf8')).probes ?? []
const CONFIGS = [
  { name: 'lexical', time: false, expand: false },
  { name: 'time', time: true, expand: false },
  { name: 'full', time: true, expand: true },
]

const cache = new Map()
const entriesOf = (scope) => {
  if (!cache.has(scope)) cache.set(scope, loadScope(scope))
  return cache.get(scope)
}

const perShape = new Map()
let failed = 0
for (const probe of probes) {
  const scopes = Array.isArray(probe.scopes) ? probe.scopes : [probe.scope ?? 'global']
  const groups = scopes.map((scope) => ({ scope: scope.startsWith('project:') ? 'project' : 'global', label: scope, entries: entriesOf(scope) }))
  const entries = groups.flatMap((group) => group.entries)
  if (entries.length === 0) {
    console.log(`✗ ${probe.id} — no entries in ${scopes.join(', ')}`)
    failed += 1
    continue
  }
  const wanted = probe.expect ?? []
  const mode = probe.mode ?? 'include'
  const ranked = {}
  for (const config of CONFIGS) {
    const ids = rank(groups, probe.query, config, top, now).map((hit) => hit.entry.id)
    const at = wanted.map((id) => {
      const index = ids.indexOf(id)
      return index < 0 ? undefined : index + 1
    })
    const ok = wanted.length === 0
      ? true
      : mode === 'first' ? at[0] === 1 : at.every((index) => index !== undefined)
    ranked[config.name] = { ids, at, ok }
  }
  // The premise of a hop probe, stated operationally: lexical retrieval alone
  // does NOT return the expected entry in the top N. Exact zero relevance would
  // be the wrong test — a memory that shares one word and lands at rank 40 is
  // unreachable in every sense that matters, and demanding zero would reject the
  // very cases the hop exists for.
  const premise = probe.premise !== 'unreachable'
    ? undefined
    : wanted.every((id) => !ranked.lexical.ids.includes(id))
  const marks = []
  const detail = []
  for (const config of CONFIGS) {
    marks.push(`${config.name}:${ranked[config.name].ok ? '✓' : '✗'}`)
    detail.push(`    ${config.name.padEnd(8)} rank=${JSON.stringify(ranked[config.name].at)} top=${JSON.stringify(ranked[config.name].ids)}`)
  }
  const bucket = perShape.get(probe.shape) ?? { total: 0, lexical: 0, time: 0, full: 0 }
  bucket.total += 1
  for (const config of CONFIGS) if (ranked[config.name].ok) bucket[config.name] += 1
  perShape.set(probe.shape, bucket)
  console.log(`· ${String(probe.id).padEnd(16)} ${String(probe.shape).padEnd(10)} ${marks.join('  ')}   ${JSON.stringify(probe.query)}`)
  if (probe.note !== undefined) console.log(`    why: ${probe.note}`)
  if (premise === false) console.log('    ⚠ premise broken: lexical retrieval already returns an expected id, so this probe does not test the hop')
  if (premise === true) console.log(`    premise holds: lexical retrieval does not return it in the top ${top}`)
  if (flags.verbose !== undefined) console.log(detail.join('\n'))
}

const sum = [...perShape.values()].reduce((acc, bucket) => ({
  total: acc.total + bucket.total, lexical: acc.lexical + bucket.lexical, time: acc.time + bucket.time, full: acc.full + bucket.full,
}), { total: 0, lexical: 0, time: 0, full: 0 })
console.log('\nper shape (ok / total)')
for (const [shape, bucket] of perShape) {
  console.log(`  ${shape.padEnd(10)} lexical ${bucket.lexical}/${bucket.total}   time ${bucket.time}/${bucket.total}   full ${bucket.full}/${bucket.total}`)
}
console.log(`  ${'ALL'.padEnd(10)} lexical ${sum.lexical}/${sum.total}   time ${sum.time}/${sum.total}   full ${sum.full}/${sum.total}`)
console.log(`\nstore: ${[...cache.entries()].map(([scope, list]) => `${scope}=${list.length}`).join('  ')}`)

// How much material the hop actually has. A scope whose entries share two links
// with everything is a scope where the hop adds noise; one where nothing shares
// two links is a scope where it can never fire. Both are worth knowing before
// trusting (or tuning) the mechanism.
if (flags.links !== undefined) {
  console.log('\none-hop edge census')
  for (const [scope, entries] of cache.entries()) {
    const linksOf = (entry) => new Set([...entry.keys, ...entry.tags].map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))
    const frequency = new Map()
    for (const entry of entries) for (const link of linksOf(entry)) frequency.set(link, (frequency.get(link) ?? 0) + 1)
    const generic = new Set([...frequency.entries()].filter(([, count]) => count > entries.length * 0.2).map(([link]) => link))
    // A link on more than half the scope is the scope's own name, not an edge —
    // the rule the hop now applies. Counting both ways shows how much of the
    // graph was noise before it.
    const ubiquitous = new Set([...frequency.entries()].filter(([, count]) => count > entries.length * 0.5).map(([link]) => link))
    let pairs = 0
    let genericPairs = 0
    let firingPairs = 0
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const shared = [...linksOf(entries[left])].filter((link) => linksOf(entries[right]).has(link))
        if (shared.length < 2) continue
        pairs += 1
        if (shared.every((link) => generic.has(link))) genericPairs += 1
        if (shared.filter((link) => !ubiquitous.has(link)).length >= 2) firingPairs += 1
      }
    }
    const worst = [...frequency.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4)
    console.log(`  ${scope}: ${entries.length} entries, ${pairs} hop-able pairs, ${genericPairs} on generic links only, ${firingPairs} still fire after the rarity rule`)
    console.log(`    most common links: ${worst.map(([link, count]) => `${link}×${count}`).join(', ')}`)
  }
}

for (const key of ['lexical', 'time', 'full']) {
  const floor = flags[`min-${key}`]
  if (floor === undefined) continue
  const rate = sum.total === 0 ? 0 : sum[key] / sum.total
  if (rate < Number(floor)) {
    console.error(`\n${key} hit rate ${rate.toFixed(2)} is below the floor ${floor}`)
    process.exit(1)
  }
}
if (failed > 0) process.exit(1)
