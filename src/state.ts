/**
 * Operational state: extraction watermarks, job leases, and usage counters.
 *
 * These are NOT the memories. Entries stay human-readable markdown files (see
 * `storage.ts`), because those are the thing a person greps, edits, and commits.
 * State is the opposite: it is small, hot, and written concurrently by every
 * session in the process, which is exactly what a JSON read-modify-write file
 * gets wrong — two sessions mining at once would each write back a whole
 * document and silently drop the other's watermark.
 *
 * So state lives in SQLite, through Node's built-in `node:sqlite` (no
 * dependency). The module is loaded lazily and every failure degrades to an
 * in-memory map: a deployment on an older Node, or one where the driver is
 * unavailable, keeps working — it just loses cross-restart watermarks instead
 * of refusing to boot.
 *
 * @module dsh-memories/state
 */
import { mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Module-level require, used only for the optional `node:sqlite` import.
 * `createRequire` keeps the load lazy and lets an unavailable driver be caught
 * instead of failing the whole plugin at import time.
 */
const requireOptional = createRequire(import.meta.url)

/** Whether a filesystem error means "absent". */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** One session's extraction progress. */
export interface SessionState {
  /** Last surface message seq already mined (exclusive). */
  lastSeq: number
  /** Unix epoch milliseconds of the last successful extraction. */
  at: number
  /** Absolute workspace root recorded when the watermark was written. */
  root?: string
  /** Whether this session has ever contributed memories. */
  contributed?: boolean
  /** Unix epoch milliseconds of the session's last observed activity. */
  activityAt?: number
}

/** One pending consolidation job. */
export interface ConsolidateJob {
  /** Job key; currently always the global scope name. */
  key: string
  /** Unix epoch milliseconds when the job was enqueued. */
  enqueuedAt: number
  /** Unix epoch milliseconds before which the job must not run. */
  notBefore: number
  /**
   * Absolute workspace root whose project scope this pass covers.
   *
   * Consolidation is process-level but project scope is per-workspace, so the
   * job has to remember which workspace enqueued it: using whichever session
   * happens to run the pass would consolidate a different project's memories.
   */
  root?: string
  /** Lease holder token, or `undefined` when unclaimed. */
  lease?: string
  /** Unix epoch milliseconds the lease expires. */
  leaseUntil?: number
  /** Remaining retries before the job is dropped. */
  retries: number
  /** Last failure message, for diagnostics. */
  lastError?: string
}

/** The single background-pass pause a store records today. */
export const BACKGROUND_LIMIT = 'background'

/**
 * A recorded "stop spending quota" state.
 *
 * Codex gates background memory work on a provider-reported remaining-quota
 * percentage. DSH exposes no such number, so the same protection is driven by the
 * refusal itself: after a rate-limit or exhausted-quota error the plugin stops
 * starting background passes until the wait elapses, doubling it per consecutive
 * refusal.
 */
export interface LimitState {
  /** Consecutive refused passes. */
  failures: number
  /** Unix epoch milliseconds before which no background pass may start. */
  until: number
  /** Unix epoch milliseconds of the most recent refusal. */
  at: number
  /** Provider wording, for diagnostics. */
  reason?: string
}

/** A minimal synchronous SQL driver, matching the subset of `node:sqlite` used here. */
interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): { run(...parameters: unknown[]): unknown; get(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown[] }
  close(): void
}

/**
 * Durable state store.
 *
 * Every method is synchronous and internally consistent: SQLite serializes the
 * writes, and the fallback map is single-process. Callers do not need locking.
 */
export class StateStore {
  private db: SqlDatabase | undefined
  /** Fallback when `node:sqlite` is unavailable: watermarks survive only in-process. */
  private readonly sessions = new Map<string, SessionState>()
  private readonly jobs = new Map<string, ConsolidateJob>()
  private readonly usage = new Map<string, { uses: number; lastUsedAt: number }>()
  private readonly limits = new Map<string, LimitState>()
  /** Why the SQL driver is absent, for one diagnostic line. */
  readonly degradedReason: string | undefined

  constructor(readonly path: string) {
    let driver: string | undefined
    try {
      // Required lazily so a deployment on an older Node never pays for (or
      // fails on) the import.
      const { DatabaseSync } = requireOptional('node:sqlite') as { DatabaseSync: new (path: string) => SqlDatabase }
      mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0,
          at INTEGER NOT NULL DEFAULT 0,
          root TEXT,
          contributed INTEGER NOT NULL DEFAULT 0,
          activity_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS jobs (
          key TEXT PRIMARY KEY,
          enqueued_at INTEGER NOT NULL,
          root TEXT,
          not_before INTEGER NOT NULL DEFAULT 0,
          lease TEXT,
          lease_until INTEGER NOT NULL DEFAULT 0,
          retries INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS usage (
          scope TEXT NOT NULL,
          id TEXT NOT NULL,
          uses INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope, id)
        );
        CREATE TABLE IF NOT EXISTS limits (
          id TEXT PRIMARY KEY,
          failures INTEGER NOT NULL DEFAULT 0,
          until INTEGER NOT NULL DEFAULT 0,
          at INTEGER NOT NULL DEFAULT 0,
          reason TEXT
        );
      `)
      this.migrate()
    } catch (error) {
      driver = error instanceof Error ? error.message : String(error)
      this.db = undefined
    }
    this.degradedReason = driver
  }

  /**
   * Add columns a newer version introduced.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a column
   * added to the schema above would silently never appear on an upgraded store
   * and every query naming it would fail. Each column is checked and added
   * individually, which is safe to run on every open.
   */
  private migrate(): void {
    const db = this.db
    if (db === undefined) return
    const columns = (table: string): Set<string> => {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      return new Set(rows.map((row) => row.name))
    }
    // jobs.root: which workspace a consolidation pass covers (added after v1).
    if (!columns('jobs').has('root')) db.exec('ALTER TABLE jobs ADD COLUMN root TEXT')
  }

  /** Whether SQLite is backing this store. */
  get durable(): boolean {
    return this.db !== undefined
  }

  /** Close the database handle; safe to call twice. */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // Closing a store that is already gone is not a caller error.
    }
    this.db = undefined
  }

  /** Read one session's watermark. */
  getSession(id: string): SessionState | undefined {
    if (this.db === undefined) return this.sessions.get(id)
    const row = this.db.prepare('SELECT last_seq, at, root, contributed, activity_at FROM sessions WHERE id = ?').get(id) as
      | { last_seq: number; at: number; root: string | null; contributed: number; activity_at: number }
      | undefined
    if (row === undefined) return undefined
    return {
      lastSeq: Number(row.last_seq),
      at: Number(row.at),
      ...row.root === null ? {} : { root: row.root },
      contributed: row.contributed === 1,
      activityAt: Number(row.activity_at),
    }
  }

  /** Write one session's watermark. */
  putSession(id: string, state: SessionState): void {
    if (this.db === undefined) {
      this.sessions.set(id, state)
      return
    }
    this.db.prepare(`
      INSERT INTO sessions (id, last_seq, at, root, contributed, activity_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seq = excluded.last_seq, at = excluded.at, root = excluded.root,
        contributed = excluded.contributed, activity_at = excluded.activity_at
    `).run(id, state.lastSeq, state.at, state.root ?? null, state.contributed === true ? 1 : 0, state.activityAt ?? 0)
  }

  /** Record activity for a session without touching its watermark. */
  touchSession(id: string, at = Date.now()): void {
    if (this.db === undefined) {
      const existing = this.sessions.get(id)
      this.sessions.set(id, existing === undefined
        ? { lastSeq: 0, at: 0, activityAt: at }
        : { ...existing, activityAt: at })
      return
    }
    this.db.prepare(`
      INSERT INTO sessions (id, last_seq, at, activity_at) VALUES (?, 0, 0, ?)
      ON CONFLICT(id) DO UPDATE SET activity_at = excluded.activity_at
    `).run(id, at)
  }

  /** Every session that has a watermark, newest activity first. */
  listSessions(): { id: string; state: SessionState }[] {
    if (this.db === undefined) return [...this.sessions.entries()].map(([id, state]) => ({ id, state }))
    const rows = this.db.prepare('SELECT id, last_seq, at, root, contributed, activity_at FROM sessions ORDER BY activity_at DESC').all() as
      { id: string; last_seq: number; at: number; root: string | null; contributed: number; activity_at: number }[]
    return rows.map((row) => ({
      id: row.id,
      state: {
        lastSeq: Number(row.last_seq),
        at: Number(row.at),
        ...row.root === null ? {} : { root: row.root },
        contributed: row.contributed === 1,
        activityAt: Number(row.activity_at),
      },
    }))
  }

  /** Number of sessions with a watermark. */
  sessionCount(): number {
    if (this.db === undefined) return this.sessions.size
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    return Number(row.n)
  }

  /** Read one job. */
  getJob(key: string): ConsolidateJob | undefined {
    if (this.db === undefined) return this.jobs.get(key)
    const row = this.db.prepare('SELECT key, enqueued_at, not_before, root, lease, lease_until, retries, last_error FROM jobs WHERE key = ?').get(key) as
      | { key: string; enqueued_at: number; not_before: number; root: string | null; lease: string | null; lease_until: number; retries: number; last_error: string | null }
      | undefined
    if (row === undefined) return undefined
    return {
      key: row.key,
      enqueuedAt: Number(row.enqueued_at),
      notBefore: Number(row.not_before),
      ...row.root === null ? {} : { root: row.root },
      ...row.lease === null ? {} : { lease: row.lease },
      leaseUntil: Number(row.lease_until),
      retries: Number(row.retries),
      ...row.last_error === null ? {} : { lastError: row.last_error },
    }
  }

  /** Insert or replace one job. */
  putJob(job: ConsolidateJob): void {
    if (this.db === undefined) {
      this.jobs.set(job.key, job)
      return
    }
    this.db.prepare(`
      INSERT INTO jobs (key, enqueued_at, not_before, root, lease, lease_until, retries, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        enqueued_at = excluded.enqueued_at, not_before = excluded.not_before, root = excluded.root, lease = excluded.lease,
        lease_until = excluded.lease_until, retries = excluded.retries, last_error = excluded.last_error
    `).run(job.key, job.enqueuedAt, job.notBefore, job.root ?? null, job.lease ?? null, job.leaseUntil ?? 0, job.retries, job.lastError ?? null)
  }

  /** Delete one job. */
  deleteJob(key: string): void {
    if (this.db === undefined) {
      this.jobs.delete(key)
      return
    }
    this.db.prepare('DELETE FROM jobs WHERE key = ?').run(key)
  }

  /**
   * Claim one job for `leaseMs`, or return `undefined` when another holder owns
   * a live lease or the job's backoff has not elapsed. The current holder may
   * renew its own lease.
   * @param key - job key.
   * @param token - this worker's opaque lease token.
   * @param leaseMs - how long the lease is valid.
   * @param now - injected clock.
   * @returns the claimed job, or `undefined` when it is not available.
   */
  claimJob(key: string, token: string, leaseMs: number, now = Date.now()): ConsolidateJob | undefined {
    const job = this.getJob(key)
    if (job === undefined) return undefined
    if (job.notBefore > now) return undefined
    const heldByOther = job.lease !== undefined && job.lease !== token && (job.leaseUntil ?? 0) > now
    if (heldByOther) return undefined
    const claimed: ConsolidateJob = { ...job, lease: token, leaseUntil: now + leaseMs }
    this.putJob(claimed)
    return claimed
  }

  /** Record one usage hit for a memory entry. */
  bumpUsage(scope: string, id: string, now = Date.now()): { uses: number; lastUsedAt: number } {
    if (this.db === undefined) {
      const key = `${scope}\u0000${id}`
      const next = { uses: (this.usage.get(key)?.uses ?? 0) + 1, lastUsedAt: now }
      this.usage.set(key, next)
      return next
    }
    this.db.prepare(`
      INSERT INTO usage (scope, id, uses, last_used_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(scope, id) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at
    `).run(scope, id, now)
    const row = this.db.prepare('SELECT uses, last_used_at FROM usage WHERE scope = ? AND id = ?').get(scope, id) as { uses: number; last_used_at: number }
    return { uses: Number(row.uses), lastUsedAt: Number(row.last_used_at) }
  }

  /** Read one entry's usage counters. */
  getUsage(scope: string, id: string): { uses: number; lastUsedAt: number } {
    if (this.db === undefined) return this.usage.get(`${scope}\u0000${id}`) ?? { uses: 0, lastUsedAt: 0 }
    const row = this.db.prepare('SELECT uses, last_used_at FROM usage WHERE scope = ? AND id = ?').get(scope, id) as
      | { uses: number; last_used_at: number }
      | undefined
    return row === undefined ? { uses: 0, lastUsedAt: 0 } : { uses: Number(row.uses), lastUsedAt: Number(row.last_used_at) }
  }

  /** Every usage row, for the summary ranking pass. */
  listUsage(): { scope: string; id: string; uses: number; lastUsedAt: number }[] {
    if (this.db === undefined) {
      return [...this.usage.entries()].map(([key, value]) => {
        const [scope, id] = key.split('\u0000')
        return { scope: scope ?? '', id: id ?? '', ...value }
      })
    }
    const rows = this.db.prepare('SELECT scope, id, uses, last_used_at FROM usage').all() as
      { scope: string; id: string; uses: number; last_used_at: number }[]
    return rows.map((row) => ({ scope: row.scope, id: row.id, uses: Number(row.uses), lastUsedAt: Number(row.last_used_at) }))
  }

  /** The recorded background pause, if any. */
  getLimit(id: string = BACKGROUND_LIMIT): LimitState | undefined {
    if (this.db === undefined) return this.limits.get(id)
    const row = this.db.prepare('SELECT id, failures, until, at, reason FROM limits WHERE id = ?').get(id) as
      | { id: string; failures: number; until: number; at: number; reason: string | null }
      | undefined
    if (row === undefined) return undefined
    return {
      failures: Number(row.failures),
      until: Number(row.until),
      at: Number(row.at),
      ...row.reason === null ? {} : { reason: row.reason },
    }
  }

  /**
   * Whether background passes are paused right now.
   * @param now - injected clock.
   * @param id - which pause to read.
   * @returns true while the recorded wait has not elapsed.
   */
  isLimited(now = Date.now(), id: string = BACKGROUND_LIMIT): boolean {
    const limit = this.getLimit(id)
    return limit !== undefined && limit.until > now
  }

  /**
   * Record one provider refusal and extend the wait.
   *
   * The wait doubles per consecutive refusal, capped, so a provider that keeps
   * refusing costs one failed call per interval instead of one per idle timer.
   *
   * @param reason - provider wording, for diagnostics.
   * @param baseMs - wait after the first refusal.
   * @param maxMs - ceiling for the doubling.
   * @param now - injected clock.
   * @param id - which pause to write.
   * @returns the state after this refusal.
   */
  noteLimitFailure(reason: string, baseMs: number, maxMs: number, now = Date.now(), id: string = BACKGROUND_LIMIT): LimitState {
    const previous = this.getLimit(id)
    const failures = (previous?.failures ?? 0) + 1
    const wait = Math.min(maxMs, baseMs * 2 ** (failures - 1))
    const state: LimitState = { failures, until: now + wait, at: now, reason }
    if (this.db === undefined) {
      this.limits.set(id, state)
      return state
    }
    this.db.prepare(`
      INSERT INTO limits (id, failures, until, at, reason) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        failures = excluded.failures, until = excluded.until, at = excluded.at, reason = excluded.reason
    `).run(id, state.failures, state.until, state.at, state.reason ?? null)
    return state
  }

  /** Forget the pause after a pass succeeds. */
  clearLimit(id: string = BACKGROUND_LIMIT): void {
    if (this.db === undefined) {
      this.limits.delete(id)
      return
    }
    this.db.prepare('DELETE FROM limits WHERE id = ?').run(id)
  }
}

/**
 * Resolve the state database path inside one memory store. */
export function statePath(memoriesDir: string): string {
  return join(memoriesDir, 'state.db')
}

/** The pre-SQLite watermark file, imported once and then removed. */
export const LEGACY_STATE_FILE = 'extract-state.json'

/** Shape of the legacy `extract-state.json` document. */
interface LegacyState {
  version?: number
  sessions?: Record<string, { lastSeq?: number; at?: number; root?: string; contributed?: boolean }>
}

/**
 * Import and remove a pre-SQLite `extract-state.json`.
 *
 * The file only ever held extraction watermarks. Importing them matters: a
 * session with no watermark is re-mined, which spends quota re-reading a
 * conversation that was already processed. The import is skipped when the
 * database already holds sessions, so it can never overwrite newer state.
 *
 * @param store - the state store to import into.
 * @param memoriesDir - directory the legacy file lives in.
 * @returns how many watermarks were imported, or `undefined` when there was nothing to do.
 */
export async function importLegacyState(store: StateStore, memoriesDir: string): Promise<number | undefined> {
  const path = join(memoriesDir, LEGACY_STATE_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  let parsed: LegacyState
  try {
    parsed = JSON.parse(text) as LegacyState
  } catch {
    // A corrupt legacy file is not worth failing the plugin over; remove it so
    // it stops looking like live state.
    await rm(path, { force: true })
    return 0
  }
  let imported = 0
  if (store.sessionCount() === 0 && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
    for (const [id, value] of Object.entries(parsed.sessions)) {
      if (typeof value !== 'object' || value === null) continue
      const lastSeq = Number(value.lastSeq)
      if (!Number.isFinite(lastSeq) || lastSeq <= 0) continue
      store.putSession(id, {
        lastSeq: Math.trunc(lastSeq),
        at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0,
        ...typeof value.root === 'string' ? { root: value.root } : {},
        ...value.contributed === true ? { contributed: true } : {},
        // The legacy file never recorded activity; the watermark time is the
        // closest honest proxy for "when this session was last touched".
        activityAt: Number.isFinite(Number(value.at)) ? Number(value.at) : 0,
      })
      imported += 1
    }
  }
  await rm(path, { force: true })
  return imported
}
