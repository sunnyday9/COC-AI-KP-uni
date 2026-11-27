import { BoundedCache } from '../utils/boundedCache.js'
import { loadActivePreparedStory, loadRetainedPreparedStory } from './preparedStoryStorage.js'
import type { StoryRevisionPin } from './roomStorage.js'

export type RoomStoryBundle = Awaited<ReturnType<typeof loadRetainedPreparedStory>>

const bundleCache = new BoundedCache<RoomStoryBundle>(128 * 1024 * 1024)

function ownerRevisionKey(ownerId: number, storyId: string, pin: StoryRevisionPin): string {
  return JSON.stringify([ownerId, storyId, pin.revision, pin.sourceRevision])
}

/** Always check the active pointer against the owner's live catalog at the start gate. */
export async function selectPlayableStory(ownerId: number, storyId: string): Promise<StoryRevisionPin> {
  const bundle = await loadActivePreparedStory(ownerId, storyId, AbortSignal.timeout(15_000))
  const pin = { revision: bundle.revision, sourceRevision: bundle.sourceRevision }
  bundleCache.set(ownerRevisionKey(ownerId, storyId, pin), bundle, bundle.bytes)
  return pin
}

/** Only RoomService supplies a saved pin after enforcing room membership. */
export async function loadRoomStory(ownerId: number, storyId: string, pin: StoryRevisionPin, signal: AbortSignal): Promise<RoomStoryBundle> {
  const key = ownerRevisionKey(ownerId, storyId, pin)
  const cached = bundleCache.get(key)
  if (cached) return cached
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const bundle = await loadRetainedPreparedStory(ownerId, storyId, pin.revision, pin.sourceRevision, boundedSignal)
  bundleCache.set(key, bundle, bundle.bytes)
  return bundle
}
