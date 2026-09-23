/**
 * Drift guard for the settings card.
 *
 * The card lists its own field descriptors because it runs in the browser, where
 * the host schema is not importable. A knob the schema declares but the card
 * omits is simply not editable from the GUI, and a card row the schema does not
 * declare fails the save — so the two lists must stay in step, and both must
 * stay in step with the entry schema's live fields. This checks all three as
 * text and as schema metadata, which is also how the host sees them.
 *
 * @module dsh-memories/test/settings-card.test
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MEMORIES_SETTINGS_DEFAULTS, Config } from '../config.js'

/** The browser half, resolved from the compiled test's own location. */
const CARD = new URL('../../client/parts/card.js', import.meta.url)

test('the settings card covers exactly the schema, with bilingual copy', async () => {
  const text = await readFile(CARD, 'utf8')
  const fields = [...text.matchAll(/field: '([A-Za-z][A-Za-z0-9]*)'/gu)].map((match) => match[1])
  assert.ok(fields.length > 0, 'the card descriptors should be found')
  assert.deepEqual([...fields].sort(), Object.keys(MEMORIES_SETTINGS_DEFAULTS).sort(), 'every tunable needs a card row, and every card row a tunable')

  for (const field of fields) {
    const start = text.indexOf(`field: '${field}'`)
    const block = text.slice(start, text.indexOf('\n  },', start))
    assert.match(block, /label: \{ zh: ['"][^'"]+['"]/u, `${field} needs a Chinese label`)
    assert.match(block, /label: \{[^}]*en: ['"][^'"]+['"]/u, `${field} needs an English label`)
    assert.match(block, /hint: \{ zh: ['"]/u, `${field} needs a Chinese hint`)
    // Either quote style is fine: a hint quoting an apostrophe has to use one.
    assert.match(block, /hint: \{[^}]*en: ['"][^'"]+['"]/u, `${field} needs an English hint`)
  }
})

test('a select control declares its options and the renderer handles the kind', async () => {
  const text = await readFile(CARD, 'utf8')
  const selects = [...text.matchAll(/kind: 'select'/gu)]
  assert.ok(selects.length > 0, 'at least one tunable is an enum')
  for (const match of selects) {
    const block = text.slice(match.index, text.indexOf('label:', match.index))
    assert.match(block, /options: \[/u, 'a select control needs options')
    assert.match(block, /value: '/u, 'each option needs a value')
  }
  assert.match(text, /field\.kind === 'select'/u, 'the renderer must handle the select kind')
})

/** The ref table `toJSON` writes: every schema node once, referenced by index. */
interface SerializedSchema {
  uid: number
  refs: Record<string, { meta?: { volatile?: boolean }; dict?: Record<string, number> }>
}

test('the entry schema exposes exactly the tunables as live fields', () => {
  // `toJSON` returns the serialized ref table at runtime while its type still
  // describes the live tree, so the shape is read structurally.
  const json = Config.toJSON() as unknown as SerializedSchema
  const root = json.refs[String(json.uid)]
  const dict = root?.dict
  assert.ok(dict !== undefined, 'the entry config should serialize as one object node')
  const isLive = (key: string): boolean => json.refs[String(dict[key])]?.meta?.volatile === true

  assert.deepEqual(
    Object.keys(dict).filter(isLive).sort(),
    Object.keys(MEMORIES_SETTINGS_DEFAULTS).sort(),
    'every tunable must be a live field of the entry config, and no other field may be',
  )
  for (const key of ['dshHome', 'memoriesDir', 'projectRootMarkers', 'logFile']) {
    assert.ok(dict[key] !== undefined, `${key} must stay in the entry config`)
    assert.equal(isLive(key), false, `${key} is composition config, not a knob`)
  }
})
