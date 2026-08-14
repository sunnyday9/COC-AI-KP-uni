/**
 * Minimal structured logger with level, timestamp and optional traceId.
 * Migrated in spirit from original electron/logging.cjs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const DEFAULT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'

export interface LogContext {
  [key: string]: unknown
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export class Logger {
  readonly level: LogLevel
  readonly traceId?: string

  constructor(level: LogLevel = DEFAULT_LEVEL, traceId?: string) {
    this.level = level
    this.traceId = traceId
  }

  /** Derive a child logger carrying the given traceId (request/stream correlation). */
  child(traceId: string): Logger {
    return new Logger(this.level, traceId)
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context)
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context)
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context)
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return
    const ts = new Date().toISOString()
    const trace = this.traceId ? ` [trace=${this.traceId}]` : ''
    const parts = [`[${ts}]`, `[${level.toUpperCase()}]`, `${trace}`, message]
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        parts.push(`${key}=${formatValue(value)}`)
      }
    }
    const line = parts.join(' ')
    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }
}

/** Shared default logger. */
export const logger = new Logger()
