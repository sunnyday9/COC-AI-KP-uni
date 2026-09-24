/** Story dossier operations used by story setup screens. */
import { getBridge } from '../platform'
import type { StoryDossierGenerateResult, StoryDossierSummary } from '../../../shared/types/bridge'
import { retryTransientRequest } from './retry'

export type { StoryDossierGenerateResult, StoryDossierSummary }

export function listStoryDossiers(): Promise<StoryDossierSummary[]> {
  return getBridge().dossierList()
}

export function generateStoryDossier(scriptId: string, operationId?: string): Promise<StoryDossierGenerateResult> {
  return retryTransientRequest(() => getBridge().dossierGenerate(scriptId, operationId))
}
