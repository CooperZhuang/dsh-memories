/**
 * Tests for the Host→browser Remote surface.
 *
 * Two contracts matter here. The manifest must satisfy the registry's own
 * validation rules — a descriptor the registry rejects means the Settings page
 * silently never appears, and the failure would otherwise surface only in a
 * running browser. The service must keep every path it is handed inside the
 * store: a project is addressed by a slug the store already knows, never by a
 * caller-supplied path.
 *
 * @module dsh-memories/test/remote.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { REMOTE_CONTRIBUTION, REMOTE_INVOCATION_DATA, REMOTE_NAMESPACE, REMOTE_PACKAGE, REMOTE_SERVICE, createRemoteService, expandInvocations } from '../remote.js'
import type { StrictCodec, WireShape } from '../remote.js'
import { MemoryStore } from '../storage.js'
import { writeDraft } from '../skills.js'

/** A temp memory store plus a temp harness home. */
async function roots(t: { after: (fn: () => void | Promise<void>) => void }) {
  const memoriesDir = await mkdtemp(join(tmpdir(), 'dsh-memories-remote-'))
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-home-remote-'))
  t.after(async () => {
    await rm(memoriesDir, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  })
  return { memoriesDir, dshHome, store: new MemoryStore(memoriesDir) }
}

/** The registry's grammar for one wire segment. */
const WIRE = /^[A-Za-z0-9_$.-]+$/u

test('every invocation satisfies the registry validation rules', () => {
  const endpoints = new Set<string>()
  const ids = new Set<string>()
  for (const descriptor of REMOTE_CONTRIBUTION.invocations) {
    assert.ok(descriptor.id.length > 0)
    assert.ok(descriptor.service.length > 0 && !descriptor.service.includes('#'))
    assert.match(descriptor.namespace, WIRE)
    assert.match(descriptor.method, WIRE)
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    assert.equal(endpoints.has(endpoint), false, `duplicate endpoint ${endpoint}`)
    assert.equal(ids.has(descriptor.id), false, `duplicate id ${descriptor.id}`)
    endpoints.add(endpoint)
    ids.add(descriptor.id)
    // Strict codecs need a nonempty type symbol and a parse() function.
    const codecs: StrictCodec[] = [descriptor.result, ...descriptor.parameters.map((parameter) => parameter.codec)]
    for (const codec of codecs) {
      assert.equal(codec.mode, 'strict')
      assert.ok(codec.typeSymbol.length > 0)
      assert.equal(typeof codec.schema.parse, 'function')
    }
    const wires = new Set<string>()
    for (const parameter of descriptor.parameters) {
      assert.match(parameter.name, WIRE)
      assert.match(parameter.wire, WIRE)
      assert.equal(parameter.source, 'json')
      assert.equal(wires.has(parameter.wire), false, `duplicate wire field ${parameter.wire}`)
      wires.add(parameter.wire)
    }
  }
  assert.equal(REMOTE_CONTRIBUTION.package, REMOTE_PACKAGE)
  assert.equal(REMOTE_CONTRIBUTION.face, 'host')
  assert.deepEqual(REMOTE_CONTRIBUTION.schemas, [])
})

test('the wire table and the expanded descriptors agree', () => {
  const seen = new Set<WireShape>()
  const expanded = expandInvocations(REMOTE_INVOCATION_DATA, (shape) => {
    seen.add(shape)
    return { mode: 'strict', typeSymbol: shape, schema: { parse: (value: unknown) => value } }
  })
  assert.equal(expanded.length, REMOTE_INVOCATION_DATA.length)
  assert.deepEqual(expanded.map((descriptor) => descriptor.method), REMOTE_INVOCATION_DATA.map((invocation) => invocation.method))
  for (const [index, invocation] of REMOTE_INVOCATION_DATA.entries()) {
    const descriptor = expanded[index]
    assert.equal(descriptor?.service, REMOTE_SERVICE)
    assert.equal(descriptor?.namespace, REMOTE_NAMESPACE)
    assert.equal(descriptor?.id, `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${invocation.method}`)
    assert.deepEqual(descriptor?.parameters.map((parameter) => parameter.wire), invocation.parameters.map((parameter) => parameter.wire))
    // Optional parameters must accept a missing wire field; the gateway
    // otherwise rejects the call as arguments-invalid.
    assert.deepEqual(
      descriptor?.parameters.map((parameter) => parameter.acceptsUndefined === true),
      invocation.parameters.map((parameter) => parameter.optional === true),
    )
  }
  // Every shape the browser renders is covered by a codec factory call.
  assert.ok(seen.has('overview') && seen.has('entries') && seen.has('entry') && seen.has('removed'))
  assert.ok(seen.has('skill') && seen.has('discard') && seen.has('text') && seen.has('number'))
})

test('the host codecs validate instead of passing values through', () => {
  const byMethod = new Map(REMOTE_CONTRIBUTION.invocations.map((descriptor) => [descriptor.method, descriptor]))
  const overview = byMethod.get('overview')
  assert.ok(overview !== undefined)
  assert.throws(() => overview.result.schema.parse({}), /storePath must be a string/u)
  assert.throws(() => overview.result.schema.parse({ storePath: 'x', globalCount: 1, projects: [], drafts: [], kinds: 'nope' }), /must be an array/u)

  const list = byMethod.get('list')
  assert.ok(list !== undefined)
  const textCodec = list.parameters.find((parameter) => parameter.wire === 'query')?.codec
  const numberCodec = list.parameters.find((parameter) => parameter.wire === 'limit')?.codec
  assert.equal(textCodec?.schema.parse('hello'), 'hello')
  assert.throws(() => textCodec?.schema.parse(7), /must be a string/u)
  assert.equal(numberCodec?.schema.parse(10), 10)
  assert.throws(() => numberCodec?.schema.parse('10'), /must be a number/u)
})

test('the settings page can list and resolve the decisions waiting for a person', async (t) => {
  const { store, dshHome } = await roots(t)
  const seen: { id: string; decision: string }[] = []
  // A store without a runtime has no decisions: the page must render, not fail.
  const bare = createRemoteService({ store, dshHome })
  assert.deepEqual(await bare.disputes(), { disputes: [] })
  assert.match(await bare.resolveDispute('x', 'accept'), /No decisions are waiting/u)

  const service = createRemoteService({
    store,
    dshHome,
    disputes: async () => [{
      id: 'a', scope: 'global', action: 'retire', title: 'A', reason: '它被读到过 3 次', before: 'body', after: '',
    }],
    resolveDispute: async (id, decision) => {
      seen.push({ id, decision })
      return `Kept “${id}”.`
    },
  })
  const listed = await service.disputes()
  assert.equal(listed.disputes[0]?.reason, '它被读到过 3 次')
  assert.equal(listed.disputes[0]?.action, 'retire')
  assert.equal(await service.resolveDispute('a', 'reject'), 'Kept “a”.')
  assert.deepEqual(seen, [{ id: 'a', decision: 'reject' }])
  // A missing id, or an unknown decision word, must not reach the runtime as a
  // destructive default.
  assert.match(await service.resolveDispute('', 'accept'), /No decision id/u)
  await service.resolveDispute('a', 'delete-everything')
  assert.equal(seen[1]?.decision, 'accept', 'anything that is not reject is treated as accept')
})

test('the service carries the typertRemote binding the gateway validates', async (t) => {
  const { store, dshHome } = await roots(t)
  const service = createRemoteService({ store, dshHome })
  const binding = (service as { typertRemote?: { service?: unknown; serviceKey?: string; namespace?: string } }).typertRemote
  assert.equal(binding?.service, service)
  assert.equal(binding?.serviceKey, REMOTE_SERVICE)
  assert.equal(binding?.namespace, REMOTE_NAMESPACE)
  // Non-enumerable: the binding must not become part of the service surface.
  assert.equal(Object.keys(service).includes('typertRemote'), false)
})

test('overview reports both scopes and the staged drafts', async (t) => {
  const { store, dshHome } = await roots(t)
  await store.upsert({ scope: 'global', title: 'Global rule', body: 'Applies everywhere.', tags: ['rule'] }, undefined, 'user')
  await store.upsert({ scope: 'project', title: 'Project rule', body: 'Applies here.', tags: [] }, join(t.name), 'user')
  await writeDraft(store.memoriesDir, { name: 'demo-skill', description: 'A demo', steps: ['Do it.'] })
  const service = createRemoteService({ store, dshHome })
  const view = await service.overview()
  assert.equal(view.storePath, store.memoriesDir)
  assert.equal(view.globalCount, 1)
  assert.equal(view.projects.length, 1)
  assert.equal(view.projects[0]?.count, 1)
  assert.equal(view.drafts.length, 1)
  assert.equal(view.drafts[0]?.name, 'demo-skill')
  assert.equal(view.drafts[0]?.promoted, false)
  assert.ok(view.kinds.includes('preference'))
})

test('every service method takes one positional parameter per descriptor parameter', async (t) => {
  const { store, dshHome } = await roots(t)
  const service = createRemoteService({ store, dshHome })
  for (const descriptor of REMOTE_CONTRIBUTION.invocations) {
    const method = (service as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[descriptor.method]
    assert.ok(typeof method === 'function', `${descriptor.method} is missing from the service`)
    // The gateway applies the resolved arguments positionally, so an object-shaped
    // signature would receive the first string as its whole argument.
    assert.equal(method.length, descriptor.parameters.length, `${descriptor.method} arity`)
  }
})

test('list browses, searches, and filters without leaving the store', async (t) => {
  const { store, dshHome } = await roots(t)
  const root = join(t.name, 'workspace')
  await store.upsert({ scope: 'global', title: 'Commit in Chinese', body: 'Write commit messages in Chinese.', tags: ['git'], kind: 'preference' }, undefined, 'user')
  await store.upsert({ scope: 'project', title: 'Build with tsc', body: 'Compile with tsc before tests.', tags: ['build'], kind: 'procedure' }, root, 'user')
  const service = createRemoteService({ store, dshHome })
  const slug = (await store.listProjects())[0]
  assert.ok(slug !== undefined)

  const all = await service.list(slug, '', '', '', 50)
  assert.equal(all.total, 2)
  assert.equal(all.entries.length, 2)

  const globalOnly = await service.list(slug, 'global', '', '', 50)
  assert.deepEqual(globalOnly.entries.map((entry) => entry.title), ['Commit in Chinese'])

  const projectOnly = await service.list(slug, 'project', '', '', 50)
  assert.deepEqual(projectOnly.entries.map((entry) => entry.title), ['Build with tsc'])
  assert.equal(projectOnly.entries[0]?.appliesTo, '')

  const ranked = await service.list(slug, '', 'tsc', '', 50)
  assert.deepEqual(ranked.entries.map((entry) => entry.title), ['Build with tsc'])

  const byKind = await service.list(slug, '', '', 'preference', 50)
  assert.deepEqual(byKind.entries.map((entry) => entry.title), ['Commit in Chinese'])

  // An unknown slug is an empty project scope, never a path the caller chose.
  const unknown = await service.list('../../etc', 'project', '', '', 50)
  assert.deepEqual(unknown.entries, [])
})

test('add writes through the store and rejects what it cannot store', async (t) => {
  const { store, dshHome } = await roots(t)
  const service = createRemoteService({ store, dshHome })
  const created = await service.add(undefined, 'global', 'preference', 'Prefer pnpm', 'Use pnpm, never npm.', 'tooling, packages')
  assert.equal(created.entry.id, 'prefer-pnpm')
  assert.equal(created.entry.kind, 'preference')
  assert.deepEqual(created.entry.tags, ['tooling', 'packages'])
  assert.equal(created.entry.source, 'user')
  assert.equal((await store.list('global', undefined)).length, 1)

  await assert.rejects(() => service.add(undefined, 'global', 'fact', '', 'x', ''), /title and a body/u)
  await assert.rejects(() => service.add('nope', 'project', 'fact', 'T', 'B', ''), /no project scope matches/u)
})

test('forget removes one entry and reports the truth', async (t) => {
  const { store, dshHome } = await roots(t)
  await store.upsert({ scope: 'global', title: 'Temporary', body: 'Gone soon.', tags: [] }, undefined, 'user')
  const service = createRemoteService({ store, dshHome })
  assert.deepEqual(await service.forget(undefined, 'global', 'temporary'), { removed: true })
  assert.deepEqual(await service.forget(undefined, 'global', 'temporary'), { removed: false })
  // A project-scoped forget with an unknown slug cannot touch anything.
  assert.deepEqual(await service.forget('missing', 'project', 'temporary'), { removed: false })
})

test('skill promotion is explicit and idempotent over the Remote surface', async (t) => {
  const { store, dshHome } = await roots(t)
  await writeDraft(store.memoriesDir, { name: 'demo-skill', description: 'A demo', steps: ['Do it.'] })
  const service = createRemoteService({ store, dshHome })
  const first = await service.promoteSkill('demo-skill')
  assert.equal(first.path, join(dshHome, 'skills', 'demo-skill', 'SKILL.md'))
  assert.equal((await service.overview()).drafts[0]?.promoted, true)
  assert.equal((await service.promoteSkill('demo-skill')).name, 'demo-skill')
  await assert.rejects(() => service.promoteSkill('nope'), /no staged skill draft/u)
  assert.deepEqual(await service.discardSkill('demo-skill'), { name: 'demo-skill', removed: true })
  assert.deepEqual(await service.discardSkill('demo-skill'), { name: 'demo-skill', removed: false })
})
