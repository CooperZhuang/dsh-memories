/**
 * Standalone activation harness for `dsh-memories`.
 *
 * Boots a real Cordis root, registers minimal stand-ins for the `tools` and
 * `commands` services, loads the built plugin, and reports what it registered.
 * This catches loader-level mistakes (bad `inject`, bad tool schema) without
 * needing a model or a full DSH profile.
 *
 * Run from a directory whose `node_modules` can resolve the DSH packages, e.g.
 * the plugin's own checkout after `pnpm i`, or a profile directory:
 *   node scripts/activation-smoke.mjs <pluginDir>
 */
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginDir = resolve(process.argv[2] ?? '.')
const entry = pathToFileURL(join(pluginDir, 'lib', 'index.js')).href

/** Minimal tool registry stand-in that validates each definition. */
class Tools {
  constructor() {
    this.registered = new Map()
  }
  register(definition) {
    if (typeof definition?.name !== 'string' || definition.name.length === 0) throw new Error('tool without a name')
    if (typeof definition.description !== 'string' || definition.description.length === 0) throw new Error(`${definition.name}: missing description`)
    if (typeof definition.execute !== 'function') throw new Error(`${definition.name}: missing execute`)
    if (definition.output === undefined || typeof definition.output.render !== 'function') throw new Error(`${definition.name}: missing output contract`)
    this.registered.set(definition.name, definition)
    return () => this.registered.delete(definition.name)
  }
}

/** Minimal command registry stand-in. */
class Commands {
  constructor() {
    this.registered = new Map()
  }
  register(definition) {
    if (typeof definition?.name !== 'string') throw new Error('command without a name')
    if (typeof definition.handler !== 'function') throw new Error(`${definition.name}: missing handler`)
    this.registered.set(definition.name, definition)
    return () => this.registered.delete(definition.name)
  }
}

/** Minimal settings provider stand-in: one namespace, resolved value tracked. */
class Settings {
  constructor(base) {
    this.base = base
    this.namespaces = new Map()
    this.watchers = new Map()
  }
  register(ns, _schema, options) {
    this.namespaces.set(ns, { value: { ...this.base, ...(options?.base ?? {}) }, base: options?.base ?? {} })
    return {
      get: () => this.namespaces.get(ns).value,
      watch: (callback) => {
        const set = this.watchers.get(ns) ?? new Set()
        set.add(callback)
        this.watchers.set(ns, set)
        return () => set.delete(callback)
      },
      update: async (patch) => {
        const entry = this.namespaces.get(ns)
        const prev = entry.value
        entry.value = { ...entry.value, ...patch }
        for (const callback of this.watchers.get(ns) ?? []) await callback(entry.value, prev)
      },
      replace: async (section) => {
        const entry = this.namespaces.get(ns)
        const prev = entry.value
        entry.value = { ...entry.base, ...section }
        for (const callback of this.watchers.get(ns) ?? []) await callback(entry.value, prev)
      },
    }
  }
  describe() {
    return [...this.namespaces.entries()].map(([ns, entry]) => ({ ns, value: entry.value, revision: 1, applies: 'live' }))
  }
  get(ns) {
    return this.namespaces.get(ns)?.value
  }
}

const memoriesDir = await mkdtemp(join(tmpdir(), 'dsh-memories-smoke-'))
const root = new Context()
const ctx = root.extend({ name: 'smoke' })
const tools = new Tools()
const commands = new Commands()
const settings = new Settings({})
ctx.provide('tools', tools)
ctx.provide('commands', commands)
ctx.provide('settings', settings)
ctx.provide('llm', { stream: async function* () {} })

const module = await import(entry)
console.log('exports:', Object.keys(module).sort().join(', '))
console.log('inject:', JSON.stringify(module.inject))

const plugin = ctx.plugin(module, { memoriesDir, autoExtract: false })
await new Promise((settle) => setTimeout(settle, 200))

console.log('settings namespaces:', settings.describe().map((d) => d.ns).join(', ') || '(none)')
console.log('tools registered:', [...tools.registered.keys()].join(', ') || '(none)')
console.log('commands registered:', [...commands.registered.keys()].join(', ') || '(none)')

// Live toggle: disabling the tool through the settings scope must unregister it.
const flip = async (patch) => {
  const entry = settings.namespaces.get('memories')
  const prev = entry.value
  entry.value = { ...entry.value, ...patch }
  for (const callback of [...(settings.watchers.get('memories') ?? [])]) await callback(entry.value, prev)
}
await flip({ enableTool: false })
await new Promise((settle) => setTimeout(settle, 50))
console.log('after enableTool=false, tools:', [...tools.registered.keys()].join(', ') || '(none)')
await flip({ enableTool: true, enableCommand: false })
await new Promise((settle) => setTimeout(settle, 50))
console.log('after enableTool=true/enableCommand=false, tools:', [...tools.registered.keys()].join(', ') || '(none)', '| commands:', [...commands.registered.keys()].join(', ') || '(none)')
// Restore both so the command smoke below exercises a fully enabled plugin.
await flip({ enableCommand: true })
await new Promise((settle) => setTimeout(settle, 50))
console.log('after re-enable, commands:', [...commands.registered.keys()].join(', ') || '(none)')

const tool = tools.registered.get('memory')
if (tool !== undefined) {
  const params = Object.keys(tool.parameters ?? {})
  console.log('memory parameters:', params.join(', '))
  const search = tool.output.render({ action: 'search' }, { ok: true, action: 'search', message: 'hello', results: [] })
  console.log('render smoke:', JSON.stringify(search))
}

const memories = commands.registered.get('memories')
if (memories !== undefined) {
  const run = (rawInput) => memories.handler({
    rawInput,
    commandId: 'smoke',
    agent: { session: { id: 'smoke-session', header: { cwd: pluginDir } } },
    attachments: [],
    signal: new AbortController().signal,
  })
  console.log('command stats:', JSON.stringify(await run(' stats')).slice(0, 300))
  // The `--kind` flag must survive argument parsing and reach the store.
  console.log('add --kind:', JSON.stringify(await run(' add global Always run the linter before committing --kind preference')).slice(0, 160))
  console.log('search --kind:', JSON.stringify(await run(' search linter --kind preference')).slice(0, 200))
  console.log('search wrong kind:', JSON.stringify(await run(' search linter --kind failure')).slice(0, 120))
  console.log('skills:', JSON.stringify(await run(' skills')).slice(0, 120))
}

await plugin.dispose?.()
await root.stop?.()
await rm(memoriesDir, { recursive: true, force: true })
console.log('activation smoke OK')
