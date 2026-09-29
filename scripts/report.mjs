/**
 * One-screen digest of what the memory plugin has actually been doing.
 *
 * The plugin writes everything it does to `$DSH_HOME/logs/dsh-memories.log` and
 * keeps its counters in `$DSH_HOME/memories/state.db`, but answering an ordinary
 * question — "有抽取在跑吗"、"补注还触发吗"、"哪些记忆从没被用过" — meant
 * remembering four different `Select-String` incantations and one SQL query. This
 * is that, in one command, read-only, no dependencies beyond Node.
 *
 * Three questions it answers, in order:
 *
 * 1. **Is the machinery alive** — the last extraction pass, the last injection,
 *    the last sweep, and whether anything is warning or erroring.
 * 2. **Is recall doing anything** — how often the on-demand delta fired, what it
 *    recalled, and what the evidence gate turned away (the near misses). Both
 *    lines carry the time window and the hop count since 2026-09-29, so the two
 *    mechanisms added that day are visible here without reproducing a search.
 * 3. **What the store thinks of itself** — entries per scope, how many have ever
 *    been read, how many have never been surfaced at all, and how far the
 *    extraction watermarks have advanced.
 *
 * Usage:
 *
 * ```bash
 * npm run report                     # ~/.dsh, last 5 examples per section
 * node scripts/report.mjs --examples=20
 * node scripts/report.mjs --home=C:/somewhere/.dsh
 * ```
 *
 * @module dsh-memories/scripts/report
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Parse `--flag=value`. */
function options(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(arg)
    if (match !== null) flags[match[1]] = match[2] ?? 'true'
  }
  return flags
}

const flags = options(process.argv.slice(2))
const home = flags.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const examples = Number(flags.examples ?? 5)
const logPath = join(home, 'logs', 'dsh-memories.log')
const storePath = join(home, 'memories')

/** `2026-09-29T12:23:39.775Z` → `09-29 20:23` in local time. */
function localStamp(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Every message the plugin logged, oldest first, rotation included. */
function readLog() {
  const files = [`${logPath}.1`, logPath].filter((file) => existsSync(file))
  const rows = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
      const match = /^(\S+) \[(\w+)\] dsh-memories dsh-memories: (.*)$/u.exec(line)
      if (match !== null) rows.push({ at: match[1], level: match[2], text: match[3] })
    }
  }
  return rows
}

/** Print the last few messages matching one shape. */
function section(title, rows, match, note) {
  const hits = rows.filter((row) => match.test(row.text))
  console.log(`\n## ${title} — ${hits.length} 条`)
  if (note !== undefined) console.log(`   ${note}`)
  for (const row of hits.slice(-examples)) console.log(`   ${localStamp(row.at)}  ${row.text.slice(0, 150)}`)
  if (hits.length === 0) console.log('   （没有）')
}

if (!existsSync(logPath)) {
  console.log(`没有日志文件：${logPath}`)
} else {
  const rows = readLog()
  const size = statSync(logPath).size
  console.log(`dsh-memories 摘要  ${new Date().toLocaleString()}`)
  console.log(`日志 ${logPath}（${(size / 1024).toFixed(0)} KB，本次读入 ${rows.length} 行）`)

  const warnings = rows.filter((row) => row.level === 'warn' || row.level === 'error')
  console.log(`\n## 警告与错误 — ${warnings.length} 条`)
  for (const row of warnings.slice(-examples)) console.log(`   ${localStamp(row.at)}  [${row.level}] ${row.text.slice(0, 150)}`)
  if (warnings.length === 0) console.log('   （没有）')

  section('热重挂（每次 npm run build 一条，可用来判断某段时间跑的是哪版代码）', rows, /^exposed the memories Remote namespace/u)
  section('注入摘要', rows, /^injected the summary into session/u)
  section('补注触发（末尾的 via 是命中的那句话，不是种子 id）', rows, /^session \S+ recalled /u)
  section('近失：够到分数下限、被证据闸门挡下', rows, /had a near miss worth reading/u)
  section('抽取轮次', rows, /^extract pass: /u)
  section('抽取产出', rows, /^stored \d+ memories? from session/u)
  section('检索（decision 级，需 traceMaintenance: true 才会出现）', rows, /^search "/u)

  // Total tokens spent on extraction, which the cost panel cannot see: those
  // calls belong to no session.
  let tokensIn = 0
  let tokensOut = 0
  let calls = 0
  for (const row of rows) {
    const match = /\[(\d+) in \/ (\d+) out tokens\]/u.exec(row.text)
    if (match === null) continue
    calls += 1
    tokensIn += Number(match[1])
    tokensOut += Number(match[2])
  }
  const recalls = rows.filter((row) => /^session \S+ recalled /u.test(row.text)).length
  console.log(`\n## 合计`)
  console.log(`   补注 ${recalls} 次，近失 ${rows.filter((row) => /near miss/u.test(row.text)).length} 次，热重挂 ${rows.filter((row) => /^exposed the memories Remote/u.test(row.text)).length} 次`)
  console.log(`   抽取可见花费：${calls} 次调用，${tokensIn} in / ${tokensOut} out tokens（后台调用不建会话，成本面板看不到）`)
}

// ── The store's own counters ────────────────────────────────────────────────
const stateDb = join(storePath, 'state.db')
if (!existsSync(stateDb)) {
  console.log(`\n没有状态库：${stateDb}`)
} else {
  console.log(`\n## 存储  ${storePath}`)
  const scopes = [['global', join(storePath, 'entries')]]
  for (const name of existsSync(join(storePath, 'projects')) ? readdirSync(join(storePath, 'projects')) : []) {
    const dir = join(storePath, 'projects', name, 'entries')
    if (existsSync(dir)) scopes.push([`project:${name}`, dir])
  }
  let total = 0
  const perScope = []
  for (const [name, dir] of scopes) {
    const count = readdirSync(dir).filter((file) => file.endsWith('.md')).length
    total += count
    if (count > 0) perScope.push(`${name}=${count}`)
  }
  console.log(`   条目 ${total} 条 / ${perScope.length} 个作用域`)
  console.log(`   ${perScope.sort((left, right) => Number(right.split('=')[1]) - Number(left.split('=')[1])).slice(0, 6).join('  ')}`)

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(stateDb, { readOnly: true })
    const usage = db.prepare('select count(*) as n, sum(case when uses > 0 then 1 else 0 end) as read, sum(case when surfaced_at > 0 then 1 else 0 end) as surfaced from usage').get()
    console.log(`   用量：${usage.n} 条有记录，${usage.read} 条被读过，${usage.surfaced} 条露过面`)
    const never = db.prepare('select count(*) as n from usage where uses = 0 and surfaced_at = 0').get()
    console.log(`   从未被读过也从未露面：${never.n} 条（只有 memory_search 或合并能碰到它们）`)
    const sessions = db.prepare('select count(*) as n, max(at) as last, sum(case when last_seq > 0 then 1 else 0 end) as mined from sessions').get()
    console.log(`   会话：${sessions.n} 个被跟踪，${sessions.mined} 个被抽过；最近水位线 ${sessions.last > 0 ? localStamp(new Date(sessions.last).toISOString()) : '（从未）'}`)
    const stale = db.prepare('select max(at) as last from sessions where last_seq > 0').get()
    if (sessions.n > 0 && stale.last > 0) {
      const ageHours = (Date.now() - stale.last) / 3_600_000
      if (ageHours > 24) console.log(`   ⚠ 最近一次成功抽取在 ${ageHours.toFixed(0)} 小时前 —— 抽取可能停摆了（看上面的「抽取轮次」尾部原因）`)
    }
    db.close()
  } catch (error) {
    console.log(`   （状态库读不了：${error instanceof Error ? error.message : String(error)}）`)
  }
}
