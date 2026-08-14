import type { TraceEvent, Span, Trace, TraceEventType, TraceEventMap } from './types'

type Listener = (event: TraceEvent) => void

let _enabled = false
let _currentTrace: Trace | null = null
let _traceCounter = 0
let _eventCounter = 0
const _listeners = new Set<Listener>()
const _traceHistory: Trace[] = []
const MAX_TRACE_HISTORY = 50

function generateEventId(): string {
  return 'evt_' + (++_eventCounter) + '_' + Date.now().toString(36)
}

function generateTraceId(): string {
  return 'trace_' + (++_traceCounter) + '_' + Date.now().toString(36)
}

function ensureSpan(trace: Trace, spanName: string): Span {
  let span = trace.spans.get(spanName)
  if (!span) {
    span = { name: spanName, startTime: Date.now(), events: [] }
    trace.spans.set(spanName, span)
  }
  return span
}

export const traceBus = {
  get enabled() { return _enabled },
  set enabled(val: boolean) { _enabled = val },

  get currentTrace(): Trace | null { return _currentTrace },
  get traceHistory(): readonly Trace[] { return _traceHistory },

  startTrace(turnId: string): string {
    if (!_enabled) return ''
    const id = generateTraceId()
    _currentTrace = {
      id,
      turnId,
      startTime: Date.now(),
      spans: new Map(),
      events: [],
    }
    return id
  },

  emit<T extends TraceEventType>(spanName: string, eventType: T, data: TraceEventMap[T]): void {
    if (!_enabled || !_currentTrace) return
    const span = ensureSpan(_currentTrace, spanName)
    const event: TraceEvent = {
      id: generateEventId(),
      traceId: _currentTrace.id,
      spanName,
      eventType,
      timestamp: Date.now(),
      data: data as Record<string, unknown>,
    }
    span.events.push(event)
    _currentTrace.events.push(event)
    for (const listener of _listeners) {
      try { listener(event) } catch { /* don't let listener errors break tracing */ }
    }
  },

  /** Emit a raw event from main process trace data (no type checking) */
  emitRaw(spanName: string, eventType: string, data: Record<string, unknown>): void {
    if (!_enabled || !_currentTrace) return
    const span = ensureSpan(_currentTrace, spanName)
    const event: TraceEvent = {
      id: generateEventId(),
      traceId: _currentTrace.id,
      spanName,
      eventType,
      timestamp: Date.now(),
      data,
    }
    span.events.push(event)
    _currentTrace.events.push(event)
    for (const listener of _listeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  },

  endTrace(): Trace | null {
    if (!_enabled || !_currentTrace) return null
    _currentTrace.endTime = Date.now()
    for (const span of _currentTrace.spans.values()) {
      if (!span.endTime) span.endTime = Date.now()
    }
    const trace = _currentTrace
    _traceHistory.push(trace)
    if (_traceHistory.length > MAX_TRACE_HISTORY) {
      _traceHistory.shift()
    }
    _currentTrace = null
    return trace
  },

  subscribe(listener: Listener): () => void {
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  },

  clearHistory(): void {
    _traceHistory.length = 0
  },

  /** Export all traces as a serializable array (Maps → objects) */
  exportTraces(): unknown[] {
    return _traceHistory.map(t => ({
      ...t,
      spans: Object.fromEntries(t.spans),
    }))
  },
}
