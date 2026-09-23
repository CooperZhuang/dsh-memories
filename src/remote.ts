/**
 * Host→browser Remote surface for the Settings page.
 *
 * The Memories page's tunables card only edits this plugin's own config; a human
 * also wants to see what is remembered. That needs the browser to call the host,
 * and the harness already owns that transport: the Typert registry (`ctx.typert`)
 * holds invocation descriptors, the API gateway serves them over the connection
 * the shell already authenticated, and the browser half reaches them as
 * `ctx.remote.<namespace>.<method>`.
 *
 * The manifest here is hand-written rather than generated. The generator emits
 * the same shape from TypeScript decorators, but this package ships plain JS
 * with no build-time Typert step, and the registry's own validation
 * (`dsh-typert-registry`) accepts any contribution whose codecs carry a
 * `typeSymbol` and a `create()` factory returning a schema with `parse()` — a
 * live Zod schema is one such codec, a hand-written validator is another.
 * (0.1.6-alpha.2 replaced the older `schema.parse` field with that factory: the
 * registry now checks `typeof codec.create === 'function'` and the gateway
 * materializes the schema with `codec.create().parse(value)`.) Dropping the
 * generator therefore costs no wire capability and no dependency.
 *
 * `REMOTE_INVOCATION_DATA` is the single source of truth for the wire shape:
 * the host expands it with validating parsers, and `scripts/build-client.mjs`
 * serializes it into the browser bundle, which expands it with permissive ones.
 * One list, so the two halves cannot drift.
 *
 * @module dsh-memories/remote
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { browseMemories, searchMemories, type ScopeEntries } from './search.js'
import { discardDraft, listDrafts, promote } from './skills.js'
import type { MemoryStore, ProjectDescriptor } from './storage.js'
import type { MemoryEntry, MemoryKind, MemoryScope } from './types.js'
import { MEMORY_KINDS, toMemoryKind } from './types.js'

/** npm package owning the Remote methods. */
export const REMOTE_PACKAGE = 'dsh-memories'
/** Cordis service key the gateway resolves the receiver through. */
export const REMOTE_SERVICE = 'memories'
/** Wire namespace; the browser sees it as `ctx.remote.memories`. */
export const REMOTE_NAMESPACE = 'memories'

/** Every value that crosses the wire is one of these named shapes. */
export type WireShape =
  /** A free-text parameter. */
  | 'text'
  /** A numeric parameter. */
  | 'number'
  /** Store home, per-project counts, staged skill drafts. */
  | 'overview'
  /** A ranked entry page plus the total before paging. */
  | 'entries'
  /** One stored entry. */
  | 'entry'
  /** Whether a delete removed a file. */
  | 'removed'
  /** One promoted skill and where it landed. */
  | 'skill'
  /** Whether a staged draft was discarded. */
  | 'discard'
  /** The consolidation decisions waiting for a person. */
  | 'disputes'

/** One ordered business parameter, as pure data. */
export interface WireParameter {
  /** Source-level parameter name. */
  readonly name: string
  /** Required key in the wire `args` object. */
  readonly wire: string
  /** Value shape the codec validates. */
  readonly shape: WireShape
  /** Whether the caller may omit the wire field. */
  readonly optional?: true
}

/** One invocation, as pure data. */
export interface WireInvocation {
  /** Public method name. */
  readonly method: string
  /** Ordered parameters. */
  readonly parameters: readonly WireParameter[]
  /** Result shape. */
  readonly result: WireShape
}

/**
 * The wire contract.
 *
 * `project` names a project scope by slug (`overview` reports the slugs on
 * disk); the empty string means "no project", which makes the project-scoped
 * calls return nothing rather than fail.
 */
export const REMOTE_INVOCATION_DATA: readonly WireInvocation[] = [
  {
    method: 'overview',
    parameters: [],
    result: 'overview',
  },
  {
    method: 'list',
    parameters: [
      { name: 'project', wire: 'project', shape: 'text', optional: true },
      { name: 'scope', wire: 'scope', shape: 'text', optional: true },
      { name: 'query', wire: 'query', shape: 'text', optional: true },
      { name: 'kind', wire: 'kind', shape: 'text', optional: true },
      { name: 'limit', wire: 'limit', shape: 'number', optional: true },
    ],
    result: 'entries',
  },
  {
    method: 'add',
    parameters: [
      { name: 'project', wire: 'project', shape: 'text', optional: true },
      { name: 'scope', wire: 'scope', shape: 'text' },
      { name: 'kind', wire: 'kind', shape: 'text', optional: true },
      { name: 'title', wire: 'title', shape: 'text' },
      { name: 'body', wire: 'body', shape: 'text' },
      { name: 'tags', wire: 'tags', shape: 'text', optional: true },
    ],
    result: 'entry',
  },
  {
    method: 'forget',
    parameters: [
      { name: 'project', wire: 'project', shape: 'text', optional: true },
      { name: 'scope', wire: 'scope', shape: 'text' },
      { name: 'id', wire: 'id', shape: 'text' },
    ],
    result: 'removed',
  },
  {
    method: 'promoteSkill',
    parameters: [{ name: 'name', wire: 'name', shape: 'text' }],
    result: 'skill',
  },
  {
    method: 'discardSkill',
    parameters: [{ name: 'name', wire: 'name', shape: 'text' }],
    result: 'discard',
  },
  {
    method: 'disputes',
    parameters: [],
    result: 'disputes',
  },
  {
    method: 'resolveDispute',
    parameters: [
      { name: 'id', wire: 'id', shape: 'text' },
      { name: 'decision', wire: 'decision', shape: 'text' },
    ],
    result: 'text',
  },
]

/** A schema a codec materializes: the one method the gateway calls. */
export interface CodecSchema {
  /** Validate one value at the wire boundary. */
  parse(value: unknown): unknown
}

/** A codec the registry accepts: a type symbol plus a lazy schema factory. */
export interface StrictCodec {
  readonly mode: 'strict'
  readonly typeSymbol: string
  /** Materialize the shape's schema; the registry requires this factory. */
  create(): CodecSchema
}

/** One registry invocation descriptor. */
export interface RemoteDescriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly parameters: readonly {
    readonly name: string
    readonly wire: string
    readonly source: 'json'
    readonly codec: StrictCodec
    readonly acceptsUndefined?: true
  }[]
  readonly result: StrictCodec
}

/** One Typert contribution, as `ctx.typert.register()` accepts it. */
export interface RemoteContribution {
  readonly package: string
  readonly face: 'host'
  readonly schemas: readonly unknown[]
  readonly invocations: readonly RemoteDescriptor[]
  readonly model: { readonly services: readonly unknown[]; readonly events: readonly unknown[]; readonly objects: readonly unknown[] }
}

/** The slice of the Typert registry this plugin uses. */
export interface TypertRegistryLike {
  /** Register one contribution; returns the disposer that withdraws it. */
  register(contribution: RemoteContribution): () => Promise<void> | void
}

/** Throw unless the value is a plain object. */
function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`dsh-memories: ${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Throw unless the value is a string. */
function asText(value: unknown, subject: string): string {
  if (typeof value !== 'string') throw new TypeError(`dsh-memories: ${subject} must be a string`)
  return value
}

/** Throw unless the value is a finite number. */
function asCount(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`dsh-memories: ${subject} must be a number`)
  }
  return value
}

/** Throw unless the value is a boolean. */
function asFlag(value: unknown, subject: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`dsh-memories: ${subject} must be a boolean`)
  return value
}

/** Throw unless the value is an array. */
function asList(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`dsh-memories: ${subject} must be an array`)
  return value
}

/** Validate one stored entry as it crosses the wire. */
function parseEntryView(value: unknown): Record<string, unknown> {
  const view = asRecord(value, 'entry')
  return {
    id: asText(view.id, 'entry.id'),
    scope: asText(view.scope, 'entry.scope'),
    kind: asText(view.kind, 'entry.kind'),
    title: asText(view.title, 'entry.title'),
    body: asText(view.body, 'entry.body'),
    tags: asList(view.tags, 'entry.tags').map((tag) => asText(tag, 'entry.tag')),
    appliesTo: asText(view.appliesTo, 'entry.appliesTo'),
    sourceSession: asText(view.sourceSession, 'entry.sourceSession'),
    createdAt: asCount(view.createdAt, 'entry.createdAt'),
    updatedAt: asCount(view.updatedAt, 'entry.updatedAt'),
    uses: asCount(view.uses, 'entry.uses'),
    lastUsedAt: asCount(view.lastUsedAt, 'entry.lastUsedAt'),
    source: asText(view.source, 'entry.source'),
  }
}

/** Validate one project row as it crosses the wire. */
function parseProjectView(value: unknown): Record<string, unknown> {
  const view = asRecord(value, 'project')
  return {
    slug: asText(view.slug, 'project.slug'),
    name: asText(view.name, 'project.name'),
    root: asText(view.root, 'project.root'),
    count: asCount(view.count, 'project.count'),
    updatedAt: asCount(view.updatedAt, 'project.updatedAt'),
  }
}

/** Validate one staged draft as it crosses the wire. */
function parseDraftView(value: unknown): Record<string, unknown> {
  const view = asRecord(value, 'draft')
  return {
    name: asText(view.name, 'draft.name'),
    description: asText(view.description, 'draft.description'),
    promoted: asFlag(view.promoted, 'draft.promoted'),
  }
}

/**
 * Build the host-side codec for one shape.
 *
 * Parsing is real validation, not a passthrough: the gateway hands these
 * functions untrusted values on the way in and this module's own output on the
 * way out, and a malformed call should fail at the boundary rather than corrupt
 * the store.
 *
 * @param shape - the shape to validate.
 * @returns a strict codec whose `create()` returns that shape's parser.
 */
function hostCodec(shape: WireShape): StrictCodec {
  const parse = (value: unknown): unknown => {
    switch (shape) {
      case 'text':
        return asText(value, 'argument')
      case 'number':
        return asCount(value, 'argument')
      case 'overview': {
        const view = asRecord(value, 'overview')
        return {
          storePath: asText(view.storePath, 'overview.storePath'),
          globalCount: asCount(view.globalCount, 'overview.globalCount'),
          projects: asList(view.projects, 'overview.projects').map(parseProjectView),
          drafts: asList(view.drafts, 'overview.drafts').map(parseDraftView),
          kinds: asList(view.kinds, 'overview.kinds').map((kind) => asText(kind, 'overview.kind')),
        }
      }
      case 'entries': {
        const view = asRecord(value, 'entries')
        return {
          entries: asList(view.entries, 'entries.entries').map(parseEntryView),
          total: asCount(view.total, 'entries.total'),
        }
      }
      case 'entry':
        return parseEntryView(value)
      case 'removed':
        return { removed: asFlag(asRecord(value, 'removed').removed, 'removed.removed') }
      case 'skill': {
        const view = asRecord(value, 'skill')
        return { name: asText(view.name, 'skill.name'), path: asText(view.path, 'skill.path') }
      }
      case 'discard': {
        const view = asRecord(value, 'discard')
        return { name: asText(view.name, 'discard.name'), removed: asFlag(view.removed, 'discard.removed') }
      }
      case 'disputes': {
        const view = asRecord(value, 'disputes')
        return {
          disputes: asList(view.disputes, 'disputes.disputes').map((row) => {
            const entry = asRecord(row, 'dispute')
            return {
              id: asText(entry.id, 'dispute.id'),
              scope: asText(entry.scope, 'dispute.scope'),
              action: asText(entry.action, 'dispute.action'),
              title: asText(entry.title, 'dispute.title'),
              reason: asText(entry.reason, 'dispute.reason'),
              before: asText(entry.before, 'dispute.before'),
              after: asText(entry.after, 'dispute.after'),
            }
          }),
        }
      }
      /* v8 ignore next 2 -- the union is exhaustive; kept for the type checker. */
      default:
        throw new TypeError(`dsh-memories: unknown shape ${String(shape)}`)
    }
  }
  return { mode: 'strict', typeSymbol: `${REMOTE_PACKAGE}#${shape}`, create: () => ({ parse }) }
}

/**
 * Expand the wire table into registry descriptors.
 * @param data - the wire contract.
 * @param codecOf - shape-to-codec factory (the host validates; the browser does not).
 * @returns the invocation descriptors.
 */
export function expandInvocations(
  data: readonly WireInvocation[],
  codecOf: (shape: WireShape) => StrictCodec = hostCodec,
): readonly RemoteDescriptor[] {
  return data.map((invocation) => ({
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${invocation.method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method: invocation.method,
    invocation: { kind: 'direct' as const },
    parameters: invocation.parameters.map((parameter) => ({
      name: parameter.name,
      wire: parameter.wire,
      source: 'json' as const,
      codec: codecOf(parameter.shape),
      ...parameter.optional === true ? { acceptsUndefined: true as const } : {},
    })),
    result: codecOf(invocation.result),
  }))
}

/** The host contribution, ready for `ctx.typert.register()`. */
export const REMOTE_CONTRIBUTION: RemoteContribution = {
  package: REMOTE_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: expandInvocations(REMOTE_INVOCATION_DATA),
  model: { services: [], events: [], objects: [] },
}

/** One entry as the settings page renders it. */
export interface EntryView {
  readonly id: string
  readonly scope: string
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
  readonly appliesTo: string
  /** Session this memory came from, or `''` when it has no recorded source. */
  readonly sourceSession: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly uses: number
  readonly lastUsedAt: number
  readonly source: string
}

/** Project the stored entry onto its wire view. */
function entryView(entry: MemoryEntry): EntryView {
  return {
    id: entry.id,
    scope: entry.scope,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    tags: [...entry.tags],
    appliesTo: entry.appliesTo ?? '',
    sourceSession: entry.sourceSession ?? '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    uses: entry.uses,
    lastUsedAt: entry.lastUsedAt,
    source: entry.source,
  }
}

/** The store facts the settings page opens with. */
export interface OverviewView {
  readonly storePath: string
  readonly globalCount: number
  readonly projects: readonly { readonly slug: string; readonly name: string; readonly root: string; readonly count: number; readonly updatedAt: number }[]
  readonly drafts: readonly { readonly name: string; readonly description: string; readonly promoted: boolean }[]
  readonly kinds: readonly string[]
}

/** What the Remote service needs from the plugin runtime. */
export interface RemoteHost {
  /** The markdown store, scopes resolved by project root. */
  readonly store: MemoryStore
  /** Harness home whose `skills/` promotion writes to. */
  readonly dshHome: string
  /**
   * The consolidation decisions waiting for a person, when the runtime is wired.
   *
   * The browser never decides what may be applied — it only asks — so these are
   * hooks back into the runtime rather than logic living at this seam: the
   * runtime is the only writer, and a page without a runtime (a bare store, a
   * test) simply has no decisions to show.
   */
  readonly disputes?: () => Promise<readonly { id: string; scope: string; action: string; title: string; reason: string; before: string; after: string }[]>
  /** Accept or reject one waiting decision, through the runtime that owns it. */
  readonly resolveDispute?: (id: string, decision: 'accept' | 'reject') => Promise<string | undefined>
}

/**
 * The Remote service surface.
 *
 * Signatures are POSITIONAL, one parameter per descriptor parameter in the same
 * order: the gateway resolves each descriptor parameter and applies the service
 * method to that argument list, so an object-shaped signature would silently
 * receive the first string as its argument. `REMOTE_INVOCATION_DATA` is the
 * order this interface must mirror.
 */
export interface MemoriesRemote {
  overview(): Promise<OverviewView>
  list(project?: string, scope?: string, query?: string, kind?: string, limit?: number): Promise<{ readonly entries: readonly EntryView[]; readonly total: number }>
  add(project?: string, scope?: string, kind?: string, title?: string, body?: string, tags?: string): Promise<{ readonly entry: EntryView }>
  forget(project?: string, scope?: string, id?: string): Promise<{ readonly removed: boolean }>
  promoteSkill(name?: string): Promise<{ readonly name: string; readonly path: string }>
  discardSkill(name?: string): Promise<{ readonly name: string; readonly removed: boolean }>
  disputes(): Promise<{ readonly disputes: readonly DisputeView[] }>
  resolveDispute(id?: string, decision?: string): Promise<string>
}

/** One consolidation decision, as the settings page renders it. */
export interface DisputeView {
  readonly id: string
  readonly scope: string
  /** `rewrite` or `retire`. */
  readonly action: string
  readonly title: string
  /** Why this one is being asked about, in one sentence. */
  readonly reason: string
  /** What the memory says today. */
  readonly before: string
  /** What the pass wants it to say; empty for a retirement. */
  readonly after: string
}

/** Narrow a wire scope string to a scope, or `undefined` for "both". */
function scopeOf(value: string | undefined): MemoryScope | undefined {
  return value === 'global' || value === 'project' ? value : undefined
}

/** Narrow a wire kind string to a kind, or `undefined` for "every kind". */
function kindOf(value: string | undefined): MemoryKind | undefined {
  return MEMORY_KINDS.includes(value as MemoryKind) ? value as MemoryKind : undefined
}

/** Cap one page so a browser cannot ask for an unbounded read. */
const MAX_PAGE = 200

/**
 * Build the `memories` Remote service.
 *
 * Every method resolves its project root from the slug the browser passed, so a
 * settings page can never reach a scope the store does not already know: an
 * unknown slug is an empty result, never a path the caller supplied.
 *
 * @param host - store access and the harness home.
 * @returns the service object plus its `typertRemote` binding.
 */
export function createRemoteService(host: RemoteHost): MemoriesRemote & { readonly typertRemote: unknown } {
  const { store, dshHome } = host

  /** Resolve a project slug to its descriptor, or `undefined`. */
  const projectOf = async (slug: string | undefined): Promise<ProjectDescriptor | undefined> => {
    const wanted = (slug ?? '').trim()
    if (wanted.length === 0) return undefined
    return await store.readProjectDescriptor(wanted)
  }

  /** Load the requested scopes for one project slug. */
  const groupsOf = async (slug: string | undefined, scope: string | undefined): Promise<ScopeEntries[]> => {
    const wanted = scopeOf(scope)
    const groups: ScopeEntries[] = []
    if (wanted === undefined || wanted === 'global') {
      const target = store.target('global', undefined)
      groups.push({ scope: 'global', label: target.label, entries: await store.list('global', undefined) })
    }
    if (wanted === undefined || wanted === 'project') {
      const project = await projectOf(slug)
      if (project !== undefined) {
        const target = store.target('project', project.root)
        groups.push({ scope: 'project', label: target.label, entries: await store.list('project', project.root) })
      }
    }
    return groups
  }

  /** Whether one draft is already promoted into the harness skill root. */
  const isPromoted = (name: string): boolean => existsSync(join(dshHome, 'skills', name, 'SKILL.md'))

  const service: MemoriesRemote = {
    async overview(): Promise<OverviewView> {
      const drafts = await listDrafts(store.memoriesDir)
      const projects = []
      for (const slug of await store.listProjects()) {
        const descriptor = await store.readProjectDescriptor(slug)
        if (descriptor === undefined) continue
        projects.push({
          slug,
          name: descriptor.name,
          root: descriptor.root,
          count: (await store.list('project', descriptor.root)).length,
          updatedAt: descriptor.updatedAt,
        })
      }
      return {
        storePath: store.memoriesDir,
        globalCount: (await store.list('global', undefined)).length,
        projects,
        drafts: drafts.map((draft) => ({
          name: draft.name,
          description: draft.description,
          promoted: isPromoted(draft.name),
        })),
        kinds: [...MEMORY_KINDS],
      }
    },

    async list(project?: string, scope?: string, query?: string, kind?: string, limit?: number) {
      const groups = await groupsOf(project, scope)
      const page = Math.min(MAX_PAGE, Math.max(1, Math.trunc(limit ?? 50)))
      const kinds = kindOf(kind)
      const options = { limit: MAX_PAGE, ...kinds === undefined ? {} : { kinds: [kinds] } }
      const text = (query ?? '').trim()
      const hits = text.length > 0
        ? searchMemories(groups, text, options)
        : browseMemories(groups, options)
      return { entries: hits.slice(0, page).map((hit) => entryView(hit.entry)), total: hits.length }
    },

    async add(project?: string, scope?: string, kind?: string, title?: string, body?: string, tags?: string) {
      const target = scopeOf(scope) ?? 'global'
      const descriptor = target === 'project' ? await projectOf(project) : undefined
      if (target === 'project' && descriptor === undefined) {
        throw new Error('dsh-memories: no project scope matches that slug; a project scope appears once a session has run in that workspace')
      }
      const heading = (title ?? '').trim()
      const text = (body ?? '').trim()
      if (heading.length === 0 || text.length === 0) {
        throw new Error('dsh-memories: a memory needs both a title and a body')
      }
      const keywords = (tags ?? '').split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
      const result = await store.upsert({ scope: target, title: heading, body: text, tags: keywords, kind: toMemoryKind(kind) }, descriptor?.root, 'user')
      return { entry: entryView(result.entry) }
    },

    async forget(project?: string, scope?: string, id?: string) {
      const target = scopeOf(scope) ?? 'global'
      const descriptor = target === 'project' ? await projectOf(project) : undefined
      if (target === 'project' && descriptor === undefined) return { removed: false }
      return { removed: await store.remove(target, descriptor?.root, (id ?? '').trim()) }
    },

    async promoteSkill(name?: string) {
      const wanted = (name ?? '').trim()
      const path = await promote(store.memoriesDir, dshHome, wanted)
      if (path === undefined) throw new Error(`dsh-memories: no staged skill draft named ${JSON.stringify(wanted)}`)
      return { name: wanted, path }
    },

    async discardSkill(name?: string) {
      const wanted = (name ?? '').trim()
      return { name: wanted, removed: await discardDraft(store.memoriesDir, wanted) }
    },

    async disputes() {
      if (host.disputes === undefined) return { disputes: [] }
      const rows = await host.disputes()
      return {
        disputes: rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          action: row.action,
          title: row.title,
          reason: row.reason,
          // The page shows both versions; a decision about a rewrite is only
          // meaningful next to what it is rewriting.
          before: row.before,
          after: row.after,
        })),
      }
    },

    async resolveDispute(id?: string, decision?: string) {
      const wanted = (id ?? '').trim()
      if (wanted.length === 0) return 'No decision id was given.'
      const action = decision === 'reject' ? 'reject' : 'accept'
      if (host.resolveDispute === undefined) return 'No decisions are waiting.'
      return await host.resolveDispute(wanted, action) ?? 'That decision is no longer waiting.'
    },
  }
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: REMOTE_SERVICE, namespace: REMOTE_NAMESPACE },
  })
  return service as unknown as MemoriesRemote & { readonly typertRemote: unknown }
}
