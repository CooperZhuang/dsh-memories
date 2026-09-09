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
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Module-level require, used only for the optional `node:sqlite` import.
 * `createRequire` keeps the load lazy and lets an unavailable driver be caught
 * instead of failing the whole plugin at import time.
 */
const requireOptional = createRequire(import.meta.url)

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
  /** Lease holder token, or `undefined` when unclaimed. */
  lease?: string
  /** Unix epoch milliseconds the lease expires. */
  leaseUntil?: number
  /** Remaining retries before the job is dropped. */
  retries: number
  /** Last failure message, for diagnostics. */
  lastError?: string
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
      `)
    } catch (error) {
      driver = error instanceof Error ? error.message : String(error)
      this.db = undefined
    }
    this.degradedReason = driver
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
    const row = this.db.prepare('SELECT key, enqueued_at, not_before, lease, lease_until, retries, last_error FROM jobs WHERE key = ?').get(key) as
      | { key: string; enqueued_at: number; not_before: number; lease: string | null; lease_until: number; retries: number; last_error: string | null }
      | undefined
    if (row === undefined) return undefined
    return {
      key: row.key,
      enqueuedAt: Number(row.enqueued_at),
      notBefore: Number(row.not_before),
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
      INSERT INTO jobs (key, enqueued_at, not_before, lease, lease_until, retries, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        enqueued_at = excluded.enqueued_at, not_before = excluded.not_before, lease = excluded.lease,
        lease_until = excluded.lease_until, retries = excluded.retries, last_error = excluded.last_error
    `).run(job.key, job.enqueuedAt, job.notBefore, job.lease ?? null, job.leaseUntil ?? 0, job.retries, job.lastError ?? null)
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
}

/** Resolve the state database path inside one memory store. */
export function statePath(memoriesDir: string): string {
  return join(memoriesDir, 'state.db')
}
