<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '../../stores/settingsStore'
import { chat, isStreamResponse, consumeStream } from '../../services/ai'
import { getModelOptions } from '../../services/ai/modelListService'
import { useToast } from '../../composables/useToast'
import { onUnauthorized } from '../../platform/token'
import {
  PROTOCOL_DEFS,
  getProtocolDef,
  type LLMProtocol,
} from '../../services/ai/types'
import AppLayout from '../../components/layout/AppLayout.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import ConfirmModal from '../../components/ui/ConfirmModal.vue'

const isDev = import.meta.env.DEV
const toast = useToast()
const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)

/* ── 认证（Task 8 简报决策 7：新增登录/注册） ── */
const authMode = ref<'login' | 'register'>('login')
const authUsername = ref('')
const authPassword = ref('')
const authConfirm = ref('')
const authSubmitting = ref(false)

function resetAuthForm() {
  authUsername.value = ''
  authPassword.value = ''
  authConfirm.value = ''
  authSubmitting.value = false
}

async function doAuth() {
  const username = authUsername.value.trim()
  const password = authPassword.value
  if (username.length < 3 || username.length > 32) {
    toast.error('用户名需为 3-32 个字符')
    return
  }
  if (password.length < 6) {
    toast.error('密码至少 6 位')
    return
  }
  if (authMode.value === 'register' && password !== authConfirm.value) {
    toast.error('两次输入的密码不一致')
    return
  }
  authSubmitting.value = true
  try {
    if (authMode.value === 'register') {
      await settingsStore.register(username, password)
      toast.success('注册成功，已自动登录')
    } else {
      await settingsStore.login(username, password)
      toast.success('登录成功')
    }
    await loadSettingsSilently()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    authSubmitting.value = false
  }
}

/* ── AI 配置 ── */
const testStatus = ref<'idle' | 'loading' | 'ok' | 'error'>('idle')
const testError = ref('')
const modelList = ref<{ value: string; label: string }[]>([])
const modelListLoading = ref(false)
const modelListError = ref('')
const customModel = ref('')

const embeddingModelList = ref<{ value: string; label: string }[]>([])
const embeddingModelListLoading = ref(false)
const embeddingModelListError = ref('')
const embeddingCustomModel = ref('')

const embeddingTestStatus = ref<'idle' | 'loading' | 'ok' | 'error'>('idle')
const embeddingTestError = ref('')

const currentDef = computed(() => getProtocolDef(settings.value.ai.protocol))

const baseUrlPlaceholder = computed(() => currentDef.value?.defaultBaseUrl ?? '')
const apiKeyPlaceholder = computed(() => currentDef.value?.apiKeyPlaceholder ?? 'sk-...')

const displayModelList = computed(() => {
  const list = modelList.value
  const current = settings.value.ai.model
  if (current && !list.some((m) => m.value === current)) {
    return [...list, { value: current, label: `${current} (当前)` }]
  }
  return list
})

const displayEmbeddingModelList = computed(() => {
  const list = embeddingModelList.value
  const current = settings.value.rag?.model
  if (current && !list.some((m) => m.value === current)) {
    return [...list, { value: current, label: `${current} (当前)` }]
  }
  return list
})

/* picker 模型列表（首项为占位提示） */
const pickerModelList = computed(() => [{ value: '', label: '— 选择模型 —' }, ...displayModelList.value])
const modelIndex = computed(() => {
  const i = pickerModelList.value.findIndex((m) => m.value === settings.value.ai.model)
  return i >= 0 ? i : 0
})
const pickerEmbeddingModelList = computed(() => [{ value: '', label: '— 选择嵌入模型 —' }, ...displayEmbeddingModelList.value])
const embeddingModelIndex = computed(() => {
  const i = pickerEmbeddingModelList.value.findIndex((m) => m.value === settings.value.rag?.model)
  return i >= 0 ? i : 0
})

const sections = ref({
  ai: true,
  services: false,
})

async function loadModelList() {
  modelListLoading.value = true
  modelListError.value = ''
  try {
    const opts = await getModelOptions(settings.value.ai.protocol, {
      apiKey: settings.value.ai.apiKey,
      baseUrl: settings.value.ai.baseUrl,
    })
    modelList.value = opts
    const first = opts[0]
    if (first && !opts.some((m) => m.value === settings.value.ai.model)) {
      settings.value.ai.model = first.value
    }
  } catch (e) {
    modelListError.value = e instanceof Error ? e.message : '获取模型列表失败'
    modelList.value = []
  } finally {
    modelListLoading.value = false
  }
}

async function loadEmbeddingModelList() {
  if (settings.value.rag?.provider !== 'api') return
  embeddingModelListLoading.value = true
  embeddingModelListError.value = ''
  try {
    const opts = await getModelOptions(settings.value.ai.protocol, {
      apiKey: settings.value.ai.apiKey,
      baseUrl: settings.value.ai.baseUrl,
    }, 'embeddings')
    embeddingModelList.value = opts

    const current = settings.value.rag?.model
    if ((!current || !current.trim()) && opts[0]) {
      settings.value.rag.model = opts[0].value
    }
  } catch (e) {
    embeddingModelListError.value = e instanceof Error ? e.message : '获取嵌入模型列表失败'
    embeddingModelList.value = []
  } finally {
    embeddingModelListLoading.value = false
  }
}

function selectProtocol(id: LLMProtocol) {
  if (settings.value.ai.protocol === id) return
  settings.value.ai.protocol = id
  settings.value.ai.model = ''
  settings.value.ai.baseUrl = ''
  settings.value.ai.apiKey = ''
  loadModelList()
}

function applyCustomModel() {
  if (customModel.value.trim()) {
    settings.value.ai.model = customModel.value.trim()
    customModel.value = ''
  }
}

function applyCustomEmbeddingModel() {
  if (embeddingCustomModel.value.trim() && settings.value.rag) {
    settings.value.rag.model = embeddingCustomModel.value.trim()
    embeddingCustomModel.value = ''
  }
}

watch(
  () => settings.value.ai.protocol,
  () => {
    loadModelList()
    if (settings.value.rag?.provider === 'api') loadEmbeddingModelList()
  }
)

/* ── 401 处理：会话过期 → 显示登录表单 ── */
let offUnauthorized: (() => void) | null = null
onLoad(() => {
  offUnauthorized = onUnauthorized(() => {
    // Task 9（Task 8 Minor ①）：首次访问（未登录）401 → "请先登录"；
    // 已有登录态中途过期 → "登录已过期，请重新登录"
    toast.warning(settingsStore.isAuthenticated ? '登录已过期，请重新登录' : '请先登录')
    resetAuthForm()
  })
  // 已有登录态或本地有 token：恢复会话并加载设置
  if (settingsStore.isAuthenticated) {
    loadSettingsSilently()
  } else {
    settingsStore.me()
      .then(() => loadSettingsSilently())
      .catch(() => { /* 未登录：显示登录表单 */ })
  }
})

onUnload(() => {
  if (offUnauthorized) offUnauthorized()
})

async function loadSettingsSilently() {
  try {
    await settingsStore.load()
    loadModelList()
    if (settings.value.rag?.provider === 'api') loadEmbeddingModelList()
  } catch (e) {
    toast.error(`加载设置失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleSave() {
  await settingsStore.save()
  toast.success('设置已保存')
}

async function handleTest() {
  testStatus.value = 'loading'
  testError.value = ''
  try {
    const result = await chat(settings.value.ai, {
      messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
      stream: false,
    })
    const content = isStreamResponse(result) ? await consumeStream(result) : result.content
    testStatus.value = content?.trim() ? 'ok' : 'error'
    if (content?.trim()) {
      toast.success('连接成功')
    } else {
      testError.value = 'Empty response'
      toast.error('连接失败：空响应')
    }
  } catch (e) {
    testStatus.value = 'error'
    testError.value = e instanceof Error ? e.message : String(e)
    toast.error(`连接失败：${testError.value}`)
  }
}

async function handleTestEmbedding() {
  embeddingTestStatus.value = 'loading'
  embeddingTestError.value = ''
  try {
    const bridge = (await import('../../platform')).getBridge()
    const result = await bridge.ragTestEmbedding()
    if (!result?.ok) throw new Error(result?.error || 'Unknown error')
    embeddingTestStatus.value = 'ok'
    const len = typeof result.vectorLength === 'number' ? result.vectorLength : 0
    if (len > 0) toast.success(`嵌入连接正常（vector=${len}）`)
    else toast.success('嵌入连接正常')
  } catch (e) {
    embeddingTestStatus.value = 'error'
    embeddingTestError.value = e instanceof Error ? e.message : String(e)
    toast.error(`嵌入连接失败：${embeddingTestError.value}`)
  }
}

/** 登录/注册表单可见（认证状态由 settingsStore 维护） */
const authed = computed(() => settingsStore.isAuthenticated)

/** 退出登录确认（T2 ConfirmModal，危险操作分级）。 */
const logoutConfirm = ref(false)
const logoutBusy = ref(false)
async function confirmLogout() {
  logoutBusy.value = true
  try {
    await settingsStore.logout()
    resetAuthForm()
    toast.info('已退出登录')
    logoutConfirm.value = false
  } catch (e) {
    toast.error(`退出登录失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    logoutBusy.value = false
  }
}
</script>

<template>
  <app-layout active="settings" bg="/static/bg/bg_archives.webp" :overlay="0.8">
    <view class="page-root">
      <view class="page-head">
        <text class="page-title">设置</text>
        <text class="page-desc">AI 提供商、故事库与服务配置</text>
        <view class="head-divider ink-divider" />
      </view>

      <view class="page-body">
        <!-- ═══ 档案卡登录（T8 重排：未登录首屏即档案卡，无独立登录页） ═══ -->
        <view v-if="!authed" class="auth-wrap">
          <view class="auth-card">
            <view class="auth-seal">
              <app-icon name="scroll" :size="26" class="auth-seal-icon" />
            </view>
            <text class="auth-card-title">调查员档案</text>
            <text class="auth-card-sub">登录以同步配置与故事档案</text>

            <view class="auth-tabs">
              <view
                class="auth-tab"
                :class="authMode === 'login' ? 'auth-tab-on' : 'auth-tab-off'"
                @click="authMode = 'login'"
              >登录</view>
              <view
                class="auth-tab"
                :class="authMode === 'register' ? 'auth-tab-on' : 'auth-tab-off'"
                @click="authMode = 'register'"
              >注册</view>
            </view>
            <view class="auth-fields">
              <view class="auth-field">
                <app-icon name="users" :size="14" class="auth-field-icon" />
                <input
                  v-model="authUsername"
                  class="gothic-input auth-input"
                  placeholder="用户名（3-32 字符）"
                  placeholder-class="gothic-ph"
                  :maxlength="32"
                />
              </view>
              <view class="auth-field">
                <app-icon name="feather" :size="14" class="auth-field-icon" />
                <input
                  v-model="authPassword"
                  class="gothic-input auth-input"
                  placeholder="密码（至少 6 位）"
                  placeholder-class="gothic-ph"
                  password
                />
              </view>
              <view v-if="authMode === 'register'" class="auth-field">
                <app-icon name="feather" :size="14" class="auth-field-icon" />
                <input
                  v-model="authConfirm"
                  class="gothic-input auth-input"
                  placeholder="确认密码"
                  placeholder-class="gothic-ph"
                  password
                />
              </view>
              <button
                class="gothic-btn auth-submit"
                :class="{ 'is-disabled': authSubmitting }"
                @click="doAuth"
              >
                {{ authSubmitting ? '处理中...' : (authMode === 'login' ? '登录' : '注册并登录') }}
              </button>
              <text class="auth-note">
                {{ authMode === 'register' ? '注册成功后将自动登录；配置与故事数据按账号隔离。' : '登录后即可同步配置与故事（API Key 仅保存在服务端）。' }}
              </text>
            </view>
          </view>
        </view>

        <template v-else>
          <!-- ═══ AI 提供商（ADR-0003 协议卡形态保留） ═══ -->
          <view class="gothic-card section-card">
            <view class="section-toggle" @click="sections.ai = !sections.ai">
              <view class="section-title-row">
                <app-icon name="gear" :size="15" class="section-title-icon" />
                <text class="section-title">AI 提供商</text>
              </view>
              <text class="section-arrow">{{ sections.ai ? '▾' : '▸' }}</text>
            </view>
            <view v-if="sections.ai" class="section-content">
              <!-- 协议选择（ADR-0003：协议一等公民） -->
              <view>
                <text class="field-label">接入协议</text>
                <view class="provider-grid two">
                  <view
                    v-for="def in PROTOCOL_DEFS"
                    :key="def.id"
                    class="provider-card"
                    :class="settings.ai.protocol === def.id ? 'provider-active' : 'provider-dim'"
                    @click="selectProtocol(def.id)"
                  >
                    <text class="provider-name" :class="settings.ai.protocol === def.id ? 'provider-name-on' : 'provider-name-off'">
                      {{ def.label }}
                    </text>
                    <text class="provider-desc" :class="settings.ai.protocol === def.id ? 'provider-desc-on' : 'provider-desc-off'">
                      {{ def.description }}
                    </text>
                  </view>
                </view>
                <text class="field-note">选择 API 协议后，可自定义 Base URL（如中转站）与 API Key</text>
              </view>

              <view class="ink-divider" />

              <!-- Base URL -->
              <view>
                <text class="field-label">Base URL</text>
                <input
                  v-model="settings.ai.baseUrl"
                  class="gothic-input"
                  :placeholder="baseUrlPlaceholder || '请输入 API 地址'"
                  placeholder-class="gothic-ph"
                />
                <text v-if="baseUrlPlaceholder" class="field-note">
                  留空则使用默认值：{{ baseUrlPlaceholder }}
                </text>
              </view>

              <!-- API Key（仅保存在服务端） -->
              <view>
                <text class="field-label">API Key</text>
                <input
                  v-model="settings.ai.apiKey"
                  class="gothic-input"
                  :placeholder="apiKeyPlaceholder"
                  placeholder-class="gothic-ph"
                  password
                />
                <text class="field-note">API Key 仅保存在服务端（AES-256 加密存储），不会回传到客户端</text>
              </view>

              <!-- 模型 -->
              <view>
                <view class="model-head">
                  <text class="field-label">模型</text>
                  <text class="link-btn" @click="loadModelList">刷新列表</text>
                </view>

                <picker
                  v-if="pickerModelList.length > 1"
                  :range="pickerModelList"
                  range-key="label"
                  :value="modelIndex"
                  @change="settings.ai.model = pickerModelList[Number($event.detail.value)].value"
                >
                  <view class="picker-value">{{ settings.ai.model || '— 选择模型 —' }}</view>
                </picker>

                <view class="custom-row">
                  <input
                    v-model="customModel"
                    class="gothic-input custom-input"
                    placeholder="或手动输入模型名称"
                    placeholder-class="gothic-ph"
                    @confirm="applyCustomModel"
                  />
                  <button
                    class="gothic-btn-secondary apply-btn"
                    :class="{ 'is-disabled': !customModel.trim() }"
                    @click="applyCustomModel"
                  >应用</button>
                </view>

                <text v-if="settings.ai.model" class="current-model">当前模型：{{ settings.ai.model }}</text>
                <text v-if="modelListLoading" class="field-note">加载模型中...</text>
                <text v-if="modelListError" class="field-warn">{{ modelListError }}</text>
              </view>

              <!-- 高级参数（Task 9：恢复原 step/min/max —— Task 8 Minor ⑥） -->
              <view class="param-grid">
                <view>
                  <text class="field-label">Temperature</text>
                  <input v-model.number="settings.ai.temperature" type="number" step="0.1" min="0" max="2" class="gothic-input" />
                </view>
                <view>
                  <text class="field-label">Max Tokens</text>
                  <input v-model.number="settings.ai.maxTokens" type="number" step="256" min="256" max="32768" class="gothic-input" />
                </view>
              </view>

              <!-- 操作 -->
              <view class="actions-row">
                <button class="gothic-btn" hover-class="gothic-btn-press" @click="handleSave">保存设置</button>
                <button
                  class="gothic-btn-secondary"
                  :class="{ 'is-disabled': testStatus === 'loading' }"
                  @click="handleTest"
                >
                  {{ testStatus === 'loading' ? '测试中...' : '测试连接' }}
                </button>
                <text v-if="testStatus === 'ok'" class="ok-text">✓ 连接正常</text>
                <text v-if="testStatus === 'error'" class="err-text">✕ {{ testError }}</text>
              </view>
            </view>
          </view>

          <!-- ═══ 服务配置 ═══ -->
          <view class="gothic-card section-card">
            <view class="section-toggle" @click="sections.services = !sections.services">
              <view class="section-title-row">
                <app-icon name="sparkle" :size="15" class="section-title-icon" />
                <text class="section-title">服务配置</text>
              </view>
              <text class="section-arrow">{{ sections.services ? '▾' : '▸' }}</text>
            </view>
            <view v-if="sections.services" class="section-content">
              <view class="rag-notice">
                <text class="rag-notice-icon">✓</text>
                <text class="rag-notice-text">RAG 向量检索已内置于服务端，无需单独启动服务</text>
              </view>
              <view v-if="settings.rag" class="rag-options">
                <text class="field-note">
                  RAG 向量检索始终使用嵌入向量（内置模型或你的嵌入 API），不再使用 TF-IDF。
                </text>

                <view class="radio-row" @click="settings.rag.provider = 'builtin'">
                  <view class="radio" :class="{ 'radio-on': settings.rag.provider === 'builtin' }">
                    <view v-if="settings.rag.provider === 'builtin'" class="radio-dot" />
                  </view>
                  <text class="radio-label">内置中文嵌入模型（无需 API，首次使用会下载）</text>
                </view>
                <view class="radio-row" @click="settings.rag.provider = 'api'">
                  <view class="radio" :class="{ 'radio-on': settings.rag.provider === 'api' }">
                    <view v-if="settings.rag.provider === 'api'" class="radio-dot" />
                  </view>
                  <text class="radio-label">使用我的嵌入 API（上方 AI 的 Base URL 与 API Key）</text>
                </view>

                <view v-if="settings.rag.provider === 'api'">
                  <view class="model-head">
                    <text class="field-label">嵌入模型名</text>
                    <text class="link-btn" @click="loadEmbeddingModelList">刷新</text>
                  </view>
                  <view class="actions-row">
                    <button
                      class="gothic-btn-secondary embed-test-btn"
                      :class="{ 'is-disabled': embeddingTestStatus === 'loading' }"
                      @click="handleTestEmbedding"
                    >
                      {{ embeddingTestStatus === 'loading' ? '测试中...' : '测试嵌入连接' }}
                    </button>
                    <text v-if="embeddingTestStatus === 'ok'" class="ok-text">✓ 嵌入正常</text>
                    <text v-if="embeddingTestStatus === 'error'" class="err-text">✕ {{ embeddingTestError }}</text>
                  </view>

                  <text v-if="embeddingModelListLoading && displayEmbeddingModelList.length === 0" class="field-note">加载中...</text>
                  <view v-else class="space-y">
                    <picker
                      v-if="pickerEmbeddingModelList.length > 1"
                      :range="pickerEmbeddingModelList"
                      range-key="label"
                      :value="embeddingModelIndex"
                      @change="settings.rag.model = pickerEmbeddingModelList[Number($event.detail.value)].value"
                    >
                      <view class="picker-value">{{ settings.rag.model || '— 选择嵌入模型 —' }}</view>
                    </picker>
                    <view class="custom-row">
                      <input
                        v-model="embeddingCustomModel"
                        class="gothic-input custom-input"
                        placeholder="或手动输入模型名"
                        placeholder-class="gothic-ph"
                        @confirm="applyCustomEmbeddingModel"
                      />
                      <button
                        class="gothic-btn-secondary apply-btn"
                        :class="{ 'is-disabled': !embeddingCustomModel.trim() }"
                        @click="applyCustomEmbeddingModel"
                      >应用</button>
                    </view>
                    <text v-if="embeddingModelListError" class="field-warn">{{ embeddingModelListError }}</text>
                  </view>
                </view>
              </view>

              <view>
                <text class="field-label">同步服务 URL</text>
                <input
                  v-model="settings.syncServerUrl"
                  class="gothic-input"
                  placeholder="http://localhost:3000"
                  placeholder-class="gothic-ph"
                />
              </view>
              <button class="gothic-btn" hover-class="gothic-btn-press" @click="handleSave">保存</button>
            </view>
          </view>

          <!-- ═══ 开发调试（dev only） ═══ -->
          <view v-if="isDev" class="gothic-card section-card">
            <view class="section-toggle static-toggle">
              <view class="section-title-row">
                <app-icon name="search" :size="15" class="section-title-icon" />
                <text class="section-title">开发调试</text>
              </view>
              <text class="dev-badge">DEV ONLY</text>
            </view>
            <view class="section-content">
              <view class="toggle-row" @click="settings.debugMode = !settings.debugMode">
                <view class="checkbox" :class="{ 'checkbox-on': settings.debugMode }">
                  <text v-if="settings.debugMode" class="check-mark">✓</text>
                </view>
                <view>
                  <text class="toggle-label">启用 KPTrace 追踪</text>
                  <text class="field-note">记录 Agent 循环、RAG 检索、工具执行等全链路事件</text>
                </view>
              </view>
              <view class="kbd-hint">快捷键：在游戏房间按 Ctrl+Shift+D 打开/关闭 Debug Panel（H5）</view>
              <!-- #ifdef H5 -->
              <view class="kbd-hint">RAG Inspector：H5 端访问 /#/pages/rag-inspector/index（检查 RAG 索引与 GraphRAG 结果；小程序不包含此页）</view>
              <!-- #endif -->
              <!-- #ifndef H5 -->
              <view class="kbd-hint">图谱检查工具仅 H5 端可用（小程序不包含此页）</view>
              <!-- #endif -->
              <button class="gothic-btn" hover-class="gothic-btn-press" @click="handleSave">保存</button>
            </view>
          </view>

          <!-- 退出登录（危险操作分级：outline-danger + Modal 确认） -->
          <view class="logout-row">
            <button class="btn-outline-danger logout-btn" @click="logoutConfirm = true">退出登录</button>
          </view>
        </template>

        <confirm-modal
          v-if="logoutConfirm"
          title="退出登录"
          message="确定要退出当前调查员账号吗？本地未同步的配置可能丢失。"
          confirm-text="退出登录"
          :loading="logoutBusy"
          @cancel="logoutConfirm = false"
          @confirm="confirmLogout"
        />
      </view>
    </view>
  </app-layout>
</template>

<style scoped lang="scss">
.page-root {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  width: 100%;
}
.page-head {
  padding: 32px 24px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.page-title {
  display: block;
  font-family: $font-display;
  font-size: 1.5rem;
  font-weight: bold;
  color: var(--c-paper-50);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
}
.page-desc {
  display: block;
  margin-top: 4px;
  font-size: 0.875rem;
  color: var(--c-fog);
}
.head-divider {
  margin-top: 12px;
  max-width: 80px;
}

.page-body {
  flex: 1;
  padding: 0 24px 48px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── 档案卡登录（T8） ── */
.auth-wrap {
  display: flex;
  justify-content: center;
  padding: 8px 0 24px;
}
.auth-card {
  width: 100%;
  max-width: 420px;
  padding: 28px 32px 24px;
  background: var(--c-card);
  border: 1px solid var(--c-outline);
  border-radius: 14px;
  border-top: 3px solid var(--c-eld-500);
  box-shadow: 0 10px 34px var(--shadow-ink), inset 0 0 60px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
}
.auth-seal {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: 1px solid var(--c-eld-700);
  background: radial-gradient(circle, var(--c-eld-900), transparent 70%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 18px var(--c-eld-900);
  margin-bottom: 12px;
}
.auth-seal-icon {
  color: var(--c-eld-300);
}
.auth-card-title {
  font-family: $font-display;
  font-size: 1.1rem;
  font-weight: bold;
  letter-spacing: 0.12em;
  color: var(--c-paper-100);
  text-shadow: 0 0 12px rgba(0, 0, 0, 0.6);
}
.auth-card-sub {
  margin-top: 4px;
  margin-bottom: 20px;
  font-size: 12px;
  color: var(--c-text-secondary);
}
.auth-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  width: 100%;
  justify-content: center;
}
.auth-tab {
  padding: 6px 20px;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
}
.auth-tab-on {
  background: var(--c-primary-bg);
  border: 1px solid var(--c-primary-deep);
  color: var(--c-eld-200);
}
.auth-tab-off {
  background: var(--c-slate);
  border: 1px solid var(--c-outline);
  color: var(--c-text-disabled);
}
.auth-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}
.auth-field {
  position: relative;
  width: 100%;
}
.auth-field-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--c-text-disabled);
  pointer-events: none;
}
.auth-input {
  max-width: 100%;
  padding-left: 36px;
  box-sizing: border-box;
  width: 100%;
}
.auth-submit {
  align-self: center;
  min-width: 180px;
  margin-top: 6px;
}
.auth-note {
  font-size: 12px;
  color: var(--c-text-secondary);
  line-height: 1.6;
  text-align: center;
}

/* ── 分区卡片 ── */
.section-card {
  background: rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.section-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  transition: background 0.2s;
}
.section-toggle:active {
  background: var(--c-hover);
}
.section-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-title-icon {
  color: var(--c-eld-400);
}
.static-toggle {
  cursor: default;
}
.section-title {
  font-family: $font-display;
  font-size: 0.875rem;
  font-weight: bold;
  color: var(--c-paper-100);
  letter-spacing: 0.05em;
}
.section-arrow {
  font-size: 12px;
  color: var(--c-fog);
}
.section-content {
  padding: 16px 20px 20px;
  border-top: 1px solid color-mix(in srgb, var(--c-slate) 50%, transparent);
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--c-ash);
}
.field-note {
  display: block;
  font-size: 11px;
  margin-top: 4px;
  color: var(--c-slate-light);
  line-height: 1.6;
}
.field-warn {
  display: block;
  font-size: 11px;
  margin-top: 4px;
  color: var(--c-ritual-300);
}

.provider-grid {
  display: grid;
  gap: 8px;
}
.provider-grid.two { grid-template-columns: repeat(2, 1fr); }
.provider-card {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  transition: all 0.2s;
}
.provider-active {
  background: color-mix(in srgb, var(--c-eld-700) 20%, transparent);
  border-color: color-mix(in srgb, var(--c-eld-600) 50%, transparent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--c-eld-500) 10%, transparent);
}
.provider-dim {
  background: color-mix(in srgb, var(--c-obsidian) 40%, transparent);
  border-color: color-mix(in srgb, var(--c-slate) 40%, transparent);
}
.provider-dim:active {
  border-color: color-mix(in srgb, var(--c-slate-light) 60%, transparent);
  background: color-mix(in srgb, var(--c-obsidian-light) 50%, transparent);
}
.provider-name {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
}
.provider-name-on {
  color: var(--c-eld-200);
}
.provider-name-off {
  color: var(--c-paper-400);
}
.provider-desc {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.4;
}
.provider-desc-on {
  color: var(--c-eld-400);
}
.provider-desc-off {
  color: var(--c-text-disabled);
}

.model-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.link-btn {
  font-size: 10px;
  color: var(--c-eld-300);
  padding: 2px 4px;
}
.link-btn:active {
  opacity: 0.6;
}
.picker-value {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
  background: color-mix(in srgb, var(--c-abyss) 85%, transparent);
  color: var(--c-paper-300);
  border: 1px solid var(--c-slate);
}
.custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.custom-input {
  flex: 1;
}
.apply-btn {
  font-size: 12px;
  padding: 6px 12px;
}
.current-model {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--c-paper-600);
}

.param-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 8px;
}
/* 保存主 CTA 按压态（Task 9 / Task 8 Minor ③：MP 端 :active 不生效 → hover-class） */
.gothic-btn-press {
  background: color-mix(in srgb, var(--c-eld-600) 85%, transparent);
  border-color: var(--c-eld-500);
}
.ok-text {
  font-size: 12px;
  color: var(--c-eld-200);
}
.err-text {
  font-size: 12px;
  color: var(--c-blood-200);
}

/* ── RAG ── */
.rag-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--c-eld-900) 30%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 20%, transparent);
}
.rag-notice-icon {
  font-size: 12px;
  color: var(--c-eld-300);
}
.rag-notice-text {
  font-size: 12px;
  color: var(--c-eld-200);
}
.rag-options {
  border-left: 2px solid color-mix(in srgb, var(--c-slate) 50%, transparent);
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.radio-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--c-slate);
  background: var(--c-obsidian);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.radio-on {
  border-color: var(--c-eld-500);
}
.radio-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-eld-500);
}
.radio-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--c-ash);
}
.embed-test-btn {
  font-size: 12px;
}
.space-y {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── 调试开关 ── */
.toggle-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.checkbox {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--c-slate);
  background: var(--c-obsidian);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.checkbox-on {
  border-color: var(--c-ritual-300);
}
.check-mark {
  font-size: 10px;
  color: var(--c-ritual-300);
}
.toggle-label {
  display: block;
  font-size: 0.875rem;
  color: var(--c-paper-400);
}
.dev-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--c-ritual-800) 40%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-ritual-500) 30%, transparent);
  color: var(--c-ritual-300);
}
.kbd-hint {
  font-size: 12px;
  color: var(--c-ash);
}

.logout-row {
  display: flex;
  justify-content: center;
  padding: 8px 0 16px;
}
.logout-btn {
  font-size: 0.875rem;
  padding: 10px 28px;
}
</style>
