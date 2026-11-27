import { claimStoryPreparation as claim } from '../../server/src/services/storyPreparationClaims.ts'

export * from '../../server/src/services/storyPreparationClaims.ts'

let ready = false
export async function claimStoryPreparation(leaseMs) {
  const result = await claim(leaseMs)
  if (!ready) {
    ready = true
    process.send({ type: 'preparation-ready' })
  }
  return result
}
