/**
 * The plugin's own log sink.
 *
 * This exists because the host logger drops most of what this plugin says.
 * cordis decides per exporter with
 * `(exporter.levels?.[name] ?? exporter.levels?.default ?? logger.level ?? 1) < level`,
 * and the only exporter a DSH composition installs is an in-memory ring buffer
 * that declares no levels. With no `logger:` config the threshold resolves to
 * `1`, so `info` (1) is kept while `warn` (2) and `debug` (3) are dropped before
 * any sink sees them — measured against a real cordis root, not assumed.
 *
 * Two consequences shape this module:
 *
 * 1. A sink that wants warnings must declare its own threshold. {@link createLogExporter}
 *    sets `levels.default = 3` and names this plugin's logger, which overrides
 *    the composition's default for our lines.
 * 2. Nothing else in a stock profile reads the ring buffer, so "turn up the log
 *    level" alone changes nothing. The file sink is what makes the plugin's own
 *    decisions observable after the fact.
 *
 * Because an exporter is process-wide, "only our lines" needs stating twice: the
 * name raises our own threshold, and `levels.default = 0` lowers every other
 * logger's to `error`. Without that second half the host's fallback (`logger.level
 * ?? 1`) lets another plugin's `warn` into this file, which is how a plugin log
 * ends up full of `web-server` ECONNRESET lines.
 *
 * Every failure here is swallowed: a log that cannot be written must never fail
 * an extraction, a consolidation, or a turn. Swallowed is not the same as
 * invisible — {@link createFileSink} reports each failed write through
 * `onWriteError`, which is the only way a user can learn that the file they are
 * reading has stopped being written.
 *
 * @module dsh-memories/log
 */
import { Logger } from '@deepseek-ai/cordis'
import type { Exporter, LoggerType, Message } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Verbosity, least to most talkative. `off` records nothing. */
export const LOG_LEVELS = ['off', 'error', 'warn', 'info', 'debug'] as const

/** How much this plugin records in its log file. */
export type LogLevel = (typeof LOG_LEVELS)[number]

/** How large the log may grow before it is rotated once. */
export const LOG_MAX_BYTES = 2 * 1024 * 1024

/** Narrow an unknown value to a log level, defaulting to `info`. */
export function toLogLevel(value: unknown, fallback: LogLevel = 'info'): LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
    ? value as LogLevel
    : fallback
}

/**
 * Importance of one severity, most important first.
 *
 * Deliberately not cordis's numbering, which ranks `info` above `warn`; a log
 * level should mean "this and everything more serious", and everybody reads
 * `warn` as more serious than `info`.
 */
const IMPORTANCE: Record<LoggerType, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * Whether one message is recorded at one verbosity.
 * @param level - the configured verbosity.
 * @param type - the message's severity.
 * @returns true when the message belongs in the log.
 */
export function allows(level: LogLevel, type: LoggerType): boolean {
  if (level === 'off') return false
  return IMPORTANCE[type] <= IMPORTANCE[level]
}

/** Where the plugin writes its log inside one harness home. */
export function logPath(dshHome: string): string {
  return join(dshHome, 'logs', 'dsh-memories.log')
}

/** An append-only text sink. */
export interface LogSink {
  /** Append one already-formatted line. */
  write(line: string): void
}

/**
 * Create the file sink, with one rotated generation beside it.
 *
 * Rotation is deliberately crude — check the size before writing, move the file
 * to `<path>.1` when it is too big, keeping exactly one generation — because the
 * alternative (a log library, or an unbounded file) is worse for a plugin that
 * writes at most a few lines per pass.
 *
 * A write failure is reported through `onWriteError` rather than thrown: the log
 * must never fail a pass, but the caller still has to be able to tell a user that
 * the file stopped growing. The callback fires once per failure, not per retry.
 *
 * @param path - absolute log path; an empty string disables the sink.
 * @param maxBytes - size at which the file is rotated.
 * @param onWriteError - called with the reason a write failed.
 * @returns the sink, or `undefined` when the directory cannot be created.
 */
export function createFileSink(path: string, maxBytes = LOG_MAX_BYTES, onWriteError?: (reason: string) => void): LogSink | undefined {
  if (path.trim().length === 0) return undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (error) {
    onWriteError?.(describeError(error))
    return undefined
  }
  return {
    write(line: string): void {
      try {
        const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
        if (size >= maxBytes) {
          rmSync(`${path}.1`, { force: true })
          renameSync(path, `${path}.1`)
        }
        appendFileSync(path, `${line}\n`, 'utf8')
      } catch (error) {
        // A log that cannot be written is not worth failing a pass over — but it
        // is worth saying out loud, because the file is now silently stale.
        onWriteError?.(describeError(error))
      }
    },
  }
}

/** One-line description of a caught value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Format one host message as a single timestamped line.
 *
 * The argument rendering is the host's own (`Logger.format`), so `%s`/`%d`/`%o`
 * and `Error` arguments read exactly as they would in any other DSH log; the
 * prefix and the collapsed newlines are what make it greppable in a file.
 *
 * @param exporter - the sink the message is being written to, for its formatters.
 * @param message - the structured record.
 * @returns one line, without a trailing newline.
 */
export function formatLogMessage(exporter: Exporter, message: Message): string {
  const body = Logger.format(exporter, message)
  return `${new Date(message.ts).toISOString()} [${message.type}] ${message.name} ${body.replace(/\s*\n\s*/gu, ' ')}`
}

/** The logger name every line from this plugin carries, and the sink filters on. */
export const LOG_NAME = 'dsh-memories'

/**
 * Whether one host message belongs in this plugin's file.
 *
 * The name is the real filter, but the prefix is accepted as a fallback: a line
 * that goes out through `ctx.logger` instead of the named logger carries the
 * fiber's name (`memories`), not this one, and dropping the plugin's own message
 * silently is exactly the failure mode this module exists to prevent. The host
 * still applies its own threshold to such a line, so the fallback only rescues
 * what was delivered — which is why every call site uses the named logger.
 *
 * @param message - the structured record.
 * @param name - the logger name this file owns.
 * @returns true when the message is ours.
 */
export function ownsMessage(message: Message, name = LOG_NAME): boolean {
  if (message.name === name) return true
  const first = message.args[0]
  return typeof first === 'string' && first.startsWith('dsh-memories:')
}

/**
 * Build the exporter that writes to a sink.
 *
 * `levels` is the whole reason this object exists. cordis filters each message
 * per exporter against `exporter.levels?.[name] ?? exporter.levels?.default ??
 * logger.level ?? 1`, and the composition's only default exporter declares no
 * levels, so the threshold falls back to `1` and every `warn` and `debug` line is
 * discarded before a sink sees it. The map therefore carries both directions:
 *
 * - `[name]: 3` raises THIS logger's threshold, so the plugin's own `warn` and
 *   `debug` reach the file.
 * - `default: 0` lowers every OTHER logger's threshold to `error`, so a foreign
 *   plugin's `warn` cannot land in this plugin's file. Without it the fallback
 *   threshold of `1` lets `web-server` connection noise in — measured on a real
 *   profile, not assumed.
 *
 * `export` still checks the name, because messages that pass the threshold arrive
 * from every exporter and the file should be this plugin's record alone.
 *
 * The verbosity thunk returns a plain string because that is what the settings
 * schema declares; an unrecognized value normalizes to `info` here exactly as it
 * does in the runtime, so the two can never disagree about what "warn" means.
 *
 * @param sink - where formatted lines go.
 * @param level - the verbosity in force right now.
 * @param name - the logger name this file owns.
 * @returns the exporter to hand `ctx.logger.exporter`.
 */
export function createLogExporter(sink: LogSink, level: () => string, name = LOG_NAME): Exporter {
  const exporter: Exporter = {
    colors: false,
    levels: { [name]: 3, default: 0 },
    export: (message: Message): void => {
      if (!ownsMessage(message, name)) return
      if (!allows(toLogLevel(level()), message.type)) return
      sink.write(formatLogMessage(exporter, message))
    },
  }
  return exporter
}

/**
 * Resolve the plugin's named logger.
 *
 * A name is what keeps this plugin's file to this plugin's lines. Deployments and
 * test doubles that expose only the service's methods (no call signature) fall
 * back to the service itself, which still logs — just under the fiber's name.
 *
 * @param logger - `ctx.logger` as the plugin sees it.
 * @returns the object whose methods the runtime logs through.
 */
export function pluginLogger(logger: unknown): LoggerLike {
  const service = logger as LoggerLike & ((name: string) => LoggerLike)
  if (typeof service === 'function') {
    const named = service(LOG_NAME)
    if (named !== undefined && typeof named.info === 'function') return named
  }
  return service
}

/** The subset of `ctx.logger` this plugin calls. */
export interface LoggerLike {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/**
 * A thin facade over `ctx.logger`.
 *
 * It adds exactly one thing the raw logger cannot express: a *decision* line,
 * which is `info` while `traceMaintenance` is on and `debug` otherwise. The
 * message always goes to the host logger, so every other sink still sees it —
 * only this plugin's file applies `logLevel`.
 */
export class MemoryLog {
  constructor(
    private readonly logger: LoggerLike,
    private readonly trace: () => boolean,
  ) {}

  error(...args: unknown[]): void {
    this.logger.error(...args)
  }

  warn(...args: unknown[]): void {
    this.logger.warn(...args)
  }

  info(...args: unknown[]): void {
    this.logger.info(...args)
  }

  debug(...args: unknown[]): void {
    this.logger.debug(...args)
  }

  /**
   * Record a maintenance decision.
   *
   * Quiet by default: retention, recall and selection emit several lines per
   * pass, and a readable `logLevel: info` is worth more than a complete one.
   * `traceMaintenance` raises them to `info`, which a stock `logLevel` keeps.
   *
   * @param args - the format string and its arguments.
   */
  decision(...args: unknown[]): void {
    if (this.trace()) this.logger.info(...args)
    else this.logger.debug(...args)
  }
}
