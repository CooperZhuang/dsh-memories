/**
 * The model-facing `memory` tool.
 *
 * One tool with an `action` switch keeps the tool catalog small while giving the
 * model explicit control over scope: it must name `global` or `project` on every
 * write, which is the decision the two-mode design is about.
 *
 * @module dsh-memories/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoriesRuntime } from './index.js'
import { renderEntry, renderHit } from './render.js'
import type { MemoryScope } from './types.js'

/** The scopes the model may name. */
const SCOPES = ['global', 'project'] as const

/** The actions the model may take. */
const ACTIONS = ['write', 'search', 'read', 'forget'] as const

/** Description head: what the tool is for. */
const DESCRIPTION = [
  'Your durable cross-session memory. Use it to remember facts that should survive into future sessions, and to recall what earlier sessions learned.',
  '',
  'When to write (action=write): the user states a preference or working style, a project decision is made with its reason, a command or workflow is discovered, an environment quirk or gotcha is found, or the user asks you to remember something. Do NOT write transient task state, secrets, credentials, or anything already captured in the repository.',
  'When to search (action=search): before starting work that may have been done before, when the user references earlier sessions, or when you need a detail the injected summary only previews.',
  '',
  'Choose the scope deliberately on every write:',
  '- "global" — true across every project: how the user likes to work, durable preferences, general tooling facts. A memory that would help on an unrelated repository belongs here.',
  '- "project" — true only for the current workspace: its architecture, conventions, build/test commands, and gotchas.',
  'If a project memory turns out to be broadly useful, write it to "global" as well rather than moving it.',
  '',
  'Titles are the identity: writing the same title again updates that memory instead of duplicating it.',
].join('\n')

/** Output schema shared by every action. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true, enum: [...ACTIONS] },
    message: { type: 'string', required: true },
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: [...SCOPES] },
          title: { type: 'string', required: true },
          body: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
    },
  },
} as const

/**
 * Register the `memory` tool.
 * @param ctx - context carrying the tool registry.
 * @param runtime - the memory runtime the tool operates on.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerMemoryTool(ctx: Context, runtime: MemoriesRuntime): () => void {
  return ctx.tools.register(defineTool({
    name: 'memory',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'write (store a memory), search (find memories), read (show one by id), forget (delete one).',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        description: 'global for cross-project facts, project for this workspace. Required for write and forget; use it to filter search and read.',
      },
      title: {
        type: 'string',
        description: 'write: short imperative heading (max 80 chars). Also the identity used for deduplication.',
      },
      body: {
        type: 'string',
        description: 'write: the fact to remember, 1-4 sentences, self-contained.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'write/search: lowercase keyword tags.',
      },
      query: {
        type: 'string',
        description: 'search: what to look for. Empty lists the most recent memories.',
      },
      id: {
        type: 'string',
        description: 'read/forget: the memory id from a search result.',
      },
      limit: {
        type: 'integer',
        description: 'search: maximum hits (default 8, max 25).',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ action: value.action, count: value.results.length }),
    },
    isConcurrencySafe: (args) => args.action === 'search' || args.action === 'read',
    async execute(args, exec: ToolRunContext) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dsh-memories: the memory tool requires an owning agent session')
      const session = agent.session
      switch (args.action) {
        case 'write': {
          if (args.scope === undefined) throw new Error('dsh-memories: write requires an explicit scope (global or project)')
          const title = args.title?.trim()
          const body = args.body?.trim()
          if (title === undefined || title.length === 0) throw new Error('dsh-memories: write requires a non-empty title')
          if (body === undefined || body.length === 0) throw new Error('dsh-memories: write requires a non-empty body')
          const result = await runtime.write(session, {
            scope: args.scope,
            title: title.slice(0, 120),
            body,
            tags: args.tags ?? [],
          }, 'tool')
          const hint = args.scope === 'project'
            ? ' If this fact also applies to unrelated projects, write a global copy of it too.'
            : ''
          return {
            ok: true,
            action: args.action,
            message: `${result.action === 'created' ? 'Remembered' : 'Updated'} ${args.scope} memory "${result.entry.title}" (id=${result.entry.id}).${hint}`,
            results: [toResult(result.entry)],
          }
        }
        case 'search': {
          const limit = Math.min(Math.max(args.limit ?? 8, 1), 25)
          const scopes = args.scope === undefined ? undefined : [args.scope]
          const tags = args.tags ?? []
          const query = args.query?.trim() ?? ''
          const hits = query.length === 0
            ? await runtime.browse(session, { ...scopes === undefined ? {} : { scopes }, tags, limit })
            : await runtime.search(session, query, { ...scopes === undefined ? {} : { scopes }, tags, limit })
          if (hits.length === 0) {
            return {
              ok: true,
              action: args.action,
              message: query.length === 0 ? 'No memories stored yet.' : `No memories match ${JSON.stringify(query)}.`,
              results: [],
            }
          }
          await runtime.recordUsage(session, hits.map((hit) => hit.entry))
          return {
            ok: true,
            action: args.action,
            message: [`${hits.length} ${hits.length === 1 ? 'memory' : 'memories'}:`, ...hits.map((hit, index) => renderHit(hit, index))].join('\n'),
            results: hits.map((hit) => toResult(hit.entry)),
          }
        }
        case 'read': {
          const id = args.id?.trim()
          if (id === undefined || id.length === 0) throw new Error('dsh-memories: read requires an id')
          const order: readonly MemoryScope[] = args.scope === undefined ? ['project', 'global'] : [args.scope]
          for (const scope of order) {
            const entry = await runtime.read(session, scope, id)
            if (entry !== undefined) {
              return { ok: true, action: args.action, message: renderEntry(entry), results: [toResult(entry)] }
            }
          }
          return { ok: false, action: args.action, message: `No memory with id ${JSON.stringify(id)}.`, results: [] }
        }
        case 'forget': {
          const id = args.id?.trim()
          if (id === undefined || id.length === 0) throw new Error('dsh-memories: forget requires an id')
          const order: readonly MemoryScope[] = args.scope === undefined ? ['project', 'global'] : [args.scope]
          for (const scope of order) {
            if (await runtime.forget(session, scope, id)) {
              return { ok: true, action: args.action, message: `Forgot ${scope} memory ${JSON.stringify(id)}.`, results: [] }
            }
          }
          return { ok: false, action: args.action, message: `No memory with id ${JSON.stringify(id)}.`, results: [] }
        }
        /* c8 ignore next 2 -- the registry validates the action enum before dispatch */
        default:
          throw new Error(`dsh-memories: unsupported action ${String(args.action)}`)
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'write' ? `Remember (${args.scope ?? 'auto'}): ${args.title ?? ''}` : `Memory ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}

/** Project one entry onto the tool's result payload. */
function toResult(entry: { id: string; scope: MemoryScope; title: string; body: string; tags: readonly string[] }) {
  return { id: entry.id, scope: entry.scope, title: entry.title, body: entry.body, tags: [...entry.tags] }
}
