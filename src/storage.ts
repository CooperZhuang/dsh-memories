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
 *   skills/<name>/SKILL.md         # staged skill drafts, not yet promoted
 *   state.db                       # SQLite: watermarks, jobs, usage counters
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
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { MemoryDraft, MemoryEntry, MemoryScope, ScopeTarget, UpsertResult } from './types.js'
import { toMemoryDurability, toMemoryKind } from './types.js'

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
  const keys = entry.keys.length > 0 ? `keys: ${entry.keys.join(', ')}` : undefined
  return [
    FENCE,
    `id: ${entry.id}`,
    `scope: ${entry.scope}`,
    `kind: ${entry.kind}`,
    `title: ${entry.title}`,
    tags,
    ...keys === undefined ? [] : [keys],
    ...entry.appliesTo !== undefined && entry.appliesTo.length > 0 ? [`appliesTo: ${entry.appliesTo}`] : [],
    ...entry.durability === 'snapshot' ? ['durability: snapshot'] : [],
    ...entry.durability === 'snapshot' && entry.asOf !== undefined ? [`asOf: ${new Date(entry.asOf).toISOString()}`] : [],
    ...entry.pinned === true ? ['pinned: true'] : [],
    ...entry.supersedes !== undefined && entry.supersedes.length > 0 ? [`supersedes: ${entry.supersedes}`] : [],
    ...entry.sourceSession !== undefined && entry.sourceSession.length > 0 ? [`session: ${entry.sourceSession}`] : [],
    `created: ${new Date(entry.createdAt).toISOString()}`,
    `updated: ${new Date(entry.updatedAt).toISOString()}`,
    `source: ${entry.source}`,
    `uses: ${entry.uses}`,
    `lastUsed: ${entry.lastUsedAt > 0 ? new Date(entry.lastUsedAt).toISOString() : 'never'}`,
    `lastSurfaced: ${entry.lastSurfacedAt > 0 ? new Date(entry.lastSurfacedAt).toISOString() : 'never'}`,
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
  const appliesTo = fields.get('appliesto')
  const durability = toMemoryDurability(fields.get('durability'))
  const asOf = parseTime(fields.get('asof'), 0)
  const pinned = fields.get('pinned') === 'true'
  const supersedes = fields.get('supersedes')
  const sourceSession = fields.get('session')
  const keys = (fields.get('keys') ?? '').split(',').map(normalizeKey).filter((key) => key.length > 0)
  return {
    id: fields.get('id') ?? fallbackId,
    scope,
    // An entry written before kinds existed is a plain fact; the schema grew
    // without a migration because the default is the old behaviour.
    kind: toMemoryKind(fields.get('kind')),
    title,
    body,
    tags: (fields.get('tags') ?? '').split(',').map(normalizeTag).filter((tag) => tag.length > 0),
    keys,
    ...appliesTo !== undefined && appliesTo.length > 0 ? { appliesTo } : {},
    ...durability === 'snapshot' ? { durability, ...asOf > 0 ? { asOf } : {} } : {},
    ...pinned ? { pinned: true } : {},
    ...supersedes !== undefined && supersedes.length > 0 ? { supersedes } : {},
    ...sourceSession !== undefined && sourceSession.length > 0 ? { sourceSession } : {},
    createdAt: parseTime(fields.get('created'), updatedAt),
    updatedAt,
    uses: Number.isFinite(rawUses) && rawUses > 0 ? Math.trunc(rawUses) : 0,
    lastUsedAt: parseTime(fields.get('lastused'), 0),
    lastSurfacedAt: parseTime(fields.get('lastsurfaced'), 0),
    source,
  }
}

/**
 * Normalize one search key: lowercase, comma-free, length-capped.
 *
 * Keys are the aliases and keyphrases a memory should also be found by, so they
 * are stored comma-separated beside the tags and matched by the same scorer.
 * @param value - the raw key.
 * @returns the normalized key.
 */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[,\s]+/gu, ' ').trim().slice(0, 48)
}

/**
 * Split text into a token set for similarity comparison.
 *
 * Single-character tokens are kept, deliberately. Dropping them is tempting —
 * "a", "1", "9" all look like noise — but they are exactly what distinguishes
 * two memories that share the rest of their wording, and this token set decides
 * whether one of them gets deleted. With them gone, "Old fact 1" and "Old fact
 * 2" both reduce to {old, fact} and are treated as one memory; measured on a
 * real store, nine of twenty distinct numbered entries were destroyed that way,
 * and the same shape covers "端口 3080" against "端口 8080". A missed merge costs
 * one slot in the summary; a false merge costs nothing permanent any more,
 * because the loser is archived rather than deleted and `/memories restore`
 * brings it back — but a false merge still costs a slot until someone notices,
 * so the rule stays narrow.
 *
 * @param value - raw text.
 * @returns its lowercase word tokens, with CJK indexed as characters and pairs.
 */
function tokenSet(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of value.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length === 0) continue
    if (LATIN_RUN.test(raw)) {
      tokens.add(raw)
      continue
    }
    // CJK has no word boundaries: index single characters and adjacent pairs, so
    // a paraphrase still shares most of its shingles. Splitting on non-letters
    // left a whole Chinese sentence as one enormous token, which made every pair
    // of Chinese memories incomparable — measured on a real store, two entries
    // with character-for-character identical titles survived as two memories
    // because one body was Chinese and the other English.
    const chars = [...raw]
    for (const char of chars) tokens.add(char)
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.add(`${chars[index]}${chars[index + 1]}`)
  }
  return tokens
}

/** A token that is already a word: Latin letters, digits, and underscores. */
const LATIN_RUN = /^[0-9a-z_]+$/u

/** Jaccard overlap of two token sets; `0` when either side is empty. */
export function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Whether two memories are close enough to be one memory re-worded.
 *
 * Both halves must agree. Titles that overlap while bodies do not are two
 * different lessons that happen to be named alike, and collapsing those loses
 * what no later pass can recover.
 * @param left - one memory, or a draft.
 * @param right - the other.
 * @param threshold - minimum title overlap; the body must reach half of it.
 * @returns true when the two should be treated as the same memory.
 */
export function isNearDuplicate(left: { title: string; body: string }, right: { title: string; body: string }, threshold: number): boolean {
  if (threshold <= 0) return false
  if (overlap(tokenSet(left.title), tokenSet(right.title)) < threshold) return false
  return overlap(tokenSet(left.body), tokenSet(right.body)) >= Math.min(0.5, threshold)
}

/** Normalize text for duplicate detection: case- and whitespace-insensitive. */
function fingerprint(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** A character that is part of a Latin or digit word, for phrase boundaries. */
const WORD_CHAR = /[0-9a-z]/iu

/**
 * Whether one normalized field contains another as a whole phrase.
 *
 * A plain `includes` is wrong here, and expensively so: losers of this rule are
 * DELETED, not archived. "Old fact 19" contains "Old fact 1", so a numbered
 * family of memories collapses into whichever member is longest — measured on a
 * real store, four distinct entries became two.
 *
 * CJK has no word boundaries, so a CJK neighbour does not block a match (記憶
 * inside 記憶庫 is still the same phrase); a Latin or digit neighbour does.
 *
 * @param haystack - the normalized field, longer or shorter.
 * @param needle - the normalized phrase to look for.
 * @returns true when the phrase occurs with boundaries on both sides.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? undefined : haystack[at - 1]
    const after = haystack[at + needle.length]
    if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) return true
  }
  return false
}

/**
 * Collapse entries that say the same thing under different ids.
 *
 * Ids come from titles, so a re-worded title creates a second file. Left alone
 * the store would slowly fill with near-copies that all compete for the bounded
 * summary budget. Two entries collide when their normalized titles are equal
 * (regardless of body, because that is one memory written twice), when BOTH
 * normalized title and body match, when one contains the other's title and body
 * as phrases, or when title and body token overlap both clear `similarity` — a
 * deliberately narrow rule, because collapsing on the body alone would merge
 * genuinely distinct memories that share wording, and a plain substring test
 * would swallow "Old fact 1" into "Old fact 19". The most recently updated entry
 * wins and the losers are archived, not deleted: a judgement made without a
 * model's help must be reversible.
 *
 * @param entries - entries in one scope, newest first.
 * @param store - owning store, used to archive the losers.
 * @param scope - the scope being deduplicated.
 * @param projectRoot - workspace root for a project scope.
 * @param keep - ids that must survive regardless of collisions.
 * @param similarity - title/body token overlap above which two entries collide.
 * @returns the surviving entries, newest first.
 */
async function dedupeEntries(
  entries: readonly MemoryEntry[],
  store: MemoryStore,
  scope: MemoryScope,
  projectRoot: string | undefined,
  keep: ReadonlySet<string>,
  similarity: number,
): Promise<MemoryEntry[]> {
  const winners: { title: string; body: string; entry: MemoryEntry }[] = []
  const losers: MemoryEntry[] = []
  for (const entry of entries) {
    const title = fingerprint(entry.title)
    const body = fingerprint(entry.body)
    const clash = winners.find((candidate) =>
      candidate.title === title
      || (candidate.title === title && candidate.body === body)
      || (candidate.title.length > 0 && containsPhrase(title, candidate.title) && containsPhrase(body, candidate.body))
      || (title.length > 0 && containsPhrase(candidate.title, title) && containsPhrase(candidate.body, body))
      || (similarity > 0 && isNearDuplicate(entry, candidate.entry, similarity)))
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
    // Archived rather than removed: this pass runs without a model's judgement,
    // and a wrong call must stay recoverable with `/memories restore`. Removal is
    // reserved for `/memories forget`, where a person asked for it.
    const archived = await store.archive(scope, projectRoot, loser.id).catch(() => false)
    if (!archived) await rm(join(store.entriesDirOf(scope, projectRoot), `${loser.id}.md`), { force: true })
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

/** How many per-session evidence notes the store keeps before the oldest go. */
export const SESSION_NOTE_LIMIT = 200

/**
 * Encode one frontmatter value as a YAML double-quoted scalar.
 *
 * A plain scalar breaks the document as soon as the value contains a mapping
 * colon, a leading indicator, or a newline, and both readers here respond by
 * ignoring the file. Quoting makes every value safe.
 *
 * @param value - the raw text.
 * @returns a double-quoted YAML scalar with the escapes YAML defines.
 */
export function yamlScalar(value: string): string {
  return `"${value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r\n|\r|\n/gu, '\\n')
    .replace(/\t/gu, '\\t')}"`
}

/**
 * One mined session's evidence note.
 *
 * The counterpart of Codex's `rollout_summaries/`: a memory records WHAT was
 * learned, and this records what the conversation was about, so a reader can
 * judge whether the memory still applies.
 */
export interface SessionNote {
  /** Session the note describes. */
  readonly session: string
  /** Unix epoch milliseconds when the note was written. */
  readonly at: number
  /** Scope label of the workspace it was mined in, when it had one. */
  readonly project?: string
  /** What the session was about, in the model's words. */
  readonly summary: string
  /** Ids of the entries this session contributed. */
  readonly memories: readonly string[]
}

/** Where per-session evidence notes live inside the memory store. */
export function sessionNotesDir(memoriesDir: string): string {
  return join(memoriesDir, 'sessions')
}

/** Read the first field of one note's frontmatter block. */
function noteField(header: string, name: string): string | undefined {
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    if (line.slice(0, separator).trim().toLowerCase() !== name) continue
    const raw = line.slice(separator + 1).trim()
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1)
        .replace(/\\n/gu, '\n')
        .replace(/\\t/gu, '\t')
        .replace(/\\"/gu, '"')
        .replace(/\\\\/gu, '\\')
    }
    return raw
  }
  return undefined
}

/**
 * Parse one evidence note.
 * @param text - file content.
 * @param fallbackSession - session id derived from the file name.
 * @returns the note, or `undefined` when the file is not a note.
 */
export function parseSessionNote(text: string, fallbackSession: string): SessionNote | undefined {
  const normalized = text.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith(FENCE)) return undefined
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length)
  if (end < 0) return undefined
  const header = normalized.slice(FENCE.length, end)
  const body = normalized.slice(end + FENCE.length + 1).replace(/^\n+/u, '').trim()
  const session = noteField(header, 'session') ?? fallbackSession
  const memories = (noteField(header, 'memories') ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0)
  const project = noteField(header, 'project')
  return {
    session,
    at: parseTime(noteField(header, 'at'), 0),
    ...project === undefined || project.length === 0 ? {} : { project },
    summary: body,
    memories,
  }
}

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
   * Delete project directories that hold nothing recoverable.
   *
   * A workspace that is renamed, moved, or simply never produces a memory leaves
   * its slug behind: measured on a real store, 12 of 19 project directories were
   * empty and 6 of those had no descriptor at all — one workspace even existed
   * under two slugs, its memories split between them.
   *
   * The test is "no markdown anywhere under the directory", which covers entries,
   * archives, and anything a future version files there. An archive alone is
   * enough to keep the directory: that is the file a human would restore from.
   * Recreating a slug is free, because it is derived from the workspace path, so
   * deleting an empty one cannot lose anything that a later write would not
   * recreate.
   *
   * @returns the slugs that were removed, for the caller to report.
   */
  async pruneEmptyProjects(): Promise<readonly string[]> {
    const removed: string[] = []
    for (const slug of await this.listProjects()) {
      const dir = join(this.memoriesDir, 'projects', slug)
      let files: string[]
      try {
        const dirents = await readdir(dir, { recursive: true, withFileTypes: true })
        files = dirents.filter((dirent) => dirent.isFile()).map((dirent) => dirent.name)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (files.some((name) => name.endsWith('.md'))) continue
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        // A directory another process is holding open is reported as kept, not as
        // pruned: this count is the only thing a reader sees, and a sweep that
        // claims work it did not do is worse than one that does nothing.
        continue
      }
      this.cache.delete(dir)
      removed.push(slug)
    }
    return removed
  }

  /**
   * Move a project scope whose directory name is not the slug its own root
   * derives onto the canonical directory.
   *
   * A slug is derived from the workspace path, so a scope written by an older
   * derivation can sit under a name the current one never produces — and then
   * every read path (`list`, `read`, search, the injected summary) resolves the
   * canonical directory, finds nothing there, and the memories are invisible
   * while still occupying disk. Measured on a real store, one project's two
   * memories were unreachable exactly this way.
   *
   * A canonical directory that already holds markdown is left alone and reported
   * instead of merged: two directories' worth of memories is a decision for a
   * person, not for a sweep.
   *
   * @returns the slug pairs that were re-homed, for the caller to report.
   */
  async adoptMisnamedProjects(): Promise<readonly { from: string; to: string }[]> {
    const moved: { from: string; to: string }[] = []
    for (const slug of await this.listProjects()) {
      const dir = join(this.memoriesDir, 'projects', slug)
      let descriptor: ProjectDescriptor | undefined
      try {
        descriptor = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as ProjectDescriptor
      } catch {
        continue
      }
      if (typeof descriptor.root !== 'string' || descriptor.root.length === 0) continue
      const target = dirname(this.entriesDir('project', descriptor.root))
      const canonical = basename(target)
      if (canonical === slug) continue
      if (await exists(join(target, 'index.json'))) {
        // The canonical directory already has its own index: re-homing would
        // overwrite one of the two. Leave both for a human to reconcile.
        this.cache.delete(dir)
        continue
      }
      try {
        await mkdir(target, { recursive: true })
        const dirents = await readdir(dir, { recursive: true, withFileTypes: true })
        for (const dirent of dirents) {
          if (!dirent.isFile()) continue
          const from = join(dirent.parentPath, dirent.name)
          const to = join(target, relative(dir, from))
          await mkdir(dirname(to), { recursive: true })
          await rename(from, to)
        }
        await rm(dir, { recursive: true, force: true })
      } catch {
        // A directory another process holds open stays where it is and is simply
        // not reported: a sweep that claims work it did not do is worse than one
        // that does nothing.
        continue
      }
      this.cache.delete(dir)
      this.cache.delete(target)
      moved.push({ from: slug, to: canonical })
    }
    return moved
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
    const deduped = await dedupeEntries(entries, this, scope, projectRoot, this.keepIds, this.similarityLimit())
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
        kind: entry.kind,
        title: entry.title,
        tags: entry.tags,
        ...entry.appliesTo === undefined ? {} : { appliesTo: entry.appliesTo },
        ...entry.durability === 'snapshot' ? { durability: entry.durability, ...entry.asOf === undefined ? {} : { asOf: entry.asOf } } : {},
        ...entry.pinned === true ? { pinned: true } : {},
        ...entry.supersedes === undefined ? {} : { supersedes: entry.supersedes },
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

  /**
   * Path of one entry file, tolerating ids a slug cannot round-trip.
   *
   * An id is a slugified title, but a collision suffix can leave a trailing `-`
   * that {@link slugify} strips on the way back in. For such an id the canonical
   * `<slugify(id)>.md` spelling does not exist on disk, so every id-addressed
   * operation — read, remove, archive, restore — silently misses it. Measured on
   * a real store, two entries were unreachable that way (one of them a duplicate
   * that could not be archived). The exact name wins whenever it is present.
   *
   * @param scope - owning scope.
   * @param projectRoot - workspace root for a project scope.
   * @param id - entry id as stored.
   * @returns the path to read or write.
   */
  private async entryFile(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<string> {
    const dir = this.entriesDir(scope, projectRoot)
    const canonical = `${slugify(id)}.md`
    if (`${id}.md` === canonical) return join(dir, canonical)
    const exact = join(dir, `${id}.md`)
    return await exists(exact) ? exact : join(dir, canonical)
  }

  /** Read one entry by id. */
  async read(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<MemoryEntry | undefined> {
    const text = await readText(await this.entryFile(scope, projectRoot, id))
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
    counters: { uses: number; lastUsedAt: number; surfacedAt?: number },
  ): Promise<MemoryEntry> {
    const updated: MemoryEntry = {
      ...entry,
      uses: counters.uses,
      lastUsedAt: counters.lastUsedAt,
      // A caller that mirrors only read counters must not erase a newer
      // surfaced mark.
      lastSurfacedAt: counters.surfacedAt ?? entry.lastSurfacedAt,
    }
    try {
      await writeAtomic(await this.entryFile(entry.scope, projectRoot, entry.id), formatEntry(updated))
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
    // Look the entry up by the id the caller gave, not by its slug: a `keepId`
    // that ends in `-` names a file whose slug is a different string, and
    // slugifying first would miss the file that is actually there.
    const existing = await this.read(draft.scope, projectRoot, keepId ?? id)
    // A rewrite keeps the file it already lives in. Writing `${id}.md` blindly
    // would put a second file beside an id whose name a slug cannot round-trip
    // (a trailing `-`), turning an update into a duplicate.
    const target = keepId === undefined || existing === undefined
      ? join(this.entriesDir(draft.scope, projectRoot), `${id}.md`)
      : await this.entryFile(draft.scope, projectRoot, keepId)
    const tags = [...new Set(draft.tags.map(normalizeTag).filter((tag) => tag.length > 0))].slice(0, 12)
    const keys = [...new Set((draft.keys ?? existing?.keys ?? []).map(normalizeKey).filter((key) => key.length > 0))].slice(0, 12)
    // A rewrite that omits `appliesTo` KEEPS the existing one, exactly like
    // `kind` and `keys`. Dropping it silently is a leak nothing downstream can
    // undo: measured on a real store, one background consolidation erased the
    // trigger phrase from 32 of 163 memories — the field that on-demand recall
    // gates on (recallMinTerms) — and the store cannot tell "left out" from
    // "meant to remove". A caller that really wants it gone can pass an empty
    // string, which is explicit.
    const appliesTo = draft.appliesTo === undefined ? existing?.appliesTo?.trim() : draft.appliesTo.trim()
    // Same rule as `appliesTo`: an omitted field means "unchanged". A snapshot
    // that a rewrite turned durable (or the reverse) has to say so explicitly,
    // and `durability: 'durable'` is how a caller clears it.
    const durability = draft.durability ?? existing?.durability ?? 'durable'
    const asOf = durability === 'snapshot' ? (draft.asOf ?? existing?.asOf) : undefined
    const pinned = draft.pinned ?? existing?.pinned ?? false
    const sourceSession = draft.sourceSession?.trim() ?? existing?.sourceSession
    // An explicit `supersedes` always wins; otherwise a near-identical memory
    // already in the scope is treated as the thing this one rewrites, so a
    // re-worded lesson replaces its predecessor instead of joining it.
    const explicit = draft.supersedes?.trim()
    const supersedes = explicit !== undefined && explicit.length > 0
      ? explicit
      : existing === undefined ? await this.findSimilar(draft, projectRoot, id) : undefined
    const entry: MemoryEntry = {
      id,
      scope: draft.scope,
      // A rewrite that omits the kind keeps the existing one rather than
      // silently demoting a preference to a fact.
      kind: draft.kind ?? existing?.kind ?? 'fact',
      title: draft.title.trim(),
      body: draft.body.trim(),
      tags,
      keys,
      ...appliesTo !== undefined && appliesTo.length > 0 ? { appliesTo } : {},
      ...durability === 'snapshot' ? { durability, ...asOf === undefined || asOf <= 0 ? { asOf: now } : { asOf } } : {},
      ...pinned ? { pinned: true } : {},
      ...supersedes !== undefined && supersedes.length > 0 ? { supersedes } : {},
      // Provenance survives a rewrite: a consolidation that re-words an entry
      // must not erase which conversation it came from.
      ...sourceSession !== undefined && sourceSession.length > 0 ? { sourceSession } : {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      uses: existing?.uses ?? 0,
      lastUsedAt: existing?.lastUsedAt ?? 0,
      lastSurfacedAt: existing?.lastSurfacedAt ?? 0,
      source,
    }
    await writeAtomic(target, formatEntry(entry))
    if (draft.scope === 'project' && projectRoot !== undefined) await this.writeProjectDescriptor(projectRoot, now)
    // Honour `supersedes`: the entry this one replaces is retired, in the same
    // scope, unless it IS this entry (an id can never supersede itself).
    // ARCHIVED, not removed. The near-duplicate pass already treats its loser as
    // recoverable, and an explicit rewrite has no better claim to destroy a
    // memory outright — `/memories forget` is the only deletion a caller can ask
    // for. Measured: the two paths disagreed, so a re-worded memory surviving its
    // predecessor depended on which of the two happened to fire.
    if (entry.supersedes !== undefined && entry.supersedes !== id) {
      await this.archive(draft.scope, projectRoot, entry.supersedes, now).catch(() => false)
    }
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
    const path = await this.entryFile(scope, projectRoot, id)
    if (!(await exists(path))) return false
    await rm(path, { force: true })
    await this.reindex(scope, projectRoot)
    return true
  }

  /**
   * Move one entry out of the live store without destroying it.
   *
   * Consolidation retires memories it judges stale and the per-scope cap
   * evicts the least recently updated; either judgement can be wrong. Deleting
   * the file would make a wrong judgement irreversible, so the entry is stamped
   * and moved to `archive/` beside its scope, where {@link restore} can bring it
   * back. The archive is bounded, so this is not an unbounded second store.
   *
   * @param scope - owning scope.
   * @param projectRoot - workspace root for a project scope.
   * @param id - entry id.
   * @param now - clock recorded in the archive stamp.
   * @returns whether an entry was archived.
   */
  async archive(scope: MemoryScope, projectRoot: string | undefined, id: string, now = Date.now()): Promise<boolean> {
    const source = await this.entryFile(scope, projectRoot, id)
    const text = await readText(source)
    if (text === undefined) return false
    const stamped = text.replace(/^---\r?\n/u, `---\narchived: ${new Date(now).toISOString()}\n`)
    await writeAtomic(join(this.archiveDir(scope, projectRoot), `${slugify(id)}.md`), stamped)
    await rm(source, { force: true })
    await this.reindex(scope, projectRoot)
    await this.evictArchive(scope, projectRoot)
    return true
  }

  /** Move one archived entry back into the live store. */
  async restore(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean> {
    const archived = join(this.archiveDir(scope, projectRoot), `${slugify(id)}.md`)
    const text = await readText(archived)
    if (text === undefined) return false
    const target = join(this.entriesDir(scope, projectRoot), `${slugify(id)}.md`)
    if (await exists(target)) return false
    await writeAtomic(target, text.replace(/^(---\n)archived: [^\n]*\n/u, '$1'))
    await rm(archived, { force: true })
    await this.reindex(scope, projectRoot)
    return true
  }

  /** Every archived entry in one scope, for the human-facing commands. */
  async listArchived(scope: MemoryScope, projectRoot: string | undefined): Promise<readonly MemoryEntry[]> {
    const dir = this.archiveDir(scope, projectRoot)
    let names: string[]
    try {
      const dirents = await readdir(dir, { withFileTypes: true })
      names = dirents.filter((dirent) => dirent.isFile() && dirent.name.endsWith('.md')).map((dirent) => dirent.name)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const entries: MemoryEntry[] = []
    for (const name of names.sort()) {
      const text = await readText(join(dir, name))
      if (text === undefined) continue
      const entry = parseEntry(text, scope, name.replace(/\.md$/u, ''))
      if (entry !== undefined) entries.push(entry)
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Rebuild one scope's cache and index after its entries directory changed. */
  private async reindex(scope: MemoryScope, projectRoot: string | undefined): Promise<void> {
    this.invalidate(scope, projectRoot)
    const entries = await this.list(scope, projectRoot, { fresh: true })
    await this.writeIndex(scope, projectRoot, entries).catch(() => undefined)
  }

  /** Directory holding one scope's archived entries. */
  private archiveDir(scope: MemoryScope, projectRoot: string | undefined): string {
    return join(this.scopeDir(scope, projectRoot), 'archive')
  }

  /** Keep one scope's archive bounded: the newest 500 files survive. */
  private async evictArchive(scope: MemoryScope, projectRoot: string | undefined, limit = 500): Promise<void> {
    const dir = this.archiveDir(scope, projectRoot)
    let names: string[]
    try {
      const dirents = await readdir(dir, { withFileTypes: true })
      names = dirents.filter((dirent) => dirent.isFile() && dirent.name.endsWith('.md')).map((dirent) => dirent.name)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    if (names.length <= limit) return
    const stamped: { name: string; at: number }[] = []
    for (const name of names) {
      const stat_ = await stat(join(dir, name)).catch(() => undefined)
      stamped.push({ name, at: stat_?.mtimeMs ?? 0 })
    }
    for (const row of stamped.sort((left, right) => right.at - left.at).slice(limit)) {
      await rm(join(dir, row.name), { force: true })
    }
  }

  /** Enforce the per-scope cap, archiving the least recently updated entries. */
  private async evict(scope: MemoryScope, projectRoot: string | undefined, limit: number): Promise<void> {
    const entries = await this.list(scope, projectRoot, { fresh: true })
    if (entries.length <= limit) return
    for (const entry of entries.slice(limit)) {
      await this.archive(scope, projectRoot, entry.id)
    }
  }

  /**
   * Find an existing memory the draft appears to rewrite.
   *
   * The id comes from the title, so a re-worded title creates a second file and
   * the store slowly fills with near-copies. The rule stays deliberately narrow
   * — see {@link isNearDuplicate} — because merging two genuinely distinct
   * memories loses information no later pass can recover.
   *
   * @param draft - the incoming memory.
   * @param projectRoot - workspace root for a project draft.
   * @param exclude - id to ignore, so a draft can never supersede itself.
   * @returns the id to supersede, or `undefined` when the draft is new.
   */
  private async findSimilar(draft: MemoryDraft, projectRoot: string | undefined, exclude: string): Promise<string | undefined> {
    if (this.similarityLimit() <= 0) return undefined
    const threshold = this.similarityLimit()
    const entries = await this.list(draft.scope, projectRoot)
    for (const entry of entries) {
      if (entry.id === exclude) continue
      if (isNearDuplicate(draft, entry, threshold)) return entry.id
    }
    return undefined
  }

  /**
   * Write one mined session's evidence note.
   *
   * This is the layer Codex keeps as `rollout_summaries/`: a memory says WHAT
   * was learned, and this note says what the conversation was about, so a reader
   * can judge whether the memory still applies — or go and re-read it.
   *
   * @param note - the note to persist.
   * @returns the absolute path written.
   */
  async writeSessionNote(note: SessionNote): Promise<string> {
    const dir = sessionNotesDir(this.memoriesDir)
    const path = join(dir, `${slugify(note.session)}.md`)
    const header = [
      FENCE,
      `session: ${yamlScalar(note.session)}`,
      `at: ${new Date(note.at).toISOString()}`,
      ...note.project === undefined ? [] : [`project: ${yamlScalar(note.project)}`],
      ...note.memories.length === 0 ? [] : [`memories: ${note.memories.join(', ')}`],
      FENCE,
      '',
    ].join('\n')
    await writeAtomic(path, `${header}${note.summary.trim()}\n`)
    await this.evictNotes()
    return path
  }

  /** Read one session's evidence note. */
  async readSessionNote(session: string): Promise<SessionNote | undefined> {
    const text = await readText(join(sessionNotesDir(this.memoriesDir), `${slugify(session)}.md`))
    if (text === undefined) return undefined
    return parseSessionNote(text, session)
  }

  /** Every evidence note's session id, newest write first. */
  async listSessionNotes(): Promise<readonly string[]> {
    const dir = sessionNotesDir(this.memoriesDir)
    let names: string[]
    try {
      const dirents = await readdir(dir, { withFileTypes: true })
      names = dirents.filter((dirent) => dirent.isFile() && dirent.name.endsWith('.md')).map((dirent) => dirent.name)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const stamped: { id: string; at: number }[] = []
    for (const name of names) {
      const stat_ = await stat(join(dir, name)).catch(() => undefined)
      stamped.push({ id: name.replace(/\.md$/u, ''), at: stat_?.mtimeMs ?? 0 })
    }
    return stamped.sort((left, right) => right.at - left.at).map((row) => row.id)
  }

  /** Keep the note store bounded: one small file per mined session, newest kept. */
  private async evictNotes(): Promise<void> {
    const ids = await this.listSessionNotes()
    for (const id of ids.slice(SESSION_NOTE_LIMIT)) {
      await rm(join(sessionNotesDir(this.memoriesDir), `${id}.md`), { force: true })
    }
  }

  /**
   * Per-scope entry cap, read at write time so a settings change applies to the
   * very next write. The plugin installs its live settings thunk here.
   */
  entryLimit: () => number = () => 0

  /**
   * Near-duplicate threshold, read at load and write time so a settings change
   * applies to the very next operation. `0` keeps only the exact-match rule.
   */
  similarityLimit: () => number = () => 0

  /** Ids that must survive the next dedupe pass (the entry just written). */
  private keepIds: ReadonlySet<string> = new Set()
}
