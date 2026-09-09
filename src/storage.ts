/**
 * Durable memory storage.
 *
 * Layout under `<memoriesDir>`:
 *
 * ```text
 * memories/
 *   index.json                     # global scope index (a rebuildable cache)
 *   entries/<id>.md                # one file per global entry
 *   projects/<slug>/index.json     # project scope index
 *   projects/<slug>/entries/*.md
 *   projects/<slug>/project.json   # how the slug was derived (diagnostics)
 *   extract-state.json             # per-session extraction watermarks
 * ```
 *
 * Entry files are the source of truth: an index is a rebuildable cache, so a
 * hand-edited or deleted index self-heals on the next read. Every write is
 * atomic (temp file + rename).
 *
 * @module dsh-memories/storage
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { MemoryDraft, MemoryEntry, MemoryScope, ScopeTarget, UpsertResult } from './types.js'

/** Frontmatter fence used by every entry file. */
const FENCE = '---'

/** Project descriptor written beside a project scope's entries. */
export interface ProjectDescriptor {
  /** Absolute workspace root the slug was derived from. */
  readonly root: string
  /** Directory basename of that root, for display. */
  readonly name: string
  /** Slug directory name under `projects/`. */
  readonly slug: string
  /** Unix epoch milliseconds of the last write. */
  readonly updatedAt: number
}

/** Whether a filesystem error means "absent". */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Read a UTF-8 file, or `undefined` when it does not exist. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Whether one path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Write a file atomically: a sibling temp file is renamed over the target, so a
 * reader never observes a partial document.
 * @param path - destination path.
 * @param content - exact UTF-8 content.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Turn arbitrary text into a stable lowercase slug. */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
  return slug.length > 0 ? slug : 'memory'
}

/** Normalize one tag: lowercase, slug-ish, non-empty, deduplicated by the caller. */
export function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, '-').slice(0, 32)
}

/**
 * Derive a stable, collision-resistant directory slug for one workspace root.
 * @param root - absolute workspace root.
 * @returns `<basename>-<8 hex chars of sha1(root)>`.
 */
export function projectSlug(root: string): string {
  const name = slugify(root.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? 'workspace')
  const digest = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8)
  return `${name}-${digest}`
}

/** Serialize one entry as a markdown file with frontmatter. */
export function formatEntry(entry: MemoryEntry): string {
  const tags = entry.tags.length > 0 ? `tags: ${entry.tags.join(', ')}` : 'tags:'
  return [
    FENCE,
    `id: ${entry.id}`,
    `scope: ${entry.scope}`,
    `title: ${entry.title}`,
    tags,
    `created: ${new Date(entry.createdAt).toISOString()}`,
    `updated: ${new Date(entry.updatedAt).toISOString()}`,
    `source: ${entry.source}`,
    `uses: ${entry.uses}`,
    `lastUsed: ${entry.lastUsedAt > 0 ? new Date(entry.lastUsedAt).toISOString() : 'never'}`,
    FENCE,
    '',
    entry.body,
    '',
  ].join('\n')
}

/** Parse a frontmatter timestamp written as ISO text or raw epoch milliseconds. */
function parseTime(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Parse one entry file. Unparseable files are reported by returning
 * `undefined` so one corrupt file cannot take the whole store down.
 * @param text - file content.
 * @param scope - scope the file belongs to (the directory is authoritative).
 * @param fallbackId - id derived from the file name.
 * @returns the parsed entry, or `undefined` when the file is not an entry.
 */
export function parseEntry(text: string, scope: MemoryScope, fallbackId: string): MemoryEntry | undefined {
  const normalized = text.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith(FENCE)) return undefined
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length)
  if (end < 0) return undefined
  const header = normalized.slice(FENCE.length, end)
  const body = normalized.slice(end + FENCE.length + 1).replace(/^\n+/u, '').trimEnd()
  const fields = new Map<string, string>()
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  const title = fields.get('title')
  if (title === undefined || title.length === 0) return undefined
  const rawSource = fields.get('source')
  const source = rawSource === 'tool' || rawSource === 'user' || rawSource === 'auto' || rawSource === 'system'
    ? rawSource
    : 'system'
  const updatedAt = parseTime(fields.get('updated'), Date.now())
  const rawUses = Number(fields.get('uses') ?? '0')
  return {
    id: fields.get('id') ?? fallbackId,
    scope,
    title,
    body,
    tags: (fields.get('tags') ?? '').split(',').map(normalizeTag).filter((tag) => tag.length > 0),
    createdAt: parseTime(fields.get('created'), updatedAt),
    updatedAt,
    uses: Number.isFinite(rawUses) && rawUses > 0 ? Math.trunc(rawUses) : 0,
    lastUsedAt: parseTime(fields.get('lastused'), 0),
    source,
  }
}

/** Normalize text for duplicate detection: case- and whitespace-insensitive. */
function fingerprint(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim()
}

/**
 * Collapse entries that say the same thing under different ids.
 *
 * Ids come from titles, so a re-worded title creates a second file. Left alone
 * the store would slowly fill with near-copies that all compete for the bounded
 * summary budget. Two entries collide only when BOTH their normalized title and
 * their normalized body match, or when one of them contains the other's title
 * and body — a deliberately narrow rule, because collapsing on the body alone
 * would merge genuinely distinct memories that share wording. The most recently
 * updated entry wins and the losers are deleted.
 *
 * @param entries - entries in one scope, newest first.
 * @param store - owning store, used to delete the losers.
 * @param scope - the scope being deduplicated.
 * @param projectRoot - workspace root for a project scope.
 * @param keep - ids that must survive regardless of collisions.
 * @returns the surviving entries, newest first.
 */
async function dedupeEntries(
  entries: readonly MemoryEntry[],
  store: MemoryStore,
  scope: MemoryScope,
  projectRoot: string | undefined,
  keep: ReadonlySet<string>,
): Promise<MemoryEntry[]> {
  const winners: { title: string; body: string; entry: MemoryEntry }[] = []
  const losers: MemoryEntry[] = []
  for (const entry of entries) {
    const title = fingerprint(entry.title)
    const body = fingerprint(entry.body)
    const clash = winners.find((candidate) =>
      (candidate.title === title && candidate.body === body)
      || (candidate.title.length > 0 && title.includes(candidate.title) && body.includes(candidate.body))
      || (title.length > 0 && candidate.title.includes(title) && candidate.body.includes(body)))
    if (clash === undefined) {
      winners.push({ title, body, entry })
      continue
    }
    // Entries are newest-first, so `clash` is already the newer of the two; an
    // explicitly kept entry always outranks it.
    if (keep.has(entry.id) && !keep.has(clash.entry.id)) {
      losers.push(clash.entry)
      winners.splice(winners.indexOf(clash), 1, { title, body, entry })
      continue
    }
    losers.push(entry)
  }
  if (losers.length === 0) return [...entries]
  for (const loser of losers) {
    await rm(join(store.entriesDirOf(scope, projectRoot), `${loser.id}.md`), { force: true })
  }
  const dropped = new Set(losers.map((loser) => loser.id))
  return entries.filter((entry) => !dropped.has(entry.id))
}

/** In-memory index cache keyed by absolute scope directory. */
interface IndexCache {
  entries: readonly MemoryEntry[]
  loadedAt: number
}

/** How long a cached index is trusted before the directory is re-scanned. */
const INDEX_TTL_MS = 2_000

/**
 * A memory store rooted at one harness home.
 *
 * Reads are cached for {@link INDEX_TTL_MS}; writes invalidate the owning scope
 * immediately. Every method is safe to call concurrently: entry writes are
 * atomic and the index is a rebuildable cache.
 */
export class MemoryStore {
  readonly memoriesDir: string
  private readonly cache = new Map<string, IndexCache>()
  private readonly pending = new Map<string, Promise<readonly MemoryEntry[]>>()

  constructor(memoriesDir: string) {
    this.memoriesDir = resolve(memoriesDir)
  }

  /** Absolute directory of one scope. */
  scopeDir(scope: MemoryScope, projectRoot: string | undefined): string {
    if (scope === 'global') return this.memoriesDir
    if (projectRoot === undefined) throw new Error('dsh-memories: a project scope requires a workspace root')
    return join(this.memoriesDir, 'projects', projectSlug(projectRoot))
  }

  /** Entries directory of one scope (public for the dedupe helper). */
  entriesDirOf(scope: MemoryScope, projectRoot: string | undefined): string {
    return this.entriesDir(scope, projectRoot)
  }

  /** Entries directory of one scope. */
  private entriesDir(scope: MemoryScope, projectRoot: string | undefined): string {
    return join(this.scopeDir(scope, projectRoot), 'entries')
  }

  /** Index path of one scope. */
  private indexPath(scope: MemoryScope, projectRoot: string | undefined): string {
    return join(this.scopeDir(scope, projectRoot), 'index.json')
  }

  /** Resolve the model-facing target for one scope. */
  target(scope: MemoryScope, projectRoot: string | undefined): ScopeTarget {
    const dir = this.scopeDir(scope, projectRoot)
    const label = scope === 'global'
      ? 'global'
      : `project:${projectRoot === undefined ? 'unknown' : slugify(projectRoot.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? 'workspace')}`
    return { scope, dir, label }
  }

  /** Record how one project slug was derived, for diagnostics. */
  async writeProjectDescriptor(projectRoot: string, now = Date.now()): Promise<void> {
    const slug = projectSlug(projectRoot)
    const descriptor: ProjectDescriptor = {
      root: resolve(projectRoot),
      name: projectRoot.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? 'workspace',
      slug,
      updatedAt: now,
    }
    await writeAtomic(join(this.memoriesDir, 'projects', slug, 'project.json'), `${JSON.stringify(descriptor, undefined, 2)}\n`)
  }

  /** Read a project descriptor, when present. */
  async readProjectDescriptor(slug: string): Promise<ProjectDescriptor | undefined> {
    const text = await readText(join(this.memoriesDir, 'projects', slug, 'project.json'))
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as ProjectDescriptor
    } catch {
      return undefined
    }
  }

  /** List every project slug present on disk. */
  async listProjects(): Promise<readonly string[]> {
    try {
      const dirents = await readdir(join(this.memoriesDir, 'projects'), { withFileTypes: true })
      return dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name).sort()
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  /** Drop the cached index of one scope. */
  invalidate(scope: MemoryScope, projectRoot: string | undefined): void {
    this.cache.delete(this.scopeDir(scope, projectRoot))
  }

  /**
   * List one scope's entries, newest-updated first. The on-disk `index.json` is
   * preferred while it agrees with the directory's file count; otherwise the
   * directory is re-scanned and the index rewritten.
   * @param scope - scope to read.
   * @param projectRoot - workspace root for a project scope.
   * @param options - `fresh` bypasses the in-memory cache.
   * @returns every parsed entry in the scope.
   */
  async list(scope: MemoryScope, projectRoot: string | undefined, options: { fresh?: boolean } = {}): Promise<readonly MemoryEntry[]> {
    const dir = this.scopeDir(scope, projectRoot)
    if (options.fresh !== true) {
      const cached = this.cache.get(dir)
      if (cached !== undefined && Date.now() - cached.loadedAt < INDEX_TTL_MS) return cached.entries
      const inflight = this.pending.get(dir)
      if (inflight !== undefined) return inflight
    }
    const load = this.load(scope, projectRoot).finally(() => this.pending.delete(dir))
    this.pending.set(dir, load)
    return load
  }

  /** Scan one scope directory and refresh both the cache and the index file. */
  private async load(scope: MemoryScope, projectRoot: string | undefined): Promise<readonly MemoryEntry[]> {
    const dir = this.scopeDir(scope, projectRoot)
    const entriesDir = this.entriesDir(scope, projectRoot)
    let names: string[]
    try {
      const dirents = await readdir(entriesDir, { withFileTypes: true })
      names = dirents.filter((dirent) => dirent.isFile() && dirent.name.endsWith('.md')).map((dirent) => dirent.name)
    } catch (error) {
      if (!isMissing(error)) throw error
      names = []
    }
    const entries: MemoryEntry[] = []
    for (const name of names.sort()) {
      const text = await readText(join(entriesDir, name))
      if (text === undefined) continue
      const entry = parseEntry(text, scope, name.replace(/\.md$/u, ''))
      if (entry !== undefined) entries.push(entry)
    }
    entries.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    const deduped = await dedupeEntries(entries, this, scope, projectRoot, this.keepIds)
    this.cache.set(dir, { entries: deduped, loadedAt: Date.now() })
    await this.writeIndex(scope, projectRoot, deduped).catch(() => undefined)
    return deduped
  }

  /** Rewrite one scope's index cache file. */
  private async writeIndex(scope: MemoryScope, projectRoot: string | undefined, entries: readonly MemoryEntry[]): Promise<void> {
    const document = {
      version: 1,
      scope,
      updatedAt: new Date().toISOString(),
      count: entries.length,
      entries: entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        uses: entry.uses,
        lastUsedAt: entry.lastUsedAt,
        source: entry.source,
        bytes: Buffer.byteLength(entry.body, 'utf8'),
      })),
    }
    await writeAtomic(this.indexPath(scope, projectRoot), `${JSON.stringify(document, undefined, 2)}\n`)
  }

  /** Read one entry by id. */
  async read(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<MemoryEntry | undefined> {
    const text = await readText(join(this.entriesDir(scope, projectRoot), `${slugify(id)}.md`))
    if (text === undefined) return undefined
    return parseEntry(text, scope, slugify(id))
  }

  /**
   * Mirror usage counters into the entry file.
   *
   * The authoritative counter lives in the state database, which updates it
   * atomically; this write only keeps the markdown a complete picture for a
   * human reader. Deliberately best-effort: a failed mirror never fails the
   * caller's read.
   * @param entry - the entry that was used.
   * @param projectRoot - workspace root for a project entry.
   * @param counters - the counters the state store just committed.
   * @returns the updated entry, or the original when the write failed.
   */
  async writeCounters(
    entry: MemoryEntry,
    projectRoot: string | undefined,
    counters: { uses: number; lastUsedAt: number },
  ): Promise<MemoryEntry> {
    const updated: MemoryEntry = { ...entry, uses: counters.uses, lastUsedAt: counters.lastUsedAt }
    try {
      await writeAtomic(join(this.entriesDir(entry.scope, projectRoot), `${entry.id}.md`), formatEntry(updated))
      this.invalidate(entry.scope, projectRoot)
    } catch {
      return entry
    }
    return updated
  }

  /**
   * Insert or update one draft. The id is derived from the title, so writing
   * the same lesson twice updates the stored entry and preserves `createdAt`.
   * @param draft - the memory to persist.
   * @param projectRoot - workspace root for a project draft.
   * @param source - provenance recorded on the entry.
   * @param now - injected clock for deterministic tests.
   * @param keepId - write over this exact id instead of deriving one from the
   *   title; used by consolidation, where a rewritten memory keeps its identity.
   * @returns the stored entry and whether it was created or updated.
   */
  async upsert(
    draft: MemoryDraft,
    projectRoot: string | undefined,
    source: MemoryEntry['source'],
    now = Date.now(),
    keepId?: string,
  ): Promise<UpsertResult> {
    const id = slugify(keepId ?? draft.title)
    const existing = await this.read(draft.scope, projectRoot, id)
    const tags = [...new Set(draft.tags.map(normalizeTag).filter((tag) => tag.length > 0))].slice(0, 12)
    const entry: MemoryEntry = {
      id,
      scope: draft.scope,
      title: draft.title.trim(),
      body: draft.body.trim(),
      tags,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      uses: existing?.uses ?? 0,
      lastUsedAt: existing?.lastUsedAt ?? 0,
      source,
    }
    await writeAtomic(join(this.entriesDir(draft.scope, projectRoot), `${id}.md`), formatEntry(entry))
    if (draft.scope === 'project' && projectRoot !== undefined) await this.writeProjectDescriptor(projectRoot, now)
    this.invalidate(draft.scope, projectRoot)
    const limit = this.entryLimit()
    if (limit > 0) await this.evict(draft.scope, projectRoot, limit)
    this.keepIds = new Set([id])
    try {
      const entries = await this.list(draft.scope, projectRoot, { fresh: true })
      await this.writeIndex(draft.scope, projectRoot, entries).catch(() => undefined)
    } finally {
      this.keepIds = new Set()
    }
    return { entry, action: existing === undefined ? 'created' : 'updated' }
  }

  /** Delete one entry. Returns whether a file was removed. */
  async remove(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean> {
    const path = join(this.entriesDir(scope, projectRoot), `${slugify(id)}.md`)
    if (!(await exists(path))) return false
    await rm(path, { force: true })
    this.invalidate(scope, projectRoot)
    const entries = await this.list(scope, projectRoot, { fresh: true })
    await this.writeIndex(scope, projectRoot, entries).catch(() => undefined)
    return true
  }

  /** Enforce the per-scope cap by dropping the least recently updated entries. */
  private async evict(scope: MemoryScope, projectRoot: string | undefined, limit: number): Promise<void> {
    const entries = await this.list(scope, projectRoot, { fresh: true })
    if (entries.length <= limit) return
    for (const entry of entries.slice(limit)) {
      await rm(join(this.entriesDir(scope, projectRoot), `${entry.id}.md`), { force: true })
    }
    this.invalidate(scope, projectRoot)
  }

  /**
   * Per-scope entry cap, read at write time so a settings change applies to the
   * very next write. The plugin installs its live settings thunk here.
   */
  entryLimit: () => number = () => 0

  /** Ids that must survive the next dedupe pass (the entry just written). */
  private keepIds: ReadonlySet<string> = new Set()
}
