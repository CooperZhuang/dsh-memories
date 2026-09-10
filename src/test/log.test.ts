/**
 * Tests for the plugin's log sink.
 *
 * The behaviour worth pinning is the one that was silently broken: the host
 * filters `warn` (level 2) and `debug` (3) out before any sink sees them when no
 * exporter declares a threshold, so a sink registered the usual way records only
 * `error` and `info`. These tests hold the override in place, and then the level
 * semantics this plugin layers on top of it.
 *
 * @module dsh-memories/test/log.test
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LOG_NAME, MemoryLog, allows, createFileSink, createLogExporter, formatLogMessage, logPath, pluginLogger, toLogLevel } from '../log.js'
import type { LoggerType } from '@deepseek-ai/cordis'

/** Every severity, most serious first. */
const TYPES: readonly LoggerType[] = ['error', 'warn', 'info', 'debug']

/** The severities recorded at one verbosity. */
function recorded(level: Parameters<typeof allows>[0]): LoggerType[] {
  return TYPES.filter((type) => allows(level, type))
}

test('toLogLevel accepts the documented names and falls back to info', () => {
  for (const name of ['off', 'error', 'warn', 'info', 'debug'] as const) assert.equal(toLogLevel(name), name)
  assert.equal(toLogLevel('verbose'), 'info')
  assert.equal(toLogLevel(undefined), 'info')
  assert.equal(toLogLevel(7), 'info')
  assert.equal(toLogLevel('verbose', 'debug'), 'debug')
})

test('a level means "this and everything more serious"', () => {
  assert.deepEqual(recorded('off'), [])
  assert.deepEqual(recorded('error'), ['error'])
  assert.deepEqual(recorded('warn'), ['error', 'warn'])
  assert.deepEqual(recorded('info'), ['error', 'warn', 'info'])
  assert.deepEqual(recorded('debug'), ['error', 'warn', 'info', 'debug'])
})

test('formatLogMessage renders the host placeholders on a single line', () => {
  const exporter = { colors: false as const, export: () => undefined }
  const message: Message = {
    sn: 1,
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    name: 'dsh-memories',
    type: 'warn',
    level: 2,
    args: ['stored %d of %s\nsecond line', 3, 'x'],
  }
  assert.equal(formatLogMessage(exporter, message), '2026-01-02T03:04:05.000Z [warn] dsh-memories stored 3 of x second line')
})

test('the file sink appends, rotates one generation, and refuses an unusable path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-log-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'dsh-memories.log')
  const sink = createFileSink(path, 40)
  assert.ok(sink !== undefined)
  sink.write('a'.repeat(50))
  sink.write('second')
  assert.equal(await readFile(path, 'utf8'), 'second\n')
  assert.equal(await readFile(`${path}.1`, 'utf8'), `${'a'.repeat(50)}\n`)

  assert.equal(createFileSink('   '), undefined, 'an empty path disables the sink')
  // A path whose parent is a file cannot be created; the caller is told so
  // rather than handed a sink that throws on the first write.
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'not a directory', 'utf8')
  assert.equal(createFileSink(join(blocker, 'x.log')), undefined)
})

test('logPath keeps the log inside the harness home', () => {
  assert.equal(logPath(join('C:', 'home', '.dsh')), join('C:', 'home', '.dsh', 'logs', 'dsh-memories.log'))
})

test('a real cordis sink records warn and debug, which the host would otherwise drop', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-sink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'dsh-memories.log')
  let level = 'debug'
  const ctx = new Context()
  const sink = createFileSink(path)
  assert.ok(sink !== undefined)
  const exporter = createLogExporter(sink, () => level)
  // The declaration that makes the difference: without a threshold for this
  // logger the host falls back to 1 and everything below `info` is discarded
  // before reaching us. Scoping it to the name is equally deliberate — an
  // exporter is process-wide, and `default: 3` would hand this file every other
  // plugin's debug traffic too.
  assert.equal(exporter.levels?.[LOG_NAME], 3)
  assert.equal(exporter.levels?.default, undefined)
  ctx.logger.exporter(exporter)

  const log = new MemoryLog(pluginLogger(ctx.logger), () => true)
  log.warn('careful %d', 1)
  log.info('stored %d memories', 2)
  log.decision('archived %s', 'ancient')
  log.debug('quiet detail')
  // Somebody else's line must not land in this plugin's file.
  ctx.logger('web-server').warn('ECONNRESET from another plugin')
  // A line of ours that went out through the service rather than the named
  // logger carries the fiber's name, so the host applies its own fallback
  // threshold to it — which delivers `info` but drops `warn`. The name check is
  // why every call site uses the named logger; the prefix is only insurance for
  // what the host did deliver.
  ctx.logger.info('dsh-memories: service-level line %d', 3)

  const written = await readFile(path, 'utf8')
  assert.match(written, /\[warn\] .*careful 1/u, 'a warning must reach the file')
  assert.match(written, /\[info\] .*stored 2 memories/u)
  assert.match(written, /\[info\] .*archived ancient/u, 'tracing raises a decision to info')
  assert.match(written, /\[debug\] .*quiet detail/u)
  assert.match(written, /service-level line 3/u, 'a prefixed line is ours even from the service')
  assert.doesNotMatch(written, /another plugin/u, 'only this plugin\'s lines belong in its file')

  // The verbosity is read per line, so a settings change applies immediately.
  level = 'error'
  log.warn('after the change')
  assert.doesNotMatch(await readFile(path, 'utf8'), /after the change/u)
})

test('a decision is debug when tracing is off', () => {
  const seen: [string, string][] = []
  const logger = {
    error: (...args: unknown[]) => seen.push(['error', String(args[0])]),
    warn: (...args: unknown[]) => seen.push(['warn', String(args[0])]),
    info: (...args: unknown[]) => seen.push(['info', String(args[0])]),
    debug: (...args: unknown[]) => seen.push(['debug', String(args[0])]),
  }
  const quiet = new MemoryLog(logger, () => false)
  quiet.decision('archived %s', 'x')
  quiet.warn('a real warning')
  assert.deepEqual(seen, [['debug', 'archived %s'], ['warn', 'a real warning']])

  const loud = new MemoryLog(logger, () => true)
  loud.decision('reviewed %d', 2)
  assert.deepEqual(seen.at(-1), ['info', 'reviewed %d'])
})
