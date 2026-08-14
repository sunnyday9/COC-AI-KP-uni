import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AIProviderConfig } from '../services/ai/types'
import { PRESET_PROVIDERS, CUSTOM_PROVIDERS } from '../services/ai/types'
import { getBridge } from '../platform'
import type { AppSettings as BridgeAppSettings } from '../../../shared/types/settings'
import type { AuthResult, BridgeUser } from '../../../shared/types/bridge'

export type { AIProviderConfig }

export type RAGEmbeddingProvider = 'builtin' | 'api'

export interface RAGSettings {
  useEmbeddings: boolean
  /** 'builtin' = preloaded local model (no API); 'api' = use AI Base URL + API Key + model */
  provider: RAGEmbeddingProvider
  model: string
  /** Use local GraphRAG (Microsoft GraphRAG-style, COC-specialized) */
  useGraphRAG?: boolean
  /** Model for local GraphRAG extraction when MS GraphRAG unavailable */
  extractionModel?: string
}

export interface AppSettings {
  ai: AIProviderConfig
  rag?: RAGSettings
  syncServerUrl: string
  debugMode?: boolean
}

const ALL_PROVIDER_IDS = new Set<string>([
  ...PRESET_PROVIDERS.map((p) => p.id),
  ...CUSTOM_PROVIDERS.map((p) => p.id),
])

const defaultRAG: RAGSettings = {
  // 默认启用语义检索（嵌入向量），在 Electron 内自动使用本地向量检索 + GraphRAG
  useEmbeddings: true,
  provider: 'builtin',
  model: 'text-embedding-3-small',
  useGraphRAG: true,
  extractionModel: '',
}

const defaultSettings: AppSettings = {
  ai: {
    provider: 'openai',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    maxTokens: 2048,
  },
  rag: defaultRAG,
  syncServerUrl: 'http://localhost:3000',
}

/**
 * 深拷贝默认设置（Task 7 配套修正）：原 `{ ...defaultSettings }` 为浅拷贝，
 * 实例对 settings.ai/rag 的任何就地修改会污染模块级 defaultSettings（原代码
 * 潜在 bug，只影响新加的 logout 清缓存语义）——深拷贝保证每个 store 实例与
 * 登出重置都拿到独立且纯净的默认值。
 */
function cloneDefaultSettings(): AppSettings {
  return JSON.parse(JSON.stringify(defaultSettings)) as AppSettings
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(cloneDefaultSettings())
  /** 认证状态（Task 7 新增）：token 由 Bridge 内部管理，Store 只跟踪是否已登录 */
  const isAuthenticated = ref(false)

  async function load() {
    const saved = await getBridge().getSettings()
    if (saved && typeof saved === 'object') {
      const rawAi = saved.ai && typeof saved.ai === 'object' ? saved.ai as unknown as Record<string, unknown> : {}
      const ai: AIProviderConfig = {
        ...defaultSettings.ai,
        ...rawAi,
        provider: ALL_PROVIDER_IDS.has(String(rawAi.provider ?? '')) ? (rawAi.provider as AIProviderConfig['provider']) : 'openai',
        model: typeof rawAi.model === 'string' ? rawAi.model : defaultSettings.ai.model,
        baseUrl: typeof rawAi.baseUrl === 'string' ? rawAi.baseUrl : defaultSettings.ai.baseUrl,
        apiKey: rawAi.apiKey !== undefined ? String(rawAi.apiKey) : defaultSettings.ai.apiKey,
        temperature: typeof rawAi.temperature === 'number' ? rawAi.temperature : defaultSettings.ai.temperature,
        maxTokens: typeof rawAi.maxTokens === 'number' ? rawAi.maxTokens : defaultSettings.ai.maxTokens,
      }
      const syncServerUrl = typeof saved.syncServerUrl === 'string' ? saved.syncServerUrl : defaultSettings.syncServerUrl
      const rawRag = saved.rag && typeof saved.rag === 'object' ? (saved.rag as unknown as Record<string, unknown>) : {}
      const rag: RAGSettings = {
        // 若未显式保存 useEmbeddings，则使用默认值（true）；只有明确写入 false 才关闭
        useEmbeddings: typeof rawRag.useEmbeddings === 'boolean' ? Boolean(rawRag.useEmbeddings) : defaultRAG.useEmbeddings,
        provider: rawRag.provider === 'api' ? 'api' : 'builtin',
        model: typeof rawRag.model === 'string' ? rawRag.model : defaultRAG.model,
        useGraphRAG: rawRag.useGraphRAG === false ? false : true,
        extractionModel: typeof rawRag.extractionModel === 'string' ? rawRag.extractionModel : '',
      }
      const debugMode = typeof saved.debugMode === 'boolean' ? saved.debugMode : false
      settings.value = { ai, rag, syncServerUrl, debugMode }
    }
  }

  async function save() {
    // apiKey 仅在用户修改时随 PUT 发送（原 UI 交互在 Task 8，Store 透传字段）。
    // 本地 AppSettings.ai 字段均为可选（provider 为联合类型），与 Bridge 契约的
    // 服务端 AppSettings（必填字段、provider: string）结构一致但类型窄，
    // 序列化形态相同，此处仅做类型收窄转换。
    await getBridge().setSettings(settings.value as unknown as BridgeAppSettings)
  }

  /** Task 7 新增：登录（Bridge 内部保存 token） */
  async function login(username: string, password: string): Promise<AuthResult> {
    const result = await getBridge().login({ username, password })
    isAuthenticated.value = true
    return result
  }

  /** Task 7 新增：注册（成功即登录） */
  async function register(username: string, password: string): Promise<AuthResult> {
    const result = await getBridge().register({ username, password })
    isAuthenticated.value = true
    return result
  }

  /** Task 7 新增：登出（Bridge 清 token 并关闭 WS；本地清空 settings 缓存） */
  async function logout(): Promise<void> {
    await getBridge().logout()
    isAuthenticated.value = false
    settings.value = cloneDefaultSettings()
  }

  /** Task 7 新增：会话校验（启动时恢复登录态） */
  async function me(): Promise<{ user: BridgeUser }> {
    const result = await getBridge().me()
    isAuthenticated.value = true
    return result
  }

  const aiConfig = computed(() => settings.value.ai)
  const debugMode = computed(() => settings.value.debugMode ?? false)

  return {
    settings,
    aiConfig,
    debugMode,
    isAuthenticated,
    load,
    save,
    login,
    register,
    logout,
    me,
  }
})
