// Shared by opening and player-triggered turns. At most one turn per active
// room waits here. The room registry bounds the number of waiters.
let active = 0
const waiting: Array<() => void> = []

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else active--
}

export function acquireKpTurn(signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null)
  const configured = Number(process.env.KP_ACTIVE_TURNS ?? 16)
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 16
  if (active < limit) {
    active++
    return Promise.resolve(release)
  }
  return new Promise((resolve) => {
    const begin = () => {
      signal.removeEventListener('abort', cancel)
      resolve(release)
    }
    const cancel = () => {
      const position = waiting.indexOf(begin)
      if (position !== -1) waiting.splice(position, 1)
      resolve(null)
    }
    waiting.push(begin)
    signal.addEventListener('abort', cancel, { once: true })
  })
}
