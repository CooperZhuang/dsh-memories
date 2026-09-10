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
 *    sets `levels.default = 3`, which overrides the composition's default, and
 *    then filters by `logLevel` itself.
 * 2. Nothing else in a stock profile reads the ring buffer, so "turn up the log
 *    level" alone changes nothing. The file sink is what makes the plugin's own
 *    decisions observable after the fact.
 *
 * Every failure here is swallowed: a log that cannot be written must never fail
 * an extraction, a consolidation, or a turn.
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
 * @param path - absolute log path; an empty string disables the sink.
 * @param maxBytes - size at which the file is rotated.
 * @returns the sink, or `undefined` when the directory cannot be created.
 */
export function createFileSink(path: string, maxBytes = LOG_MAX_BYTES): LogSink | undefined {
  if (path.trim().length === 0) return undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
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
      } catch {
        // A log that cannot be written is not worth failing a pass over.
      }
    },
  }
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

/**
 * Build the exporter that writes to a sink.
 *
 * `levels.default = 3` is the whole reason this object exists: it overrides the
 * composition's implicit threshold of `1`, which is what silently discards every
 * `warn` and `debug` line. {@link allows} then decides what this file records,
 * reading the setting live so a change applies to the next line.
 *
 * The verbosity thunk returns a plain string because that is what the settings
 * schema declares; an unrecognized value normalizes to `info` here exactly as it
 * does in the runtime, so the two can never disagree about what "warn" means.
 *
 * @param sink - where formatted lines go.
 * @param level - the verbosity in force right now.
 * @returns the exporter to hand `ctx.logger.exporter`.
 */
export function createLogExporter(sink: LogSink, level: () => string): Exporter {
  const exporter: Exporter = {
    colors: false,
    levels: { default: 3 },
    export: (message: Message): void => {
      if (!allows(toLogLevel(level()), message.type)) return
      sink.write(formatLogMessage(exporter, message))
    },
  }
  return exporter
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
