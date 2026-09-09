/**
 * Ad-hoc session-log inspector used while validating `dsh-memories` against a
 * real DSH run: decompresses session logs and reports whether the memory block
 * and the `memory` tool reached the model.
 *
 * Usage: node scripts/inspect-session.mjs [sessionDirOrFile] [--all]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'C:/Users/<user>/.dsh/sessions'

/** Collect every session log under a root. */
function logs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) logs(path, out)
    else if (entry.name === 'session.jsonl.zstd') out.push(path)
  }
  return out
}

/**
 * Decompress one log. Session logs are an append-only series of concatenated
 * zstd frames, so every frame boundary is decoded and joined; a single-shot
 * decode would stop at the first frame and hide the whole conversation.
 */
function readLog(path) {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = 0
  while ((index = buffer.indexOf(magic, index)) >= 0) {
    offsets.push(index)
    index += 4
  }
  const parts = []
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame]
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // Not a standalone frame boundary; skip.
    }
  }
  return parts.join('')
}

const args = process.argv.slice(2)
const all = args.includes('--all')
const explicit = args.find((value) => !value.startsWith('--'))
const files = explicit !== undefined
  ? [explicit]
  : logs(ROOT).map((path) => ({ path, mtime: statSync(path).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, all ? 200 : 5).map((item) => item.path)

for (const file of files) {
  const text = readLog(file)
  if (text.length === 0) continue
  const hasBlock = text.includes('memory-context')
  const hasTool = text.includes('"name":"memory"')
  if (!all && !hasBlock && !hasTool) continue
  console.log(`\n=== ${file} (${text.length} bytes) block=${hasBlock} tool=${hasTool}`)
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'request/header') {
      const tools = (event.data.header.tools ?? []).map((tool) => tool.name)
      const system = event.data.header.system ?? ''
      console.log(`  header model=${event.data.header.config.model} tools=[${tools.join(', ')}] memoryInSystem=${system.includes('memory-context')}`)
    }
    if (event.type === 'user/message') {
      const source = event.data.source ?? {}
      const preview = JSON.stringify(event.data.content).slice(0, 100)
      console.log(`  user/message source=${JSON.stringify(source).slice(0, 90)} content=${preview}`)
    }
    if (event.type === 'tool/call') console.log(`  tool/call ${event.data.name} ${String(event.data.arguments).slice(0, 160)}`)
    if (event.type === 'tool/result') console.log(`  tool/result ${JSON.stringify(event.data.message?.content ?? '').slice(0, 200)}`)
  }
}
