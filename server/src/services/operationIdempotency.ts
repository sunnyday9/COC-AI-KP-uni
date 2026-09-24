const RESULT_TTL_MS = 10 * 60 * 1000
interface OperationEntry {
  promise: Promise<unknown>
  expiresAt: number | null
  activeKey: string
}

const operations = new Map<string, OperationEntry>()
const activeOperations = new Map<string, OperationEntry>()

/** Reuse retries by request id and coalesce concurrent work for the same story. */
export function runIdempotently<T>(key: string, action: () => Promise<T>, activeKey = key): Promise<T> {
  const now = Date.now()
  for (const [entryKey, entry] of operations) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) operations.delete(entryKey)
  }

  const existing = operations.get(key)
  if (existing) return existing.promise as Promise<T>

  const active = activeOperations.get(activeKey)
  if (active) {
    operations.set(key, active)
    return active.promise as Promise<T>
  }

  const entry: OperationEntry = {
    promise: Promise.resolve().then(action),
    expiresAt: null,
    activeKey,
  }
  operations.set(key, entry)
  activeOperations.set(activeKey, entry)
  void entry.promise.then(
    () => {
      entry.expiresAt = Date.now() + RESULT_TTL_MS
      if (activeOperations.get(activeKey) === entry) activeOperations.delete(activeKey)
    },
    () => {
      for (const [entryKey, operation] of operations) {
        if (operation === entry) operations.delete(entryKey)
      }
      if (activeOperations.get(activeKey) === entry) activeOperations.delete(activeKey)
    },
  )
  return entry.promise as Promise<T>
}

export function validOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value)
}
