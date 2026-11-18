/** LRU by estimated resident bytes, including a per-entry overhead allowance. */
export class BoundedCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>()
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, jsonBytes: number): void {
    this.delete(key)
    const weight = 256 + jsonBytes * 3
    if (weight > this.maxBytes) return
    for (const oldest of this.entries.keys()) {
      if (this.bytes + weight <= this.maxBytes) break
      this.delete(oldest)
    }
    this.entries.set(key, { value, weight })
    this.bytes += weight
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.bytes -= entry.weight
  }
}
