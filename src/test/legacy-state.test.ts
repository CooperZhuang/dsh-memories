/**
 * Tests for importing and removing the pre-SQLite state file.
 *
 * Upgrading must not silently re-mine conversations that were already
 * processed: a session with no watermark is treated as fresh, which spends
 * quota re-reading its transcript. The import also has to be incapable of
 * clobbering newer state.
 *
 * @module dsh-memories/test/legacy-state.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LEGACY_STATE_FILE, StateStore, importLegacyState, statePath } from '../state.js'

/** A temp memory store with a fresh state database. */
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-legacy-'))
  const store = new StateStore(statePath(dir))
  t.after(() => {
    store.close()
    return rm(dir, { recursive: true, force: true })
  })
  return { dir, store }
}

test('watermarks are imported and the legacy file is removed', async (t) => {
  const { dir, store } = await fixture(t)
  await writeFile(join(dir, LEGACY_STATE_FILE), JSON.stringify({
    version: 1,
    sessions: {
      'session-a': { lastSeq: 12, at: 1_000, root: 'C:\\work', contributed: true },
      'session-b': { lastSeq: 3, at: 2_000 },
      'session-zero': { lastSeq: 0, at: 5 },
    },
  }), 'utf8')

  const imported = await importLegacyState(store, dir)
  assert.equal(imported, 2, 'only watermarks with a real lastSeq are imported')
  assert.equal(store.getSession('session-a')?.lastSeq, 12)
  assert.equal(store.getSession('session-a')?.root, 'C:\\work')
  assert.equal(store.getSession('session-a')?.contributed, true)
  assert.equal(store.getSession('session-b')?.lastSeq, 3)
  assert.equal(store.getSession('session-zero'), undefined)
  // The activity clock falls back to the watermark time, the closest honest proxy.
  assert.equal(store.getSession('session-b')?.activityAt, 2_000)
  await assert.rejects(() => readFile(join(dir, LEGACY_STATE_FILE), 'utf8'), /ENOENT/u)
})

test('the import is skipped when the database already holds sessions', async (t) => {
  const { dir, store } = await fixture(t)
  store.putSession('session-a', { lastSeq: 99, at: 9_000, contributed: true })
  await writeFile(join(dir, LEGACY_STATE_FILE), JSON.stringify({
    version: 1,
    sessions: { 'session-a': { lastSeq: 1, at: 1 } },
  }), 'utf8')

  const imported = await importLegacyState(store, dir)
  assert.equal(imported, 0, 'newer state is never overwritten')
  assert.equal(store.getSession('session-a')?.lastSeq, 99)
  await assert.rejects(() => readFile(join(dir, LEGACY_STATE_FILE), 'utf8'), /ENOENT/u)
})

test('a corrupt legacy file is removed without throwing', async (t) => {
  const { dir, store } = await fixture(t)
  await writeFile(join(dir, LEGACY_STATE_FILE), 'not json at all', 'utf8')
  assert.equal(await importLegacyState(store, dir), 0)
  await assert.rejects(() => readFile(join(dir, LEGACY_STATE_FILE), 'utf8'), /ENOENT/u)
})

test('no legacy file means nothing to do', async (t) => {
  const { dir, store } = await fixture(t)
  assert.equal(await importLegacyState(store, dir), undefined)
})
