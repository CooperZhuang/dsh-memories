/**
 * Workspace root discovery, shared by the project scope and the injector.
 *
 * @module dsh-memories/workspace
 */
import { dirname, resolve, sep } from 'node:path'
import { stat } from 'node:fs/promises'

/**
 * Whether one path is another, or lives underneath it.
 *
 * Case-insensitive on Windows, because two spellings of one directory are one
 * directory there and the comparison decides whether a directory counts as the
 * harness home.
 *
 * @param parent - the containing directory.
 * @param path - the path to test.
 * @returns true when `path` is `parent` or inside it.
 */
export function isWithin(parent: string, path: string): boolean {
  const base = resolve(parent)
  const target = resolve(path)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix)
}

/** Whether a filesystem error means "absent". */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Whether one path exists, whatever its type. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    return false
  }
}

/**
 * Walk upward from `cwd` to the first directory containing a configured root
 * marker, so every session opened in a subdirectory shares one project scope.
 * @param cwd - absolute session working directory.
 * @param markers - child names that identify a workspace root.
 * @returns the discovered root, or the resolved `cwd` when no marker exists.
 */
export async function findProjectRoot(cwd: string, markers: readonly string[]): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await exists(resolve(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}
