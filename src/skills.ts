/**
 * Skill drafts and their promotion into the harness's skill roots.
 *
 * Consolidation can notice that several memories describe one repeatable
 * procedure. Writing that straight into `$DSH_HOME/skills` would silently grow
 * the model's skill catalog from a background pass, so the draft lands in the
 * memory store instead and a human promotes it:
 *
 * ```text
 * $DSH_HOME/memories/skills/<name>/SKILL.md   # draft, not yet loaded by DSH
 * $DSH_HOME/skills/<name>/SKILL.md            # promoted, now in the catalog
 * ```
 *
 * Promotion is explicit (`/memories promote <name>`) and idempotent: the file
 * written is exactly the shape `@deepseek-ai/dsh-skill-filesystem` parses
 * (`name` + `description` frontmatter in a per-skill directory).
 *
 * @module dsh-memories/skills
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SkillDraft } from './consolidate.js'

/** The skill-name grammar the harness loader accepts. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether a filesystem error means "absent". */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
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

/** Normalize a proposed name into the harness grammar, or `undefined`. */
export function normalizeSkillName(value: string): string | undefined {
  const name = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  return SKILL_NAME.test(name) ? name : undefined
}

/**
 * Encode one frontmatter value as a YAML double-quoted scalar.
 *
 * A plain scalar breaks the document as soon as the value contains a mapping
 * colon, a leading indicator (`-`, `#`, `[`), or a newline — and the harness
 * loader responds by SKIPPING the skill with a warning nobody sees, so the
 * promoted file would sit in the skill root and never reach the catalog. Quoting
 * makes every value safe, including the model-authored descriptions that
 * consolidation produces.
 *
 * @param value - the raw text.
 * @returns a double-quoted YAML scalar with the escapes YAML defines.
 */
function yamlScalar(value: string): string {
  return `"${value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r\n|\r|\n/gu, '\\n')
    .replace(/\t/gu, '\\t')}"`
}

/**
 * Render one draft as the markdown the harness loader reads.
 * @param draft - the proposed skill.
 * @returns a `SKILL.md` body with the required frontmatter.
 */
export function renderSkillFile(draft: SkillDraft): string {
  return [
    '---',
    `name: ${draft.name}`,
    `description: ${yamlScalar(draft.description)}`,
    '---',
    '',
    ...draft.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
  ].join('\n')
}

/** Where skill drafts live inside the memory store. */
export function draftRoot(memoriesDir: string): string {
  return join(memoriesDir, 'skills')
}

/** Where the harness discovers promoted skills. */
export function promotionRoot(dshHome: string): string {
  return join(dshHome, 'skills')
}

/**
 * Write or replace one skill draft in the memory store.
 *
 * The write is atomic at the file level (a temp file renamed over the target),
 * so a crash cannot leave a half-written `SKILL.md` that the loader would then
 * try to parse.
 *
 * @param memoriesDir - the memory store root.
 * @param draft - the skill to stage.
 * @returns the absolute path of the staged file.
 */
export async function writeDraft(memoriesDir: string, draft: SkillDraft): Promise<string> {
  const name = normalizeSkillName(draft.name)
  if (name === undefined) throw new Error(`dsh-memories: invalid skill name ${JSON.stringify(draft.name)}`)
  const dir = join(draftRoot(memoriesDir), name)
  const path = join(dir, 'SKILL.md')
  await mkdir(dir, { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, renderSkillFile({ ...draft, name }), 'utf8')
  await rename(temp, path)
  return path
}

/** One staged draft as reported to a human. */
export interface StagedSkill {
  /** Skill name. */
  readonly name: string
  /** Description from the draft's frontmatter, when present. */
  readonly description: string
  /** Absolute path of the draft file. */
  readonly path: string
}

/**
 * List the staged drafts.
 * @param memoriesDir - the memory store root.
 * @returns the drafts, name-sorted.
 */
export async function listDrafts(memoriesDir: string): Promise<StagedSkill[]> {
  const root = draftRoot(memoriesDir)
  let names: string[]
  try {
    const dirents = await readdir(root, { withFileTypes: true })
    names = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const staged: StagedSkill[] = []
  for (const name of names) {
    const path = join(root, name, 'SKILL.md')
    if (!(await exists(path))) continue
    const text = await readFile(path, 'utf8')
    staged.push({ name, description: descriptionOf(text), path })
  }
  return staged
}

/**
 * Read the description out of one `SKILL.md` frontmatter block.
 *
 * Drafts written by this module carry a double-quoted scalar (see
 * {@link yamlScalar}); a hand-edited file may carry a plain one, so both are
 * accepted and the quotes are stripped only when they wrap the whole value.
 */
function descriptionOf(text: string): string {
  const end = text.indexOf('\n---', 3)
  const header = end < 0 ? '' : text.slice(3, end)
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    if (line.slice(0, separator).trim().toLowerCase() !== 'description') continue
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
  return ''
}

/**
 * Copy one staged draft into the harness's skill root.
 *
 * Copies rather than moves, so the memory store keeps the provenance and the
 * promoted file is an independent artifact a human can edit. Re-promoting
 * overwrites, which is what makes it a safe retry.
 *
 * @param memoriesDir - the memory store root.
 * @param dshHome - the harness home whose `skills/` the loader scans.
 * @param name - the draft to promote.
 * @returns the absolute path of the promoted skill, or `undefined` when no such draft exists.
 */
export async function promote(memoriesDir: string, dshHome: string, name: string): Promise<string | undefined> {
  const normalized = normalizeSkillName(name)
  if (normalized === undefined) return undefined
  const source = join(draftRoot(memoriesDir), normalized, 'SKILL.md')
  if (!(await exists(source))) return undefined
  const target = join(promotionRoot(dshHome), normalized, 'SKILL.md')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readFile(source, 'utf8'), 'utf8')
  return target
}

/** Remove one staged draft. */
export async function discardDraft(memoriesDir: string, name: string): Promise<boolean> {
  const normalized = normalizeSkillName(name)
  if (normalized === undefined) return false
  const dir = join(draftRoot(memoriesDir), normalized)
  if (!(await exists(dir))) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
