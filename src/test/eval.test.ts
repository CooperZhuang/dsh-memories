/**
 * The retrieval eval: does a query still find its memory?
 *
 * LongMemEval frames long-term memory as indexing → retrieval → reading and
 * finds most of the win in how keys are built, not in how exotic the store is.
 * This corpus is the cheap, offline half of that: fixed memories, fixed
 * queries, a hit-rate floor. It runs in the normal suite, so changing the
 * scoring formula or the extraction prompts has to face it.
 *
 * Keep the corpus honest: entries should read like real memories, and every
 * query should be phrased the way a future session would actually ask.
 *
 * @module dsh-memories/test/eval.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { relevanceOf, searchMemories } from '../search.js'
import type { MemoryEntry, MemoryKind } from '../types.js'

/** Build one corpus entry. */
function entry(id: string, title: string, body: string, tags: string[] = [], keys: string[] = [], kind: MemoryKind = 'fact'): MemoryEntry {
  return { id, scope: 'global', kind, title, body, tags, keys, createdAt: 0, updatedAt: 0, uses: 0, lastUsedAt: 0, lastSurfacedAt: 0, source: 'auto' }
}

/** The fixed corpus every query is ranked against. */
const CORPUS: readonly MemoryEntry[] = [
  entry('prefer-pnpm-workspaces', 'Prefer pnpm workspaces', 'The repository is one pnpm workspace with several packages; do not run npm install.', ['tooling'], ['monorepo']),
  entry('run-the-test-suite', 'Run the test suite', 'Use node --test for the unit suite; the web tests run through vitest.', ['testing']),
  entry('rimworld-mod-defs', 'RimWorld mod defs', 'Defs live under About/Defs and load through PatchOperations.', ['rimworld'], ['环世界']),
  entry('restart-dsh-web', 'Restart dsh web', 'POST /dsh-market/api/v1/restart restarts the web server without a cookie.', ['dsh'], ['dshmarket']),
  entry('plugin-build-order', 'Plugin build order', 'Run tsc before build-client.mjs, or the client bundle drifts from the host.', ['plugin', 'build']),
  entry('answer-in-chinese', 'Answer in Chinese', 'The user writes Chinese, so answer in Chinese by default.', ['preference']),
  entry('windows-path-separators', 'Windows path separators', 'Use native backslash paths in PowerShell commands, not forward slashes.', ['windows']),
  entry('never-commit-credentials', 'Never commit credentials', 'Redact tokens and keys before anything is written to the memory store.', ['security']),
  entry('state-lives-in-sqlite', 'State lives in SQLite', 'Watermarks, job leases, and usage counters live in state.db, not in JSON.', ['dsh', 'sqlite']),
  entry('promote-skill-drafts', 'Promote skill drafts', 'Staged drafts stay inert until /memories promote <name> copies them into the skill root.', ['skills']),
  entry('injection-is-once', 'Injection is once per conversation', 'The summary enters the conversation once; later recall goes through the memory tool.', ['memory']),
  entry('quota-cooldown', 'Quota cooldown pauses background work', 'A rate-limit refusal pauses extraction until the cooldown elapses.', ['memory', 'quota']),
  entry('中文记忆优先', '中文记忆优先', '用户的偏好是中文优先，中文回复优先于英文。', ['chinese'], ['中文优先', '中文']),
]

/** One query and the memory it must find. */
const QUERIES: readonly { query: string; expect: string }[] = [
  { query: 'pnpm', expect: 'prefer-pnpm-workspaces' },
  // Found by a key, not by any word in the title or body — the point of keys.
  { query: 'monorepo', expect: 'prefer-pnpm-workspaces' },
  { query: 'node --test', expect: 'run-the-test-suite' },
  { query: '环世界', expect: 'rimworld-mod-defs' },
  { query: 'dshmarket', expect: 'restart-dsh-web' },
  { query: 'build-client', expect: 'plugin-build-order' },
  { query: 'Chinese', expect: 'answer-in-chinese' },
  { query: 'backslash', expect: 'windows-path-separators' },
  { query: 'credentials', expect: 'never-commit-credentials' },
  { query: 'state.db', expect: 'state-lives-in-sqlite' },
  { query: 'promote', expect: 'promote-skill-drafts' },
  { query: 'rate-limit', expect: 'quota-cooldown' },
  { query: '中文优先', expect: '中文记忆优先' },
]

/** The corpus in the shape the search functions take. */
const GROUPS = [{ scope: 'global' as const, label: 'global', entries: CORPUS }]

/** Rank the corpus for one query. */
function rank(query: string, limit: number): string[] {
  return searchMemories(GROUPS, query, { limit }).map((hit) => hit.entry.id)
}

test('every eval query finds its memory in the top three', () => {
  const misses: string[] = []
  for (const { query, expect } of QUERIES) {
    const ids = rank(query, 3)
    if (!ids.includes(expect)) misses.push(`${JSON.stringify(query)} expected ${expect}, got [${ids.join(', ')}]`)
  }
  assert.deepEqual(misses, [], 'a query that cannot find its memory is a recall regression')
})

test('the corpus keeps its hit@1 rate', () => {
  const top = QUERIES.filter(({ query, expect }) => rank(query, 1)[0] === expect).length
  const rate = top / QUERIES.length
  assert.ok(rate >= 0.75, `hit@1 was ${rate.toFixed(2)}; the retrieval ranking regressed`)
})

test('a key-only query still clears the recall threshold', () => {
  // The on-demand delta reads the same score, so an alias that ranks well but
  // scores below the threshold would be unreachable in conversation.
  const hit = searchMemories(GROUPS, 'monorepo', { limit: 1 })[0]
  assert.equal(hit?.entry.id, 'prefer-pnpm-workspaces')
  // The corpus entries carry epoch timestamps, so the decayed score sits at its
  // floor; the gate the delta actually applies is the relevance floor.
  assert.ok(hit !== undefined && relevanceOf(hit.entry, 'monorepo') >= 20, 'the key-only match clears the relevance floor')
})

// ── The four shapes a word-matching retriever actually fails ───────────────
//
// The corpus above is single-hop and mostly positive: every query shares a noun
// with its memory, so it measures regressions in the scorer and nothing else —
// a hundred per cent hit rate there says the formula did not break, not that the
// retrieval is good. These four are the shapes that make a memory architecture
// necessary, taken from the failure taxonomy Hindsight's paper reports (multi-hop
// chains, temporal range, entity consolidation, belief revision). Each case gets
// its own small store so the mechanism under test is the only thing that can
// carry the answer, and each is asserted on its own line — a generic hit rate
// would let one shape regress while another covers for it.

/** Tuesday, 29 September 2026, 19:00 local — fixed so decay and dates are stable. */
const NOW = new Date(2026, 8, 29, 19, 0, 0).getTime()
/** A day, for building timestamps relative to {@link NOW}. */
const DAY = 86_400_000

/** One hard-case entry with explicit links and timestamps. */
function linked(id: string, title: string, body: string, keys: string[], extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    scope: 'global',
    kind: 'fact',
    title,
    body,
    tags: [],
    keys,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...extra,
  }
}

/** Rank one hard corpus for one query. */
function rankHard(entries: readonly MemoryEntry[], query: string, limit: number): string[] {
  return searchMemories([{ scope: 'global', label: 'global', entries }], query, { limit, now: NOW, expand: true })
    .map((hit) => hit.entry.id)
}

test('multi-hop: an entry linked to a match but sharing none of its words is still reachable', () => {
  // The query names Alice; the answer is the cluster that failed. Nothing in the
  // outage memory shares a word with the question — it is reachable only by
  // following Alice → Project Atlas → Kubernetes, which is what the keys are for.
  const corpus = [
    linked('alice-role', 'Alice 是 Project Atlas 的技术负责人', '她带这个项目两年了。', ['alice', 'project-atlas']),
    linked('atlas-migration', 'Alice 最近在忙 Project Atlas 的迁移', '她这阵子都在弄这件事。', ['project-atlas', 'kubernetes']),
    linked('cluster-outage', 'Kubernetes 集群周二出过故障', '那次故障持续了四十分钟。', ['kubernetes', 'project-atlas']),
  ]
  const ids = rankHard(corpus, 'Alice 最近有没有受影响', 3)
  assert.ok(ids.includes('alice-role') || ids.includes('atlas-migration'), `no direct match at all: ${ids.join(', ')}`)
  assert.ok(ids.includes('cluster-outage'), `the linked memory was not reached: ${ids.join(', ')}`)
})

test('temporal: a question about a period prefers what was learned in it', () => {
  // Identical wording, different months: the only thing that can order these two
  // is the date, which is exactly what the time channel exists to supply.
  const corpus = [
    linked('async-spring', 'Alice 在做异步改造', '她那阵子在改异步数据库调用。', [], { createdAt: new Date(2025, 3, 10).getTime(), updatedAt: new Date(2025, 3, 10).getTime() }),
    linked('async-autumn', 'Alice 在做异步改造', '她那阵子在改异步数据库调用。', [], { createdAt: new Date(2025, 10, 10).getTime(), updatedAt: new Date(2025, 10, 10).getTime() }),
  ]
  const query = 'Alice 去年春天在做什么'
  assert.equal(relevanceOf(corpus[0]!, query), relevanceOf(corpus[1]!, query), 'the two are lexically identical')
  assert.deepEqual(rankHard(corpus, query, 2), ['async-spring', 'async-autumn'])
})

test('entity consolidation: fragments filed under the same account arrive together', () => {
  const KEYS = ['用户账户', 'profile']
  const corpus = [
    linked('account-login', '用户账户的登录方式', '走的是 SSO。', KEYS),
    linked('account-timezone', '用户偏好的时区', '排期按 Asia/Shanghai 算。', KEYS),
    linked('account-team', '用户所在的团队', '他在平台组。', KEYS),
    linked('account-payment', '用户的支付方式', '走对公转账。', KEYS),
  ]
  const ids = rankHard(corpus, '你了解我的账户吗', 4)
  assert.ok(ids.includes('account-login'), `the direct match is missing: ${ids.join(', ')}`)
  const fragments = ids.filter((id) => id !== 'account-login')
  assert.ok(fragments.length >= 2, `only the matching fragment came back: ${ids.join(', ')}`)
})

test('belief revision: the newer, deliberately written conclusion outranks the old one', () => {
  const corpus = [
    linked('async-multithread', '用户在 async Python 上挣扎', '最后用多线程跑通了。', [], { source: 'auto' }),
    linked('async-asyncio', '用户已经转向 asyncio', '他已经在写异步数据库调用了。', [], { source: 'tool' }),
  ]
  const ids = rankHard(corpus, '用户现在的异步方案是什么', 2)
  assert.deepEqual(ids, ['async-asyncio', 'async-multithread'])
})

