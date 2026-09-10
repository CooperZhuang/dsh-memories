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
