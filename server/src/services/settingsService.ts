import type { AppSettings } from '../../../shared/types/settings.js'
import { getDb } from '../db/index.js'
import { BadRequestError } from '../utils/errors.js'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../utils/crypto.js'
import { ALL_PROTOCOL_IDS } from '../../../shared/constants/providers.js'
import { logger } from '../utils/logging.js'

/**
 * Settings service (api-contract §2) — per-user settings stored in the
 * `settings` table as a JSON document. Defaults mirror the original
 * `src/stores/settingsStore.ts` defaultSettings / defaultRAG.
 *
 * apiKey is stored AES-256-GCM encrypted (EncryptedSecret JSON fragment);
 * GET responses omit the field entirely; PUT updates it only when the request
 * body actually carries a new apiKey.
 */

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    protocol: 'openai_chat',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    maxTokens: 2048,
  },
  rag: {
    useEmbeddings: true,
    provider: 'builtin',
    model: 'text-embedding-3-small',
    useGraphRAG: true,
    extractionModel: '',
  },
  syncServerUrl: 'http://localhost:3000',
}

/**
 * On-disk settings shape: identical to AppSettings except `ai.apiKey` holds
 * the EncryptedSecret JSON fragment instead of a plaintext string.
 */
export type StoredAiConfig = Omit<AppSettings['ai'], 'apiKey'> & { apiKey?: EncryptedSecret }
export type StoredSettings = Omit<AppSettings, 'ai'> & { ai: StoredAiConfig }

/** Legacy placeholder the old client used to signal "keep the stored key". */
const API_KEY_PLACEHOLDER = '***'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRow(userId: number): Record<string, unknown> | null {
  const row = getDb()
    .prepare('SELECT data FROM settings WHERE user_id = ?')
    .get(userId) as { data: string } | undefined
  if (!row) return null
  try {
    const parsed: unknown = JSON.parse(row.data)
    return isRecord(parsed) ? parsed : null
  } catch {
    logger.warn('settings row unparseable, treating as empty', { userId })
    return null
  }
}

function writeRow(userId: number, data: StoredSettings): void {
  getDb()
    .prepare(
      'INSERT INTO settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data',
    )
    .run(userId, JSON.stringify(data))
}

/** Validate a settings patch; throws BadRequestError on any invalid field. */
export function validatePatch(patch: unknown): void {
  if (!isRecord(patch)) {
    throw new BadRequestError('settings must be an object')
  }
  const ai = patch.ai === undefined ? {} : patch.ai
  if (!isRecord(ai)) throw new BadRequestError('settings.ai must be an object')

  const { protocol, baseUrl, model, temperature, maxTokens } = ai
  if (protocol !== undefined) {
    if (typeof protocol !== 'string' || !ALL_PROTOCOL_IDS.has(protocol)) {
      throw new BadRequestError('invalid protocol')
    }
  }
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new BadRequestError('settings.ai.baseUrl must be a string')
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new BadRequestError('settings.ai.model must be a string')
  }
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new BadRequestError('settings.ai.temperature must be a number between 0 and 2')
    }
  }
  if (maxTokens !== undefined) {
    if (
      typeof maxTokens !== 'number' ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > 1_000_000
    ) {
      throw new BadRequestError('settings.ai.maxTokens must be an integer between 1 and 1000000')
    }
  }

  const rag = patch.rag === undefined ? {} : patch.rag
  if (!isRecord(rag)) throw new BadRequestError('settings.rag must be an object')
  const { useEmbeddings, provider: ragProvider, model: ragModel, useGraphRAG, extractionModel } = rag
  if (useEmbeddings !== undefined && typeof useEmbeddings !== 'boolean') {
    throw new BadRequestError('settings.rag.useEmbeddings must be a boolean')
  }
  if (ragProvider !== undefined && ragProvider !== 'builtin' && ragProvider !== 'api') {
    throw new BadRequestError("settings.rag.provider must be 'builtin' or 'api'")
  }
  if (ragModel !== undefined && typeof ragModel !== 'string') {
    throw new BadRequestError('settings.rag.model must be a string')
  }
  if (useGraphRAG !== undefined && typeof useGraphRAG !== 'boolean') {
    throw new BadRequestError('settings.rag.useGraphRAG must be a boolean')
  }
  if (extractionModel !== undefined && typeof extractionModel !== 'string') {
    throw new BadRequestError('settings.rag.extractionModel must be a string')
  }

  if (patch.syncServerUrl !== undefined && typeof patch.syncServerUrl !== 'string') {
    throw new BadRequestError('settings.syncServerUrl must be a string')
  }
  if (patch.debugMode !== undefined && typeof patch.debugMode !== 'boolean') {
    throw new BadRequestError('settings.debugMode must be a boolean')
  }
}

/** AppSettings with the apiKey field removed (GET /api/settings response). */
export function withoutApiKey(settings: StoredSettings): AppSettings {
  const { apiKey: _apiKey, ...ai } = settings.ai
  return { ...settings, ai }
}

/** Read public settings for a user; defaults when nothing stored yet. */
export function getSettings(userId: number): AppSettings {
  const raw = readRow(userId)
  return withoutApiKey(mergeDefaults(raw ?? {}))
}

/**
 * Full AI config for server-side use (aiService) — includes the DECRYPTED
 * apiKey. Never exposed through HTTP.
 */
export function getAiConfig(userId: number): AppSettings['ai'] {
  const raw = readRow(userId)
  const merged = mergeDefaults(raw ?? {})
  const ai: AppSettings['ai'] = {
    protocol: merged.ai.protocol,
    baseUrl: merged.ai.baseUrl,
    model: merged.ai.model,
    temperature: merged.ai.temperature,
    maxTokens: merged.ai.maxTokens,
  }
  if (merged.ai.apiKey !== undefined) {
    const plain = decryptSecret(merged.ai.apiKey)
    if (plain === undefined) {
      logger.warn('failed to decrypt stored apiKey', { userId })
    } else {
      ai.apiKey = plain
    }
  }
  return ai
}

/**
 * Save a settings patch: validate → merge with defaults → encrypt new apiKey
 * (or carry over the stored ciphertext when the patch omits it).
 */
export function saveSettings(userId: number, patch: unknown): AppSettings {
  validatePatch(patch)
  const existing = readRow(userId) ?? {}

  const aiIn = (patch as Record<string, unknown>).ai as Record<string, unknown> | undefined
  let apiKey: EncryptedSecret | undefined
  if (aiIn?.apiKey !== undefined) {
    const key = aiIn.apiKey
    if (typeof key === 'string' && key !== '' && key !== API_KEY_PLACEHOLDER) {
      apiKey = encryptSecret(key)
    } else if (isRecord(existing.ai) && existing.ai.apiKey !== undefined) {
      apiKey = existing.ai.apiKey as EncryptedSecret
    }
  } else if (isRecord(existing.ai) && existing.ai.apiKey !== undefined) {
    apiKey = existing.ai.apiKey as EncryptedSecret
  }

  const merged = mergeDefaults(patch as Record<string, unknown>)
  if (apiKey) merged.ai.apiKey = apiKey
  else delete merged.ai.apiKey

  writeRow(userId, merged)
  return withoutApiKey(merged)
}

/** Merge a validated patch over DEFAULT_SETTINGS (deep for ai/rag). */
function mergeDefaults(patch: Record<string, unknown>): StoredSettings {
  const aiIn = isRecord(patch.ai) ? patch.ai : {}
  const ragIn = isRecord(patch.rag) ? patch.rag : {}
  const merged: StoredSettings = {
    ...DEFAULT_SETTINGS,
    ai: {
      protocol:
        typeof aiIn.protocol === 'string' && ALL_PROTOCOL_IDS.has(aiIn.protocol)
          ? (aiIn.protocol as AppSettings['ai']['protocol'])
          : DEFAULT_SETTINGS.ai.protocol,
      baseUrl: typeof aiIn.baseUrl === 'string' ? aiIn.baseUrl : DEFAULT_SETTINGS.ai.baseUrl,
      model: typeof aiIn.model === 'string' ? aiIn.model : DEFAULT_SETTINGS.ai.model,
      temperature: typeof aiIn.temperature === 'number' ? aiIn.temperature : DEFAULT_SETTINGS.ai.temperature,
      maxTokens: typeof aiIn.maxTokens === 'number' ? aiIn.maxTokens : DEFAULT_SETTINGS.ai.maxTokens,
      ...(aiIn.apiKey !== undefined ? { apiKey: aiIn.apiKey as EncryptedSecret } : {}),
    },
    rag: {
      useEmbeddings: typeof ragIn.useEmbeddings === 'boolean' ? ragIn.useEmbeddings : DEFAULT_SETTINGS.rag!.useEmbeddings,
      provider: ragIn.provider === 'builtin' || ragIn.provider === 'api' ? ragIn.provider : DEFAULT_SETTINGS.rag!.provider,
      model: typeof ragIn.model === 'string' ? ragIn.model : DEFAULT_SETTINGS.rag!.model,
      useGraphRAG: typeof ragIn.useGraphRAG === 'boolean' ? ragIn.useGraphRAG : DEFAULT_SETTINGS.rag!.useGraphRAG,
      extractionModel:
        typeof ragIn.extractionModel === 'string' ? ragIn.extractionModel : DEFAULT_SETTINGS.rag!.extractionModel,
    },
    ...(typeof patch.syncServerUrl === 'string' ? { syncServerUrl: patch.syncServerUrl } : {}),
    ...(typeof patch.debugMode === 'boolean' ? { debugMode: patch.debugMode } : {}),
  }
  return merged
}
