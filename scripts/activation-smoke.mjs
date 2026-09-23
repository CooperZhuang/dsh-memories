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
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { MEMORIES_SETTINGS_DEFAULTS } from '../lib/config.js'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/**
 * Minimal settings-domain stand-in: records the page policy the plugin asks for.
 *
 * Only `configure` exists here because that is the entire host-side contact a
 * plugin that ships its own page has with the domain; the reads and writes go
 * through the row's live references instead.
 */
class SettingsDomain {
  constructor() {
    this.policies = []
  }
  configure(presentation) {
    this.policies.push({ presentation })
    return () => { this.policies = this.policies.filter((candidate) => candidate.presentation !== presentation) }
  }
}

/** Minimal Typert registry stand-in: validates and records the contribution. */
class Typert {
  constructor() {
    this.contributions = []
  }
  register(contribution) {
    if (typeof contribution?.package !== 'string' || contribution.package.length === 0) throw new Error('contribution without a package')
    if (contribution.face !== 'host') throw new Error('host contribution must declare face "host"')
    for (const invocation of contribution.invocations ?? []) {
      if (typeof invocation.method !== 'string' || invocation.method.length === 0) throw new Error('invocation without a method')
      // The registry validates strict codecs through their create() factory
      // (0.1.6-alpha.2 dropped the older schema.parse field), so the stand-in
      // checks the same contract the real one does.
      if (typeof invocation.result?.create !== 'function' || typeof invocation.result.create().parse !== 'function') {
        throw new Error(`${invocation.method}: result codec is not strict`)
      }
      for (const parameter of invocation.parameters ?? []) {
        if (typeof parameter.codec?.create !== 'function' || typeof parameter.codec.create().parse !== 'function') {
          throw new Error(`${invocation.method}.${parameter.name}: parameter codec is not strict`)
        }
      }
    }
    this.contributions.push(contribution)
    return () => { this.contributions = this.contributions.filter((candidate) => candidate !== contribution) }
  }
}

const memoriesDir = await mkdtemp(join(tmpdir(), 'dsh-memories-smoke-'))
const root = new Context()
const ctx = root.extend({ name: 'smoke' })
const tools = new Tools()
const commands = new Commands()
const settings = new SettingsDomain()
const typert = new Typert()

// `autoExtract` is off so the harness never runs a background pass against a
// temp store. The tunables go in plain: the schema is what turns each one into
// the live reference the plugin then reads, exactly as the Loader does it.
const config = { memoriesDir, logFile: '', ...MEMORIES_SETTINGS_DEFAULTS, autoExtract: false }

ctx.provide('tools', tools)
ctx.provide('commands', commands)
ctx.provide('settings', settings)
ctx.provide('typert', typert)
ctx.provide('llm', { stream: async function* () {} })

const module = await import(entry)
console.log('exports:', Object.keys(module).sort().join(', '))
console.log('inject:', JSON.stringify(module.inject), '(settings must NOT be required)')
if (module.inject.includes('settings')) throw new Error('the settings domain has to stay optional')

const plugin = ctx.plugin(module, config)
await new Promise((settle) => setTimeout(settle, 200))

/** What the plugin is running with: its resolved entry config, refs and all. */
const mounted = [...(ctx.registry.get(module)?.fibers ?? [])][0]?.config

/**
 * Commit a tunable change the way the Loader does.
 *
 * Update the entry config's references in place, then announce the paths —
 * nothing re-mounts, which is exactly what the live fields are for.
 * @param patch - the tunables to change.
 */
const flip = (patch) => {
  for (const [key, value] of Object.entries(patch)) updateVolatile(mounted[key], createVolatile(value))
  ctx.emit('loader/volatile-update', Object.keys(patch).map((key) => [key]))
}

console.log('page policy:', settings.policies.map((policy) => JSON.stringify(policy.presentation)).join(', ') || '(none)')
console.log('live tunables:', mounted === undefined ? '(no fiber)' : `enableTool=${String(mounted.enableTool?.get())} autoExtract=${String(mounted.autoExtract?.get())}`)
console.log('tools registered:', [...tools.registered.keys()].join(', ') || '(none)')
console.log('commands registered:', [...commands.registered.keys()].join(', ') || '(none)')
console.log('typert invocations:', typert.contributions[0]?.invocations.map((i) => i.method).join(', ') || '(none)')

// Live toggle: a knob changed through the entry's live fields must take effect
// on the running plugin, without a restart.
flip({ enableTool: false })
await new Promise((settle) => setTimeout(settle, 50))
console.log('after enableTool=false, tools:', [...tools.registered.keys()].join(', ') || '(none)')
flip({ enableTool: true, enableCommand: false })
await new Promise((settle) => setTimeout(settle, 50))
console.log('after enableTool=true/enableCommand=false, tools:', [...tools.registered.keys()].join(', ') || '(none)', '| commands:', [...commands.registered.keys()].join(', ') || '(none)')
// Restore both so the command smoke below exercises a fully enabled plugin.
flip({ enableCommand: true })
await new Promise((settle) => setTimeout(settle, 50))
console.log('after re-enable, commands:', [...commands.registered.keys()].join(', ') || '(none)')

const tool = tools.registered.get('memory')
if (tool !== undefined) {
  const params = Object.keys(tool.parameters ?? {})
  console.log('memory parameters:', params.join(', '))
  const search = tool.output.render({ action: 'search' }, { ok: true, action: 'search', message: 'hello', results: [] })
  console.log('render smoke:', JSON.stringify(search))

  // The evidence action reads the note a session left behind; write one the way
  // a mined session leaves it, then ask the real tool dispatch for it.
  await mkdir(join(memoriesDir, 'sessions'), { recursive: true })
  await writeFile(
    join(memoriesDir, 'sessions', 'smoke-session.md'),
    '---\nsession: smoke-session\nat: 2023-11-14T22:13:20.000Z\nproject: project:demo\n---\n\nWe set up the deploy script.\n',
  )
  const evidence = await tool.execute({ action: 'evidence', evidenceSession: 'smoke-session' }, {
    agent: { session: { id: 'smoke-session', header: { cwd: pluginDir } } },
  })
  console.log('tool evidence:', JSON.stringify(evidence).slice(0, 220))
  const missing = await tool.execute({ action: 'evidence', evidenceSession: 'never-mined' }, {
    agent: { session: { id: 'smoke-session', header: { cwd: pluginDir } } },
  })
  console.log('tool evidence (missing):', JSON.stringify(missing).slice(0, 160))
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

// The Settings page reaches the store through the provided `memories` service;
// this exercises that surface the same way the gateway would. Arguments are
// positional, one per descriptor parameter.
const remote = ctx.get('memories')
if (remote !== undefined) {
  console.log('remote binding:', JSON.stringify({ serviceKey: remote.typertRemote?.serviceKey, namespace: remote.typertRemote?.namespace }))
  const overview = await remote.overview()
  console.log('remote overview:', JSON.stringify({ storePath: overview.storePath === memoriesDir, globalCount: overview.globalCount, projects: overview.projects.length }))
  const listed = await remote.list('', 'global', 'linter', '', 10)
  console.log('remote list:', JSON.stringify(listed.entries.map((entry) => `${entry.kind}:${entry.title}`)))
  const added = await remote.add('', 'global', 'knowledge', 'Smoke remote write', 'Written through the Remote service.', 'smoke')
  console.log('remote add:', JSON.stringify({ id: added.entry.id, kind: added.entry.kind, tags: added.entry.tags }))
  console.log('remote forget:', JSON.stringify(await remote.forget('', 'global', added.entry.id)))
} else {
  console.log('remote service: MISSING')
}

await plugin.dispose?.()
await root.stop?.()
await rm(memoriesDir, { recursive: true, force: true })
console.log('activation smoke OK')
