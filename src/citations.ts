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
import { existsSync, statSync } from 'node:fs'
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
 * @returns the paths that look deleted or moved.
 */
export function missingCitations(body: string, roots: readonly string[], probe: PathProbe = fileProbe): string[] {
  if (roots.length === 0) return []
  const missing: string[] = []
  for (const citation of extractCitations(body)) {
    if (presentUnder(roots, citation, probe)) continue
    if (!parentExists(roots, citation, probe)) continue
    missing.push(citation)
  }
  return missing
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
