/**
 * Tests for the one-hop expansion: following the keys and tags the direct hits
 * are filed under.
 *
 * The corpus is built so that the related entries share *no word* with the
 * query — if they did, they would be ordinary hits and the expansion would be
 * untestable. That is also the property the feature has to have: a hop must
 * never be presented as a match.
 *
 * @module dsh-memories/test/expand.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPAND_FACTOR, EXPAND_MAX, relatedHits, searchMemories } from '../search.js'
import { renderHit } from '../render.js'
import type { MemoryEntry, MemoryKind } from '../types.js'
import type { ScopeEntries } from '../search.js'

/** Fixed clock so decay never decides these assertions. */
const NOW = new Date(2026, 8, 29, 19, 0, 0).getTime()

/** One corpus entry. */
function entry(id: string, title: string, body: string, extra: Partial<MemoryEntry> = {}, kind: MemoryKind = 'fact'): MemoryEntry {
  return {
    id,
    scope: 'global',
    kind,
    title,
    body,
    tags: [],
    keys: [],
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...extra,
  }
}

/** The seed, plus two entries filed under the same keys and one under a single key. */
const SEED = entry('state-db', 'SQLite 状态库在哪', '状态库放在 DSH_HOME 下。', { keys: ['state.db', 'sqlite'] })
const NEIGHBOUR = entry('leases', '任务租约与水位线', '水位线和任务租约都记在那个库里，重启后仍然有效。', { keys: ['state.db', 'sqlite'], updatedAt: NOW - 3_600_000 })
const NEIGHBOUR_BY_TAG = entry('watermarks', '后台抽取的水位线', '每个会话一条水位线，记录抽到哪一条消息。', { tags: ['state.db', 'sqlite'] })
const WEAK_LINK = entry('weak', '只共用一个 key 的记忆', '它只提到那个库一次。', { keys: ['state.db'] })
const GROUPS: readonly ScopeEntries[] = [{ scope: 'global', label: 'global', entries: [SEED, NEIGHBOUR, NEIGHBOUR_BY_TAG, WEAK_LINK] }]

test('a hop needs two shared links, not one', () => {
  const hits = searchMemories(GROUPS, '状态库', { expand: true, now: NOW, limit: 10 })
  const ids = hits.map((hit) => hit.entry.id)
  assert.equal(ids[0], 'state-db', 'the direct hit still comes first')
  assert.ok(ids.includes('leases'), 'two shared keys are a link')
  assert.ok(ids.includes('watermarks'), 'two shared tags are a link too')
  assert.ok(!ids.includes('weak'), 'one shared key is not')
})

test('an unexpanded search returns only what matched', () => {
  assert.deepEqual(searchMemories(GROUPS, '状态库', { now: NOW, limit: 10 }).map((hit) => hit.entry.id), ['state-db'])
})

test('every related hit ranks below every direct hit, at the documented fraction', () => {
  const hits = searchMemories(GROUPS, '状态库', { expand: true, now: NOW, limit: 10 })
  const direct = hits.filter((hit) => hit.via === undefined)
  const related = hits.filter((hit) => hit.via !== undefined)
  assert.equal(direct.length, 1)
  assert.ok(related.length > 0)
  const weakestDirect = Math.min(...direct.map((hit) => hit.score))
  for (const hit of related) {
    assert.ok(hit.score < weakestDirect, 'a hop can fill a slot, never take one')
    assert.equal(hit.via, 'state-db', 'the seed it came from is reported')
  }
  // Two shared links is the weakest hop: half the allowance.
  const two = related.find((hit) => hit.entry.id === 'leases')
  assert.ok(two !== undefined)
  assert.ok(Math.abs(two.score - weakestDirect * EXPAND_FACTOR * 0.5) < 1e-9)
})

test('expansion never grows the result past the limit', () => {
  const crowded: MemoryEntry[] = [SEED]
  for (let index = 0; index < 6; index += 1) {
    crowded.push(entry(`n${index}`, `邻居 ${index}`, '同样是那个库的记录。', { keys: ['state.db', 'sqlite'] }))
  }
  const groups: readonly ScopeEntries[] = [{ scope: 'global', label: 'global', entries: crowded }]
  const hits = searchMemories(groups, '状态库', { expand: true, now: NOW, limit: 10 })
  assert.equal(hits.length, 1 + EXPAND_MAX)
})

test('expansion respects the scope and kind filters it was given', () => {
  const projectCopy = entry('project-lease', '项目里的租约', '同样的东西，不同的作用域。', { scope: 'project', keys: ['state.db', 'sqlite'] })
  const groups: readonly ScopeEntries[] = [
    { scope: 'global', label: 'global', entries: [SEED, NEIGHBOUR] },
    { scope: 'project', label: 'project:x', entries: [projectCopy] },
  ]
  const scoped = searchMemories(groups, '状态库', { expand: true, now: NOW, limit: 10, scopes: ['global'] })
  assert.deepEqual(scoped.map((hit) => hit.entry.id), ['state-db', 'leases'])
  const kinds = searchMemories(groups, '状态库', { expand: true, now: NOW, limit: 10, kinds: ['procedure'] })
  assert.deepEqual(kinds, [], 'a filtered search does not smuggle entries back in')
})

test('relatedHits reports the seed and can be bounded directly', () => {
  const seeds = [{ entry: SEED, score: 100 }]
  const related = relatedHits(GROUPS, seeds, { limit: 1 })
  assert.equal(related.length, 1)
  assert.equal(related[0]?.entry.id, 'leases', 'the strongest hop wins the single slot')
  assert.equal(related[0]?.via, 'state-db')
  assert.deepEqual(relatedHits(GROUPS, []), [], 'no seeds, no hops')
})

test('a related hit is marked in the rendering', () => {
  const direct = renderHit({ entry: SEED, score: 10 }, 0)
  const hop = renderHit({ entry: NEIGHBOUR, score: 4, via: 'state-db' }, 1)
  assert.ok(!direct.includes('via='))
  assert.ok(hop.includes('via=state-db'), hop)
})

test('a hop is scored from the seed that lit it up, not from the weakest seed', () => {
  // The real-store eval forced this: pegging every hop to the weakest of the top
  // three put the best match's neighbours below entries that shared one word
  // with the turn. Activation spreads from the node that fired.
  const strong = entry('strong', '强命中', '正文。', { keys: ['k1', 'k2'] })
  const weak = entry('weak-seed', '弱命中', '正文。', { keys: ['k3', 'k4'] })
  const nearStrong = entry('near-strong', '强种子的邻居', '正文。', { keys: ['k1', 'k2'] })
  const nearWeak = entry('near-weak', '弱种子的邻居', '正文。', { keys: ['k3', 'k4'] })
  const groups: readonly ScopeEntries[] = [{ scope: 'global', label: 'global', entries: [nearStrong, nearWeak] }]
  const related = relatedHits(groups, [{ entry: strong, score: 100 }, { entry: weak, score: 20 }], {})
  assert.deepEqual(related.map((hit) => [hit.entry.id, hit.score, hit.via]), [
    ['near-strong', 100 * EXPAND_FACTOR * 0.5, 'strong'],
    ['near-weak', 20 * EXPAND_FACTOR * 0.5, 'weak-seed'],
  ])
})

test('a weak direct hit is upgraded by the hop, and never marked as a hop', () => {
  // The eval found this too: the eighth direct hit is exactly the entry a hop
  // can lift, and "already a direct hit" must not disqualify it — but it did
  // match the query, so it must not be labelled `via` either.
  const keys = ['k1', 'k2', 'k3', 'k4']
  const seed = entry('seed', '状态库放在哪里', '状态库的位置记在这里。', { keys })
  const weakHit = entry('weak-hit', '另有一条', '正文里提了一句状态库。', { keys })
  // Three entries that outrank the weak hit, so it is not itself one of the
  // seeds: a seed is excluded from the hop, and with a two-entry corpus the
  // thing under test would have been its own seed.
  const fillers = [1, 2, 3].map((index) => entry(`filler-${index}`, `状态库相关 ${index}`, '无关正文。'))
  const groups: readonly ScopeEntries[] = [{ scope: 'global', label: 'global', entries: [seed, weakHit, ...fillers] }]
  const plain = searchMemories(groups, '状态库', { now: NOW, limit: 5 })
  const expanded = searchMemories(groups, '状态库', { now: NOW, limit: 5, expand: true })
  const before = plain.find((hit) => hit.entry.id === 'weak-hit')
  const after = expanded.find((hit) => hit.entry.id === 'weak-hit')
  assert.ok(before !== undefined && after !== undefined)
  assert.ok(after.score > before.score, 'the hop lifted an entry the query matched only weakly')
  assert.equal(after.via, undefined, 'it matched the query, so it is not a hop result')
  const seedScore = expanded.find((hit) => hit.entry.id === 'seed')?.score ?? 0
  assert.equal(after.score, seedScore * EXPAND_FACTOR, 'four shared links earn the full allowance')
})
