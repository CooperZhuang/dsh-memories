/**
 * Wiring guard for the browser half's two surfaces.
 *
 * `client/index.js` is a plain CJS script that the bundle wrapper turns into a
 * DSH client bundle, so there is no module to import: the parts are
 * concatenated here exactly the way `scripts/build-client.mjs` concatenates
 * them, and the factory is called for real. What this pins is the registration
 * contract, because nothing else in the suite covers it:
 *
 *   - the **Memories page** (`settings.section`, id `memories`, order 25) stays
 *     — it is a feature surface, not a configuration menu;
 *   - the **tunables card** is registered a second time on the Plugins page as
 *     `plugins.bundle.config`, keyed by the **package name** (`dsh-memories`).
 *     That key is what the Plugins page looks up (`ledger.bundles`) when it
 *     decides whether to render a bundle's configuration section at all, so a
 *     wrong key silently means "no card in the GUI";
 *   - both registrations hand the same shared form (`scope` + `useSnapshot`) to
 *     their component, so the two editors cannot disagree;
 *   - `PACKAGE` is the package name, and `scripts/build-client.mjs` uses that
 *     same value as the bundle id.
 *
 * @module dsh-memories/test/client-wiring.test
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { REMOTE_INVOCATION_DATA } from '../remote.js'

/** One slot registration the fake context recorded. */
interface Registration {
  readonly name: string
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/** The plugin object `createPlugin` returns. */
interface Plugin {
  readonly inject: string[]
  readonly apply: (ctx: unknown) => Promise<void>
}

/** Where the hand-written half lives. */
const PARTS = new URL('../../client/parts/', import.meta.url)
const INDEX = new URL('../../client/index.js', import.meta.url)
const MANIFEST = new URL('../../package.json', import.meta.url)

/**
 * Concatenate the browser half the way the bundle script does.
 * @returns the factory, and the package name it was built with.
 */
async function loadFactory(): Promise<{ createPlugin: (require: (spec: string) => unknown) => Plugin; packageName: string }> {
  const names = (await readdir(PARTS)).filter((name) => name.endsWith('.js')).sort()
  const parts = await Promise.all(names.map(async (name) => {
    const body = await readFile(new URL(name, PARTS), 'utf8')
    return `// ---- client/${name} ----\n${body}`
  }))
  const index = await readFile(INDEX, 'utf8')
  const { name: packageName } = JSON.parse(await readFile(MANIFEST, 'utf8')) as { name: string }
  const source = [
    `const PACKAGE = ${JSON.stringify(packageName)};`,
    `const REMOTE_INVOCATION_DATA = ${JSON.stringify(REMOTE_INVOCATION_DATA)};`,
    ...parts,
    index,
    'return createPlugin',
  ].join('\n')
  const createPlugin = new Function(source)() as (require: (spec: string) => unknown) => Plugin
  return { createPlugin, packageName }
}

/**
 * Mount the browser half against a context that behaves like the shell's.
 * @returns every registration, the slots injected into, and the shared form.
 */
async function mount(): Promise<{
  registrations: Registration[]
  injected: string[]
  inject: string[]
  scope: { getSnapshot: () => unknown; subscribe: () => () => void; set: (field: string, value: unknown) => Promise<void>; unset: (field: string) => Promise<void> }
  packageName: string
}> {
  const { createPlugin, packageName } = await loadFactory()
  const registrations: Registration[] = []
  const injected: string[] = []
  const writes: unknown[] = []

  const scope = {
    getSnapshot: () => ({ status: 'ready', value: {}, user: {}, revision: 3, writable: true }),
    subscribe: () => () => {},
    set: (field: string, value: unknown) => {
      writes.push({ op: 'set', path: [field], value })
      return Promise.resolve()
    },
    unset: (field: string) => {
      writes.push({ op: 'unset', path: [field] })
      return Promise.resolve()
    },
  }

  // Nothing renders here, so the hook runtime stays empty: the factories only
  // close over React, and the card is exercised by `settings-card.test.ts`.
  const React = { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {} }

  const plugin = createPlugin((spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require(${spec})`)
  })

  const ctx = {
    configForms: { get: () => scope },
    // `mountMemoriesRemote` reads the gateway through `get`; there is none here,
    // which is the documented degradation (the card still renders).
    get: (key: string) => (key === 'locale' ? { getLocale: () => ({ active: 'zh' }) } : undefined),
    logger: { warn: () => {} },
    slots: {
      inject(name: string, callback: () => unknown) {
        injected.push(name)
        callback()
        return () => {}
      },
      register(options: Record<string, unknown>, component: unknown) {
        registrations.push({ name: String(options.name), options, component })
        return { dispose: () => {} }
      },
    },
  }

  await plugin.apply(ctx)
  return { registrations, injected, inject: plugin.inject, scope, packageName }
}

test('the browser half registers the Memories page and the Plugins-page config card', async () => {
  const { registrations, injected, inject, scope, packageName } = await mount()

  // The card reads `ctx.configForms`, so the plugin has to declare it.
  assert.deepEqual(inject, ['slots', 'configForms'])

  const pages = registrations.filter((entry) => entry.name === 'settings.section')
  assert.equal(pages.length, 1, 'the Memories page stays registered, exactly once')
  const page = pages[0]
  assert.ok(page !== undefined)
  assert.equal(page.options.id, 'memories')
  assert.equal(page.options.order, 25)
  const pageFace = (page.options.inject as () => Record<string, unknown>)()
  assert.deepEqual(Object.keys(pageFace).sort(), ['api', 'copy', 'scope', 'useSnapshot'])
  assert.equal(pageFace.scope, scope)
  assert.equal(typeof page.component, 'function')

  const cards = registrations.filter((entry) => entry.name === 'plugins.bundle.config')
  assert.equal(cards.length, 1, 'the tunables card is registered once on the Plugins page')
  const card = cards[0]
  assert.ok(card !== undefined)
  assert.equal(card.options.key, packageName, 'the Plugins page keys this slot by the PACKAGE NAME')
  assert.equal(packageName, 'dsh-memories')

  // The slot passes no `form`; the registration's inject face must supply the
  // same shared form the page's own tab supplies.
  const face = (card.options.inject as () => Record<string, unknown>)()
  assert.equal(face.scope, scope, 'the card edits the entry form, not a private copy')
  assert.equal(typeof face.useSnapshot, 'function')
  assert.equal(face.lang, 'zh')
  assert.equal(face.intro, false)
  assert.equal(typeof face.title, 'string')

  assert.deepEqual(injected, ['settings.section', 'plugins.bundle.config'])
  assert.equal(typeof card.component, 'function')
})
