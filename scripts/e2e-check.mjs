/**
 * Inspect the live memory store: entries, staged skill drafts, watermarks, and
 * the consolidation job.
 *
 * Usage: node scripts/e2e-check.mjs [memoriesDir]
 *
 * This is the readout for a real end-to-end run. The full flow is:
 *
 *   1. `dsh --profile web --patch ./scripts/e2e.patch.yml` — the overlay shortens
 *      the idle timer so a pass fires in seconds and clears the cooldown
 *   2. In the browser: send a message worth remembering, wait for the idle pass,
 *      then run `/memories consolidate`
 *   3. Run this script to see what landed
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const memoriesDir = process.argv[2] ?? `${resolveDshHome()}/memories`

/** List the markdown entries in one directory, or nothing when it is absent. */
async function entries(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/** Print one scope's entries. */
async function showScope(label, dir) {
  const found = await entries(dir)
  console.log(`${label}: ${found.length === 0 ? '(none)' : found.join(', ')}`)
}

console.log('store:', memoriesDir)
await showScope('global', join(memoriesDir, 'entries'))
for (const project of await readdir(join(memoriesDir, 'projects')).catch(() => [])) {
  await showScope(`project ${project}`, join(memoriesDir, 'projects', project, 'entries'))
}
for (const draft of await readdir(join(memoriesDir, 'skills')).catch(() => [])) {
  const text = await readFile(join(memoriesDir, 'skills', draft, 'SKILL.md'), 'utf8').catch(() => '')
  console.log(`skill draft ${draft}: ${text.split('\n').slice(1, 3).join(' | ')}`)
}

try {
  const db = new DatabaseSync(join(memoriesDir, 'state.db'))
  console.log('sessions:', JSON.stringify(db.prepare('SELECT id, last_seq, contributed, activity_at FROM sessions').all()))
  console.log('jobs:', JSON.stringify(db.prepare('SELECT key, root, retries, last_error FROM jobs').all()))
  db.close()
} catch (error) {
  console.log('state.db:', error instanceof Error ? error.message : String(error))
}
