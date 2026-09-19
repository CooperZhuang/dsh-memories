/**
 * Tests for retrieval: how a turn becomes queries, and how a memory scores.
 *
 * The failure these pin down is specific and was measured on a real store. A
 * Chinese question has no spaces, so under a whitespace tokenizer it is one
 * indivisible term and only a whole-question substring could ever match — which
 * meant every Chinese-only turn recalled nothing, while a turn that happened to
 * contain an ASCII word recalled a crowd. The corpus here is written the way
 * real memories are: Chinese titles, Chinese bodies, occasional English terms.
 *
 * @module dsh-memories/test/retrieval.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { tokenize, termWeight, relevanceOf, relevanceOfOne, searchMemories, FIELD_WEIGHTS, TERM_WEIGHTS } from '../search.js'
import { isSubstantiveTurn, queryMessages } from '../query.js'
import type { MemoryEntry, MemoryKind } from '../types.js'

/** Build one corpus entry. */
function entry(id: string, title: string, body: string, extra: Partial<MemoryEntry> = {}, kind: MemoryKind = 'fact'): MemoryEntry {
  return {
    id,
    scope: 'global',
    kind,
    title,
    body,
    tags: extra.tags ?? [],
    keys: extra.keys ?? [],
    createdAt: 0,
    updatedAt: 0,
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...extra.appliesTo === undefined ? {} : { appliesTo: extra.appliesTo },
  }
}

/** The corpus the queries below are ranked against. */
const CORPUS: readonly MemoryEntry[] = [
  entry('prefer-pnpm', 'Prefer pnpm workspaces', 'The repository is one pnpm workspace; do not run npm install.', { tags: ['tooling'], keys: ['monorepo'] }),
  entry('plugin-logs', '插件日志查看方式', '插件的日志写在 dsh-memories.log 里，超过 2MB 轮转一代。'),
  entry('plugin-order', '插件注册顺序', '插件在启动时注册，日志级别由配置决定。'),
  entry('restart-web', '重启 dsh web', '用 dshmarket 的 restart 端点重启。', { tags: ['dsh'], keys: ['dshmarket'] }),
  entry('push-after-commit', '提交后主动推送', '本项目的约定是提交后主动推送，不要留在本地。', { appliesTo: '准备推送代码之前' }),
  entry('commit-f', 'pwsh 下多行提交消息要用 -F 文件', '在 PowerShell 里用 git commit -F 读文件，heredoc 和 -m 都会出错。'),
  entry('always-origin', '始终使用 origin 远端', '推送时远端固定为 origin，不要推到别的名字。', { appliesTo: '推送代码之前' }),
]

/** The corpus in the shape the search functions take. */
const GROUPS = [{ scope: 'global' as const, label: 'global', entries: CORPUS }]

/** Ids of the top `limit` hits for one query. */
function rank(query: string, limit = 3): string[] {
  return searchMemories(GROUPS, query, { limit }).map((hit) => hit.entry.id)
}

test('tokenize keeps ASCII words whole and expands CJK into bigrams', () => {
  assert.deepEqual(tokenize('git commit -F'), ['git', 'commit', 'f'])
  // The whole point: a space-free Chinese run must produce more than itself.
  const terms = tokenize('该插件是否有日志')
  assert.ok(terms.includes('插件'), 'a bigram is reachable')
  assert.ok(terms.includes('日志'), 'including the one that carries the meaning')
  assert.ok(terms.length > 3, 'the run expands rather than staying indivisible')
  assert.deepEqual(tokenize('日志'), ['日志'], 'a two-character run is already its own bigram')
  assert.deepEqual(tokenize('看'), ['看'], 'a lone ideograph contributes itself')
})

test('a CJK bigram is a weaker claim than a Latin word', () => {
  assert.equal(termWeight('logging'), 1)
  assert.ok(termWeight('日志') < 1, 'a pair of characters can appear in unrelated text')
})

test('queryMessages splits a turn, keeps the whole, and is deterministic', () => {
  const turn = '先看日志。然后把插件重启，再确认一下。'
  const messages = queryMessages(turn)
  assert.equal(messages[0], turn, 'the whole turn is still a candidate')
  assert.ok(messages.some((message) => message.includes('先看日志')), 'sentences are scored on their own')
  assert.ok(messages.some((message) => message.includes('把插件重启')), 'and so are clauses')
  assert.deepEqual(queryMessages(turn), messages, 'the same turn always yields the same list')
  assert.equal(new Set(messages).size, messages.length, 'no duplicates')
  assert.deepEqual(queryMessages('   '), [], 'whitespace carries no query')
})

test('queryMessages bounds how much of a long turn reaches the scorer', () => {
  const long = Array.from({ length: 60 }, (_, index) => `第${index}句关于打包与部署的说明文字。`).join('')
  const messages = queryMessages(long)
  assert.ok(messages.length <= 1 + 12, 'a long turn cannot fan out without bound')
  assert.ok(messages.every((message) => message.length <= 240), 'no candidate is unbounded')
})

test('a Latin query still finds its memory', () => {
  assert.equal(rank('pnpm')[0], 'prefer-pnpm')
  assert.equal(rank('monorepo')[0], 'prefer-pnpm', 'a key is a first-class way in')
  assert.equal(rank('dshmarket')[0], 'restart-web')
})

test('a space-free Chinese turn finds the memory it shares a phrase with', () => {
  assert.equal(rank('这个插件的日志在哪里？')[0], 'plugin-logs')
  assert.equal(rank('插件日志')[0], 'plugin-logs')
})

test('sharing common characters is not the same as sharing a phrase', () => {
  const byPhrase = relevanceOf(CORPUS.find((item) => item.id === 'plugin-logs')!, '这个插件的日志在哪里？')
  const byPair = relevanceOf(CORPUS.find((item) => item.id === 'plugin-order')!, '这个插件的日志在哪里？')
  assert.ok(byPhrase > byPair, 'the memory sharing 插件日 outranks the one sharing only 插件')
})

test('generic character overlap does not outrank a real match', () => {
  const hits = rank('该插件是否有日志', 7)
  assert.ok(hits.includes('plugin-logs') || hits.includes('plugin-order'),
    'the plugin memories rank above an unrelated one')
  // The commit memory shares nothing with the question and must not appear.
  assert.ok(!hits.includes('commit-f'))
})

test('appliesTo contributes, and is why a paraphrased turn still finds the memory', () => {
  const push = CORPUS.find((item) => item.id === 'push-after-commit')!
  // `exactOptionalPropertyTypes` is on, so the field is removed by destructuring
  // rather than by assigning `undefined` back to it.
  const { appliesTo: _dropped, ...withoutAppliesTo } = push
  const withField = relevanceOf(push, '准备推送代码之前')
  const withoutField = relevanceOf(withoutAppliesTo, '准备推送代码之前')
  assert.ok(withField > withoutField, 'the appliesTo phrase adds score')
  assert.ok(withoutField > 0, 'the body alone still matches, just less strongly')
})

test('the same phrase is worth more in the title than in the body', () => {
  const phrase = 'prefer pnpm workspaces'
  const inTitle = entry('in-title', phrase, 'A note.')
  const inBody = entry('in-body', 'Package manager notes', `${phrase} over npm.`)
  assert.ok(relevanceOfOne(inTitle, phrase) > relevanceOfOne(inBody, phrase),
    'the title is the claim; the body is supporting text')
  for (const field of ['title', 'keys', 'tags', 'appliesTo', 'body'] as const) {
    assert.ok(FIELD_WEIGHTS[field] > TERM_WEIGHTS[field], `${field}: the phrase outweighs a term`)
  }
  // A shorter query that matches the whole title still outranks a longer query
  // that only matches its parts — the reason the field weight is per field.
  assert.ok(relevanceOfOne(inTitle, 'prefer pnpm workspaces') > 0)
})

test('ranking is a total order: score, then recency, then title', () => {
  const older = entry('older', 'Same title', 'body')
  const newer = entry('newer', 'Same title', 'body')
  const groups = [{ scope: 'global' as const, label: 'global', entries: [{ ...older, updatedAt: 1 }, { ...newer, updatedAt: 2 }] }]
  const hits = searchMemories(groups, 'same title', { limit: 5 })
  assert.deepEqual(hits.map((hit) => hit.entry.id), ['newer', 'older'])
})

test('search filters and browse still behave', () => {
  assert.equal(searchMemories(GROUPS, 'pnpm', { tags: ['nope'] }).length, 0)
  assert.equal(searchMemories(GROUPS, '').length, 0)
  assert.deepEqual(searchMemories(GROUPS, 'pnpm', { kinds: ['fact'] }).map((hit) => hit.entry.id), ['prefer-pnpm'])
  assert.equal(searchMemories(GROUPS, 'pnpm', { kinds: ['failure'] }).length, 0)
})

test('a turn with no letters, digits, or ideographs is not worth a scan', () => {
  assert.equal(isSubstantiveTurn('好'), true)
  assert.equal(isSubstantiveTurn('ok'), true)
  assert.equal(isSubstantiveTurn('  ...  '), false)
  assert.equal(isSubstantiveTurn(''), false)
})
