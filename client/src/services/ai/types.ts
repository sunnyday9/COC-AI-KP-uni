/**
 * AI provider types & constants — re-exported from shared (migrated verbatim
 * from the original `services/ai/types.ts` in commit d4edf9c; do not fork).
 */
export {
  PRESET_PROVIDERS,
  CUSTOM_PROVIDERS,
  getProviderDef,
  resolveProtocol,
  resolveBaseUrl,
} from '../../../../shared/constants/providers'
export type {
  AIProviderConfig,
  AIProviderType,
  PresetProvider,
  CustomProvider,
  CompatibleProtocol,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStream,
  ProviderPreset,
  CustomProviderDef,
  AIAdapter,
} from '../../../../shared/constants/providers'
