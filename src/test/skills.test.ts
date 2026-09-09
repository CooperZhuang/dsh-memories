/**
 * Tests for skill drafts and their promotion.
 *
 * The rule under test: a background pass may PROPOSE a skill, but nothing
 * reaches the harness skill catalog until a human promotes it. These tests also
 * pin the file shape the harness loader parses, since a malformed `SKILL.md` is
 * silently ignored rather than reported.
 *
 * @module dsh-memories/test/skills.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discardDraft, draftRoot, listDrafts, normalizeSkillName, promote, promotionRoot, renderSkillFile, writeDraft } from '../skills.js'

/** Two temp roots: a memory store and a harness home. */
async function roots(t: { after: (fn: () => void | Promise<void>) => void }) {
  const memoriesDir = await mkdtemp(join(tmpdir(), 'dsh-memories-skills-'))
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-home-skills-'))
  t.after(async () => {
    await rm(memoriesDir, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  })
  return { memoriesDir, dshHome }
}

const DRAFT = { name: 'release-check', description: 'Ship a release safely', steps: ['Run the tests.', 'Tag the commit.', 'Publish.'] }

test('normalizeSkillName enforces the harness name grammar', () => {
  assert.equal(normalizeSkillName('Release Check'), 'release-check')
  assert.equal(normalizeSkillName('  --Weird__Name--  '), 'weird-name')
  assert.equal(normalizeSkillName(''), undefined)
  assert.equal(normalizeSkillName('---'), undefined)
})

test('renderSkillFile emits the frontmatter the loader requires', () => {
  const text = renderSkillFile(DRAFT)
  assert.match(text, /^---\nname: release-check\ndescription: "Ship a release safely"\n---\n/u)
  assert.match(text, /1\. Run the tests\./u)
  assert.match(text, /3\. Publish\./u)
})

test('a description that would break a plain YAML scalar is quoted', () => {
  // A mapping colon, a leading indicator, and a quote: all legal in a quoted
  // scalar, all fatal in a plain one — and the loader skips an unparsable skill
  // silently, so the promoted file would never reach the catalog.
  const text = renderSkillFile({ ...DRAFT, description: 'Probe: proves "it" works — see #1' })
  assert.match(text, /^description: "Probe: proves \\"it\\" works — see #1"$/mu)
  assert.match(renderSkillFile({ ...DRAFT, description: 'line one\nline two' }), /^description: "line one\\nline two"$/mu)
})

test('a quoted description survives a write/list round trip', async (t) => {
  const { memoriesDir } = await roots(t)
  const description = 'Probe: proves a promoted draft reaches the catalog.'
  await writeDraft(memoriesDir, { ...DRAFT, description })
  const staged = await listDrafts(memoriesDir)
  assert.equal(staged[0]?.description, description)
})

test('a draft is staged under the memory store, not the skill root', async (t) => {
  const { memoriesDir, dshHome } = await roots(t)
  const path = await writeDraft(memoriesDir, DRAFT)
  assert.equal(path, join(draftRoot(memoriesDir), 'release-check', 'SKILL.md'))
  assert.match(await readFile(path, 'utf8'), /name: release-check/u)
  // Nothing lands in the catalog yet.
  await assert.rejects(() => stat(promotionRoot(dshHome)), /ENOENT/u)

  const staged = await listDrafts(memoriesDir)
  assert.equal(staged.length, 1)
  assert.equal(staged[0]?.name, 'release-check')
  assert.equal(staged[0]?.description, 'Ship a release safely')
})

test('promotion copies the draft into the harness skill root', async (t) => {
  const { memoriesDir, dshHome } = await roots(t)
  await writeDraft(memoriesDir, DRAFT)
  const target = await promote(memoriesDir, dshHome, 'release-check')
  assert.equal(target, join(promotionRoot(dshHome), 'release-check', 'SKILL.md'))
  assert.equal(await readFile(target as string, 'utf8'), await readFile(join(draftRoot(memoriesDir), 'release-check', 'SKILL.md'), 'utf8'))
  // The draft stays put: the store keeps the provenance.
  assert.equal((await listDrafts(memoriesDir)).length, 1)
})

test('promotion is idempotent and reports an unknown name', async (t) => {
  const { memoriesDir, dshHome } = await roots(t)
  await writeDraft(memoriesDir, DRAFT)
  assert.ok(await promote(memoriesDir, dshHome, 'release-check') !== undefined)
  assert.ok(await promote(memoriesDir, dshHome, 'release-check') !== undefined)
  assert.equal(await promote(memoriesDir, dshHome, 'nope'), undefined)
  assert.equal(await promote(memoriesDir, dshHome, '!!!'), undefined)
})

test('a promoted skill is a file the loader would parse', async (t) => {
  const { memoriesDir, dshHome } = await roots(t)
  await writeDraft(memoriesDir, DRAFT)
  const target = await promote(memoriesDir, dshHome, 'release-check')
  const text = await readFile(target as string, 'utf8')
  // The directory-bundle layout is <root>/<name>/SKILL.md with name+description.
  assert.ok(target?.endsWith(join('skills', 'release-check', 'SKILL.md')))
  assert.equal(text.startsWith('---\n'), true)
  assert.match(text, /^name: release-check$/mu)
  assert.match(text, /^description: .+$/mu)
})

test('discard removes one staged draft and reports the truth', async (t) => {
  const { memoriesDir } = await roots(t)
  await writeDraft(memoriesDir, DRAFT)
  assert.equal(await discardDraft(memoriesDir, 'release-check'), true)
  assert.equal(await discardDraft(memoriesDir, 'release-check'), false)
  assert.deepEqual(await listDrafts(memoriesDir), [])
})

test('staging an invalid name is refused', async (t) => {
  const { memoriesDir } = await roots(t)
  await assert.rejects(() => writeDraft(memoriesDir, { ...DRAFT, name: '!!!' }), /invalid skill name/u)
})
