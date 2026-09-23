/**
 * Citation checking: does a memory point at a file that is still there?
 *
 * The most damaging kind of wrong memory is the one that is specific and
 * checkable: "the report is at `output/market_report.json`", "run
 * `scripts/start_sap_test.bat`". Both were true when written, both were later
 * deleted, and a future session acting on them wastes a turn or, worse, concludes
 * that working code is broken. Measured on a real store, 16 of 242 cited paths
 * could not be found in any known checkout.
 *
 * The check is deliberately conservative. A relative path is only reported when
 * its parent directory IS found but the file is not — that is a strong signal of
 * "this moved or was deleted". When the parent is missing too, the memory may
 * simply be describing another checkout, and guessing would produce noise that
 * trains the reader to ignore the flag.
 *
 * @module dsh-memories/citations
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** Whether a path exists. Injected so the rule can be tested without a filesystem. */
export type PathProbe = (path: string) => boolean

/** The default probe: the real filesystem. */
export const fileProbe: PathProbe = (path) => existsSync(path)

/**
 * Relative paths a body cites.
 *
 * Only things with a directory component and a file extension are considered:
 * a bare `index.js` names a file in a dozen packages, so it cannot be checked,
 * and prose like `and/or` should never be mistaken for a path.
 *
 * @param text - the entry body.
 * @returns unique relative paths, in first-seen order.
 */
export function extractCitations(text: string): string[] {
  const pattern = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,6})\b/gu
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const raw = match[1]
    if (raw === undefined) continue
    // A URL's path is not a repository path. The scheme itself is outside the
    // match, so look at what precedes it.
    const before = text.slice(Math.max(0, (match.index ?? 0) - 3), match.index ?? 0)
    if (before.includes('//')) continue
    const cleaned = raw.replace(/^\.\//u, '').replace(/\/+/gu, '/')
    if (cleaned.startsWith('/') || cleaned.includes('://')) continue
    // A trailing segment that is a hidden directory (`app/.tools`) is not a file
    // path, and the check can only ask whether files exist.
    const last = cleaned.split('/').at(-1) ?? ''
    if (last.startsWith('.')) continue
    // Reject slash-joined lists of same-extension files (`config.ts/index.ts`).
    const parts = cleaned.split('/')
    if (parts.length > 1 && parts.every((part) => /\.(ts|js|mjs|py)$/u.test(part))) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    found.push(cleaned)
  }
  return found
}

/** Whether any known root contains this relative path. */
function presentUnder(roots: readonly string[], relativePath: string, probe: PathProbe): boolean {
  return roots.some((root) => probe(join(root, relativePath)))
}

/**
 * Whether any known root contains a directory with this name at this depth.
 *
 * Used only to decide whether a missing file is *evidence* of staleness: the
 * parent chain existing somewhere while the file does not is the signal.
 *
 * @param roots - checkout roots to search.
 * @param relativePath - the cited path, parent included.
 * @param probe - filesystem probe.
 * @returns true when the parent directory exists under some root.
 */
function parentExists(roots: readonly string[], relativePath: string, probe: PathProbe): boolean {
  const parent = dirname(relativePath)
  if (parent === '.' || parent.length === 0) return false
  return roots.some((root) => probe(join(root, parent)))
}

/**
 * Citations in one body that no longer resolve under any known root.
 *
 * @param body - the entry body.
 * @param roots - checkout roots (project roots, the harness home, package dirs).
 * @param probe - filesystem probe, for tests.
 * @param options - extra rules; `isIgnored` suppresses a path the repository
 *   itself generates (see {@link isIgnoredPath}).
 * @returns the paths that look deleted or moved.
 */
export function missingCitations(
  body: string,
  roots: readonly string[],
  probe: PathProbe = fileProbe,
  options: { readonly isIgnored?: (relativePath: string) => boolean } = {},
): string[] {
  if (roots.length === 0) return []
  const missing: string[] = []
  for (const citation of extractCitations(body)) {
    if (presentUnder(roots, citation, probe)) continue
    if (!parentExists(roots, citation, probe)) continue
    // A generated file is not a stale citation. Measured on a real store, three
    // of twelve flagged memories named runtime artifacts (`state/run.json`, a
    // cache database, a synced local-state file) that are absent between runs by
    // design; a warning that cries wolf is a warning the reader learns to skip.
    if (options.isIgnored?.(citation) === true) continue
    missing.push(citation)
  }
  return missing
}

/** One parsed `.gitignore` rule. */
export interface IgnoreRule {
  /** Pattern text, without the leading `!` or the trailing `/`. */
  readonly pattern: string
  /** Whether this rule re-includes a path an earlier rule excluded. */
  readonly negated: boolean
  /** Whether the pattern is anchored to the ignore file's own directory. */
  readonly anchored: boolean
  /** Whether the pattern names a directory rather than a file. */
  readonly directory: boolean
}

/**
 * Parse one `.gitignore` body.
 *
 * Only the subset that decides "is this path generated" is supported: comments,
 * blank lines, negation, a leading or embedded slash for anchoring, a trailing
 * slash for directories, and `*` / `**` / `?` globs. Character classes and
 * escaped leading `#`/`!` are treated literally, which can only make the check
 * miss an exclusion — never invent one.
 *
 * @param text - the file's contents.
 * @returns the rules, in file order (git gives the last match the last word).
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    let body = negated ? line.slice(1).trim() : line
    if (body.length === 0) continue
    const directory = body.endsWith('/')
    if (directory) body = body.slice(0, -1)
    // A slash anywhere but the end anchors the pattern to the ignore file.
    const anchored = body.startsWith('/') || body.includes('/')
    if (body.startsWith('/')) body = body.slice(1)
    if (body.length === 0) continue
    rules.push({ pattern: body, negated, anchored, directory })
  }
  return rules
}

/**
 * Read the ignore rules that govern paths relative to one root.
 *
 * Deliberately one file: the root's own `.gitignore`. Parent directories and
 * global excludes are not consulted, so a path covered only by those is still
 * reported — the conservative direction for a check whose job is to warn.
 *
 * @param root - repository root.
 * @returns the rules, or an empty list when there is no readable `.gitignore`.
 */
export function readGitignore(root: string): IgnoreRule[] {
  try {
    return parseGitignore(readFileSync(join(root, '.gitignore'), 'utf8'))
  } catch {
    return []
  }
}

/** Translate one gitignore pattern into a whole-string regular expression. */
function ignorePatternToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          source += '(?:.*/)?'
          index += 1
        } else if (source.endsWith('/')) {
          source = `${source.slice(0, -1)}(?:/.*)?`
        } else {
          source += '.*'
        }
        continue
      }
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u')
}

/** Whether one rule matches a path, given its segments. */
function ruleMatches(rule: IgnoreRule, path: string, segments: readonly string[]): boolean {
  const regex = ignorePatternToRegExp(rule.pattern)
  if (rule.anchored) {
    if (!rule.directory) return regex.test(path)
    // Every directory on the way down is a candidate, never the file itself.
    for (let depth = 1; depth < segments.length; depth += 1) {
      if (regex.test(segments.slice(0, depth).join('/'))) return true
    }
    return false
  }
  // Unanchored patterns name one component and match it at any depth.
  const last = segments.length - 1
  for (let index = 0; index < segments.length; index += 1) {
    if (rule.directory && index === last) continue
    if (regex.test(segments[index] ?? '')) return true
  }
  return false
}

/**
 * Whether a repository's own ignore rules cover this relative path.
 *
 * The last matching rule decides, exactly as git does, so a `!` re-inclusion is
 * honoured.
 *
 * @param relativePath - the cited path, relative to the root the rules came from.
 * @param rules - rules from {@link parseGitignore} / {@link readGitignore}.
 * @returns true when the path is one the repository generates.
 */
export function isIgnoredPath(relativePath: string, rules: readonly IgnoreRule[]): boolean {
  if (rules.length === 0) return false
  const path = relativePath.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+/u, '')
  if (path.length === 0) return false
  const segments = path.split('/')
  let ignored = false
  for (const rule of rules) {
    if (ruleMatches(rule, path, segments)) ignored = !rule.negated
  }
  return ignored
}

/**
 * A predicate that suppresses generated paths under one root.
 *
 * @param root - repository root whose `.gitignore` applies.
 * @returns a predicate for {@link missingCitations}.
 */
export function ignoredUnder(root: string): (relativePath: string) => boolean {
  const rules = readGitignore(root)
  return (relativePath) => isIgnoredPath(relativePath, rules)
}

/**
 * Roots worth checking a project's memories against.
 *
 * A memory cites files relative to the repository it is about, so its own project
 * root comes first; the harness home covers memories about profiles and
 * settings, and one level of `node_modules` covers citations that name installed
 * package sources.
 *
 * @param projectRoot - the owning workspace root, when there is one.
 * @param extra - further roots the caller knows about (e.g. the harness home).
 * @returns roots to search, most specific first.
 */
export function citationRoots(projectRoot: string | undefined, extra: readonly string[] = []): string[] {
  const roots: string[] = []
  if (projectRoot !== undefined && projectRoot.length > 0) roots.push(projectRoot)
  for (const root of extra) if (root.length > 0 && !roots.includes(root)) roots.push(root)
  return roots
}

/**
 * The marker appended to a summary bullet whose citations no longer resolve.
 *
 * @param missing - the paths that could not be found.
 * @returns one short clause, or an empty string.
 */
export function citationWarning(missing: readonly string[]): string {
  if (missing.length === 0) return ''
  const shown = missing.slice(0, 2).join('、')
  const more = missing.length > 2 ? ` 等 ${missing.length} 处` : ''
  return `⚠ 引用的 ${shown}${more} 已不存在，以实测为准`
}

/** Whether a path is inside a root (used by callers that filter roots). */
export function isInside(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(root, path)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Whether a path is an existing directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
