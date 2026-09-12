import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AIProviderConfig, LLMProtocol } from '../services/ai/types'
import { PROTOCOL_DEFS } from '../services/ai/types'
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
  /** 检索补充层总开关（ADR-0007；默认开）。**必须逐字段透传**：load() 重建 rag
   *  对象时漏掉它，每次保存都会把用户关掉的开关静默改回默认开。 */
  supplement?: boolean
}

export interface AppSettings {
  ai: AIProviderConfig
  rag?: RAGSettings
}

const ALL_PROTOCOLS = new Set<string>(PROTOCOL_DEFS.map((p) => p.id))

const defaultRAG: RAGSettings = {
  // 默认启用语义检索（嵌入向量）——本地 builtin 嵌入；M1-T7 起无图
  useEmbeddings: true,
  provider: 'builtin',
  model: 'text-embedding-3-small',
  supplement: true,
}

const defaultSettings: AppSettings = {
  ai: {
    protocol: 'openai_chat',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    maxTokens: 2048,
  },
  rag: defaultRAG,
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
        protocol: ALL_PROTOCOLS.has(String(rawAi.protocol ?? ''))
          ? (rawAi.protocol as LLMProtocol)
          : (defaultSettings.ai.protocol as LLMProtocol),
        model: typeof rawAi.model === 'string' ? rawAi.model : defaultSettings.ai.model,
        baseUrl: typeof rawAi.baseUrl === 'string' ? rawAi.baseUrl : defaultSettings.ai.baseUrl,
        apiKey: rawAi.apiKey !== undefined ? String(rawAi.apiKey) : defaultSettings.ai.apiKey,
        temperature: typeof rawAi.temperature === 'number' ? rawAi.temperature : defaultSettings.ai.temperature,
        maxTokens: typeof rawAi.maxTokens === 'number' ? rawAi.maxTokens : defaultSettings.ai.maxTokens,
      }
      const rawRag = saved.rag && typeof saved.rag === 'object' ? (saved.rag as unknown as Record<string, unknown>) : {}
      const rag: RAGSettings = {
        // 若未显式保存 useEmbeddings，则使用默认值（true）；只有明确写入 false 才关闭
        useEmbeddings: typeof rawRag.useEmbeddings === 'boolean' ? Boolean(rawRag.useEmbeddings) : defaultRAG.useEmbeddings,
        provider: rawRag.provider === 'api' ? 'api' : 'builtin',
        model: typeof rawRag.model === 'string' ? rawRag.model : defaultRAG.model,
        // 漏掉这行 = 每次 save() 把用户的关闭状态改回默认开（服务端 mergeDefaults 回填 true）
        supplement: rawRag.supplement === false ? false : true,
      }
      settings.value = { ai, rag }
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

  return {
    settings,
    aiConfig,
    isAuthenticated,
    load,
    save,
    login,
    register,
    logout,
    me,
  }
})
