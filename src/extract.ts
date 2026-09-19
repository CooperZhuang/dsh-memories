/**
 * Idle-time memory extraction.
 *
 * After a session has been quiet for a while, the extractor replays a bounded
 * tail of its transcript through one auxiliary model call and turns the result
 * into memory drafts. It never touches the conversation: extraction runs on the
 * maintenance path, writes only to the memory store, and is fully optional
 * (`autoExtract: false` disables it).
 *
 * @module dsh-memories/extract
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { toMemoryKind } from './types.js'
import type { MemoryDraft, MemoryScope } from './types.js'

/** Model-facing transcript line budget for one extraction window. */
export interface ExtractWindow {
  /** Rendered transcript, oldest first. */
  readonly text: string
  /** Highest surface seq included, or `undefined` when nothing was new. */
  readonly lastSeq: number | undefined
  /** Number of messages included. */
  readonly messages: number
}

/** The system instruction for the extraction call. */
export const EXTRACT_SYSTEM = [
  'You maintain long-term memory for a coding assistant.',
  'Read the supplied conversation transcript and extract only durable, reusable facts that would help in a FUTURE session.',
  '',
  'Record: stable user preferences and working style; project architecture and conventions; build/test/deploy commands; environment and tooling facts; non-obvious gotchas; decisions and their reasons.',
  'Do NOT record: transient task state, one-off debugging output, secrets, API keys, tokens, credentials, personal data, restatements of the code the assistant just wrote, or anything already stated in the transcript as a question rather than a fact.',
  '',
  'Choose the scope of each memory:',
  '- "global": true across every project (how the user likes to work, general preferences, machine/tooling facts).',
  '- "project": true only for this workspace (its architecture, commands, conventions, gotchas).',
  '',
  'Each memory has a short imperative title (max 80 characters), a 1-3 sentence body, up to 5 lowercase keyword tags, and 1-5 search keys: the aliases and keyphrases a future session would actually type (for example "monorepo" for a pnpm-workspace fact).',
  'Give each memory a kind, because the kinds are recalled differently:',
  '- "preference": how the user wants work done, or a correction they issued.',
  '- "failure": something that went wrong and how to avoid repeating it.',
  '- "procedure": an ordered recipe for a recurring task.',
  '- "knowledge": a non-obvious technique worth reusing.',
  '- "fact": durable background that is none of the above.',
  'Add "appliesTo" (a short phrase saying when the memory matters) when the title does not make it obvious.',
  'Prefer few high-value memories over many trivial ones. Return at most the requested number.',
  'Also write "summary": one paragraph (2-4 sentences) saying what this session was about — the task, the decisions, and anything that would help someone judge the memories above later. It is stored as the evidence behind them.',
  'Reply with JSON only, no prose and no code fence: {"summary":string,"memories":[{"scope":"global"|"project","kind":string,"title":string,"body":string,"tags":string[],"appliesTo":string}]}',
  'When nothing is worth remembering, reply exactly {"summary":"","memories":[]}.'
].join('\n')

/** JSON output contract for one extraction call. */
export const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'memories'],
  properties: {
    summary: { type: 'string' },
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'title', 'body'],
        properties: {
          scope: { type: 'string', enum: ['global', 'project'] },
          kind: { type: 'string', enum: ['fact', 'preference', 'knowledge', 'failure', 'procedure'] },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          keys: { type: 'array', items: { type: 'string' } },
          appliesTo: { type: 'string' },
        },
      },
    },
  },
} as const

/** Patterns that look like credentials and must never enter the memory store. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bglpat-[A-Za-z0-9_-]{16,}/gu,
  /\b(?:sk|pk|xox[baprs])-[A-Za-z0-9_-]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*["']?[^\s"',;]{8,}["']?/giu,
  /\bBearer\s+[\w.-]{20,}/gu,
]

/**
 * Redact credential-shaped text. Deliberately conservative and applied before
 * anything is written, because a memory store outlives the session it came from.
 * @param text - candidate memory text.
 * @returns the text with credential-shaped spans replaced.
 */
export function redactSecrets(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[redacted]')
  return redacted
}

/** Extract the text of one content block list. */
function blockText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Collect the conversation tail a session has produced since `afterSeq`.
 *
 * Only user and assistant prose is taken: tool results are dropped because
 * they are bulky and rarely the durable lesson, and plugin-injected context is
 * dropped so memory never feeds on its own summaries.
 *
 * @param session - session to read.
 * @param afterSeq - last surface seq already mined (exclusive).
 * @param maxMessages - message cap.
 * @param maxChars - transcript character cap; the newest messages win.
 * @returns the rendered window and the highest included seq.
 */
export function collectWindow(
  session: Session,
  afterSeq: number,
  maxMessages: number,
  maxChars: number,
): ExtractWindow {
  const floor = SessionSeq(Math.max(0, Math.trunc(afterSeq)))
  const lines: { seq: number; text: string }[] = []
  for (const seq of session.surface.nodes) {
    if (seq <= floor) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && event.data.source.kind !== 'user') continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const text = blockText(message.content)
    if (text.length === 0) continue
    lines.push({ seq, text: `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}` })
  }
  const selected = lines.slice(-maxMessages)
  const kept: string[] = []
  let used = 0
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const line = selected[index]
    if (line === undefined) continue
    const cost = line.text.length + 1
    if (used + cost > maxChars && kept.length > 0) break
    used += cost
    kept.unshift(line.text)
  }
  const lastSeq = selected.at(-1)?.seq
  return { text: kept.join('\n\n'), lastSeq, messages: kept.length }
}

/** Resolve the provider/model route for an extraction call. */
function resolveRoute(
  session: Session,
  provider: string | undefined,
  model: string | undefined,
  fallback: { provider?: string; model?: string },
): { provider: string; model: string } | undefined {
  if (provider !== undefined && model !== undefined) return { provider, model }
  const header = session.requestHeader()
  if (header !== undefined) return { provider: header.config.provider, model: header.config.model }
  if (fallback.provider !== undefined && fallback.model !== undefined) {
    return { provider: fallback.provider, model: fallback.model }
  }
  return undefined
}

/**
 * Parse the model's JSON reply into the session summary and its drafts,
 * tolerating a code fence.
 *
 * Every usable draft in the reply is validated even once the cap is reached, so
 * the caller can report how many were dropped. A pass that always lands exactly
 * on the cap looks identical to a pass that found exactly that many facts, and
 * the difference is the only signal that `extractMaxMemories` is the knob
 * limiting what the plugin remembers.
 *
 * @param text - the model's reply.
 * @param maxMemories - how many drafts to keep.
 * @param sessionId - session the drafts came from, recorded as provenance.
 * @returns the drafts, the evidence summary, and how many were over the cap.
 */
export function parseExtraction(text: string, maxMemories: number, sessionId: string): { drafts: MemoryDraft[]; summary: string; dropped: number } {
  const result = { drafts: [] as MemoryDraft[], summary: '', dropped: 0 }
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return result
  }
  if (typeof parsed !== 'object' || parsed === null || !('memories' in parsed)) return result
  const envelope = parsed as { memories: unknown; summary?: unknown }
  if (typeof envelope.summary === 'string') {
    result.summary = redactSecrets(envelope.summary.replace(/\s+/gu, ' ').trim()).slice(0, 1_200)
  }
  const raw = envelope.memories
  if (!Array.isArray(raw)) return result
  const usable: MemoryDraft[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const scope = record['scope']
    const title = record['title']
    const body = record['body']
    if (scope !== 'global' && scope !== 'project') continue
    if (typeof title !== 'string' || typeof body !== 'string') continue
    const cleanTitle = redactSecrets(title.replace(/\s+/gu, ' ').trim()).slice(0, 120)
    const cleanBody = redactSecrets(body.trim()).slice(0, 2000)
    if (cleanTitle.length === 0 || cleanBody.length === 0) continue
    if (cleanTitle === '[redacted]' || cleanBody === '[redacted]') continue
    const tags = Array.isArray(record['tags'])
      ? record['tags'].filter((tag): tag is string => typeof tag === 'string')
      : []
    const keys = Array.isArray(record['keys']) ? record['keys'].filter((key): key is string => typeof key === 'string') : []
    const appliesTo = typeof record['appliesTo'] === 'string'
      ? redactSecrets(record['appliesTo'].replace(/\s+/gu, ' ').trim()).slice(0, 160)
      : ''
    usable.push({
      scope: scope as MemoryScope,
      kind: toMemoryKind(record['kind']),
      title: cleanTitle,
      body: cleanBody,
      tags,
      keys,
      ...appliesTo.length > 0 ? { appliesTo } : {},
      sourceSession: sessionId,
    })
  }
  result.drafts = usable.slice(0, Math.max(0, maxMemories))
  result.dropped = usable.length - result.drafts.length
  return result
}

/** Everything one extraction call needs. */
export interface ExtractionRequest {
  /** Session being mined. */
  readonly session: Session
  /** Transcript window. */
  readonly window: ExtractWindow
  /** Model-facing label of the project scope, for the prompt. */
  readonly projectLabel: string
  /** Explicit route override. */
  readonly provider?: string
  readonly model?: string
  /** Route used when the session has logged no request header yet. */
  readonly fallbackRoute?: { readonly provider?: string; readonly model?: string }
  /** Caps and deadline. */
  readonly maxOutputTokens: number
  readonly maxMemories: number
  readonly timeoutMs: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

/** Outcome of one extraction call. */
export type ExtractionOutcome =
  | {
    readonly kind: 'memories'
    readonly drafts: readonly MemoryDraft[]
    /** What the session was about, stored as the evidence behind the drafts. */
    readonly summary: string
    /** Usable drafts the reply offered beyond `maxMemories`, reported to the caller. */
    readonly dropped: number
    readonly route: { provider: string; model: string }
  }
  | { readonly kind: 'none'; readonly reason: 'empty-window' | 'no-route' | 'empty-reply' }

/**
 * Run one extraction call and return the drafts it produced.
 *
 * Failures are the caller's to contain: this function throws only on transport
 * or protocol errors, and never mutates the session.
 *
 * @param llm - the LLM runtime.
 * @param request - session, window, route, and budget.
 * @returns the parsed drafts, or a reason there are none.
 */
export async function runExtraction(llm: LlmRuntime, request: ExtractionRequest): Promise<ExtractionOutcome> {
  if (request.window.text.trim().length === 0) return { kind: 'none', reason: 'empty-window' }
  const route = resolveRoute(request.session, request.provider, request.model, request.fallbackRoute ?? {})
  if (route === undefined) return { kind: 'none', reason: 'no-route' }
  const framed = [
    `Workspace scope label: ${request.projectLabel}`,
    `Extract at most ${request.maxMemories} memories from this transcript.`,
    '',
    request.window.text,
  ].join('\n')
  const messages = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'dsh-memories' },
  })]
  const timeout = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    system: EXTRACT_SYSTEM,
    maxTokens: request.maxOutputTokens,
    purpose: 'compaction',
    sessionId: request.session.id,
    signal: timeout,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  if (assembler.finish.kind !== 'stop') {
    throw new Error(`dsh-memories: extraction finished as ${assembler.finish.kind}`)
  }
  const text = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const parsed = parseExtraction(text, request.maxMemories, request.session.id)
  if (parsed.drafts.length === 0) return { kind: 'none', reason: 'empty-reply' }
  return { kind: 'memories', drafts: parsed.drafts, summary: parsed.summary, dropped: parsed.dropped, route }
}
