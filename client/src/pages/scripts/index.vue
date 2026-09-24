<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useStoryStore } from '../../stores/storyStore'
import { listIndexedStories, deleteStoryIndex } from '../../services/ragService'
import { generateStoryDossier, listStoryDossiers, type StoryDossierSummary } from '../../services/dossierService'
import { createStoryOperationId } from '../../services/operationId'
import { isRetryableBridgeError } from '../../services/retry'
import { useToast } from '../../composables/useToast'
import { getBridge } from '../../platform'
import { onUnauthorized } from '../../platform/token'
import type { StoryOperationProgress } from '../../../../shared/types/bridge'
import AppLayout from '../../components/layout/AppLayout.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import ConfirmModal from '../../components/ui/ConfirmModal.vue'
import EmptyState from '../../components/ui/EmptyState.vue'

const toast = useToast()
const storyStore = useStoryStore()
const { storyFiles, isLoading: storiesLoading } = storeToRefs(storyStore)

const indexedStories = ref<IndexedStory[]>([])
const storyDossiers = ref<StoryDossierSummary[]>([])
const dossierListLoading = ref(false)
const dossierListError = ref(false)
const indexStatus = ref<Record<string, 'idle' | 'loading' | 'ok' | 'warning' | 'error'>>({})
const dossierStatus = ref<Record<string, 'idle' | 'loading' | 'ok' | 'warning' | 'error'>>({})
const operationProgress = ref<Record<string, StoryOperationProgress>>({})
const indexAllLoading = ref(false)
const indexAllProgress = ref({ completed: 0, total: 0, percent: 0, currentStory: '' })
const activeOperations = new Map<string, { operation: 'index' | 'dossier'; scriptId: string; key: string }>()
const latestOperationIds: Record<string, string> = {}
let offStoryProgress: (() => void) | null = null

function progressKey(operation: 'index' | 'dossier', scriptId: string): string {
  return `${operation}:${scriptId}`
}

function beginOperation(operation: 'index' | 'dossier', scriptId: string): string {
  const key = progressKey(operation, scriptId)
  const operationId = createStoryOperationId(operation)
  latestOperationIds[key] = operationId
  activeOperations.set(operationId, { operation, scriptId, key })
  operationProgress.value = {
    ...operationProgress.value,
    [key]: {
      operation,
      operationId,
      scriptId,
      stage: 'starting',
      percent: 0,
      state: 'running',
      message: '正在连接进度通道...',
    },
  }
  void getBridge().connectWs().catch(() => {
    // Operation requests still work over HTTP; the progress display resumes if WS reconnects.
  })
  return operationId
}

function receiveOperationProgress(progress: StoryOperationProgress) {
  const received = activeOperations.get(progress.operationId)
  if (!received || received.operation !== progress.operation || received.scriptId !== progress.scriptId) return
  let active = received
  let displayOperationId = progress.operationId
  if (latestOperationIds[received.key] !== progress.operationId) {
    const latestId = latestOperationIds[received.key]
    const latest = latestId ? activeOperations.get(latestId) : undefined
    // A manual retry can join work that is still running after its HTTP response
    // was lost. Reuse those live percentages for the new attempt, but ignore an
    // old terminal frame so it cannot complete a genuinely fresh retry.
    if (!latest || progress.state !== 'running') {
      activeOperations.delete(progress.operationId)
      return
    }
    active = latest
    displayOperationId = latestId!
  }
  const previous = operationProgress.value[active.key]
  operationProgress.value = {
    ...operationProgress.value,
    [active.key]: {
      ...previous,
      ...progress,
      operationId: displayOperationId,
      percent: Math.max(previous?.percent ?? 0, progress.percent ?? 0),
    },
  }
  if (progress.state === 'complete') {
    delete latestOperationIds[active.key]
    if (progress.operation === 'index') {
      indexStatus.value[progress.scriptId] = progress.warning ? 'warning' : 'ok'
      void refreshIndexed()
    } else {
      dossierStatus.value[progress.scriptId] = progress.warning ? 'warning' : 'ok'
      void refreshDossiers()
    }
    activeOperations.delete(progress.operationId)
  } else if (progress.state === 'failed') {
    delete latestOperationIds[active.key]
    if (progress.operation === 'index') indexStatus.value[progress.scriptId] = 'error'
    else dossierStatus.value[progress.scriptId] = 'error'
    activeOperations.delete(progress.operationId)
  }
}

function settleOperation(
  operation: 'index' | 'dossier',
  scriptId: string,
  operationId: string,
  state: 'complete' | 'failed' | 'running',
  message: string,
  warning?: string,
) {
  const key = progressKey(operation, scriptId)
  if (latestOperationIds[key] !== operationId) {
    activeOperations.delete(operationId)
    return
  }
  const previous = operationProgress.value[key]
  operationProgress.value = {
    ...operationProgress.value,
    [key]: {
      operation,
      operationId,
      scriptId,
      stage: state,
      percent: state === 'complete' ? 100 : previous?.percent ?? 0,
      state,
      message,
      ...(warning ? { warning } : {}),
    },
  }
  if (state !== 'running') activeOperations.delete(operationId)
  if (state === 'complete' || state === 'failed') {
    if (latestOperationIds[key] === operationId) delete latestOperationIds[key]
  }
}

async function refreshIndexed() {
  try { indexedStories.value = await listIndexedStories() } catch { indexedStories.value = [] }
}

async function refreshDossiers() {
  dossierListLoading.value = true
  dossierListError.value = false
  try {
    storyDossiers.value = await listStoryDossiers()
  } catch {
    dossierListError.value = true
  } finally {
    dossierListLoading.value = false
  }
}

onMounted(() => {
  offStoryProgress = getBridge().onStoryProgress(receiveOperationProgress)
  storyStore.loadStories()
  refreshIndexed()
  refreshDossiers()
  // 401（登录过期）时提示重新登录
  offUnauthorized = onUnauthorized(() => {
    toast.warning('登录已过期，请到设置页重新登录')
  })
})

onUnmounted(() => {
  if (offUnauthorized) offUnauthorized()
  if (offStoryProgress) offStoryProgress()
  activeOperations.clear()
})

let offUnauthorized: (() => void) | null = null

/**
 * 文件选择（Task 8，简报决策 5）：原 Electron 文件对话框 → 平台条件编译：
 *   - MP-WEIXIN：uni.chooseMessageFile（聊天文件选择器）
 *   - H5 / App：uni.chooseFile
 * 选中后经 bridge.importStory(filePath) 上传（Bridge 已封装 uni.uploadFile；
 * 无上传进度回调 —— Task 7 已审查代码，缺进度仅报告）。
 */
function handleImport() {
  // #ifdef MP-WEIXIN
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    extension: ['pdf', 'txt', 'md', 'markdown', 'docx', 'epub'],
    success: (res) => {
      const f = res.tempFiles && res.tempFiles[0]
      if (!f) return
      doImport(f.path)
    },
    fail: () => { /* 用户取消 */ },
  })
  // #endif
  // #ifndef MP-WEIXIN
  uni.chooseFile({
    count: 1,
    extension: ['pdf', 'txt', 'md', 'markdown', 'docx', 'epub'],
    success: (res) => {
      const f = res.tempFiles && res.tempFiles[0]
      if (!f) return
      doImport(f.path)
    },
    fail: () => { /* 用户取消 */ },
  })
  // #endif
}

async function doImport(filePath: string) {
  toast.info('上传并解析中...')
  const result = await storyStore.importStory(filePath)
  if (result?.ok) toast.success('故事文件导入成功')
  else if (result?.error && result.error !== 'cancelled' && result.error !== 'no file selected') toast.error('导入失败: ' + result.error)
}

async function runIndexStory(id: string): Promise<{ ok: boolean; indexed?: number; error?: string; warning?: string; networkError?: boolean }> {
  if (indexStatus.value[id] === 'loading') return { ok: false, error: '该故事正在索引' }
  const operationId = beginOperation('index', id)
  indexStatus.value[id] = 'loading'
  try {
    const result = await storyStore.indexStoryForRag(id, operationId)
    if (result.ok) {
      indexStatus.value[id] = result.warning ? 'warning' : 'ok'
      settleOperation('index', id, operationId, 'complete', result.warning || '索引完成', result.warning)
      await refreshIndexed()
    } else if (result.networkError) {
      indexStatus.value[id] = 'error'
      settleOperation('index', id, operationId, 'running', '连接中断；自动重试次数已用完，可重新索引')
    } else {
      indexStatus.value[id] = 'error'
      settleOperation('index', id, operationId, 'failed', result.error || '索引失败')
    }
    return result
  } catch (e) {
    const retryable = isRetryableBridgeError(e)
    indexStatus.value[id] = 'error'
    if (retryable) {
      settleOperation('index', id, operationId, 'running', '连接中断；自动重试次数已用完，可重新索引')
    } else {
      settleOperation('index', id, operationId, 'failed', e instanceof Error ? e.message : String(e))
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), networkError: retryable }
  }
}

async function handleIndexStory(id: string) {
  const result = await runIndexStory(id)
  if (result.ok && result.warning) toast.warning(`索引已保存，但仍有嵌入失败：${result.warning}`)
  else if (result.ok) toast.success(`索引成功！共 ${result.indexed || 0} 个信息块`)
  else if (result.networkError) toast.error(`连接失败：${result.error || '网络请求失败'}；已自动重试，请稍后点击重试`)
  else toast.error(`索引失败：${result.error || '未知错误'}${indexStatus.value[id] === 'error' ? '；可再次点击重试' : ''}`)
}

async function handleIndexAll() {
  if (indexAllLoading.value) return
  indexAllLoading.value = true
  try {
    await storyStore.loadStories()
    const stories = [...storyFiles.value]
    indexAllProgress.value = { completed: 0, total: stories.length, percent: 0, currentStory: '' }
    let totalChunks = 0
    const errors: string[] = []
    const warnings: string[] = []
    for (const story of stories) {
      indexAllProgress.value.currentStory = story.name
      const result = await runIndexStory(story.id)
      if (result.ok) {
        totalChunks += result.indexed || 0
        if (result.warning) warnings.push(`${story.name}: ${result.warning}`)
      } else {
        errors.push(`${story.name}: ${result.error || '未知错误'}`)
      }
      const completed = indexAllProgress.value.completed + 1
      indexAllProgress.value = {
        ...indexAllProgress.value,
        completed,
        percent: stories.length ? Math.round((completed / stories.length) * 100) : 100,
      }
    }
    await refreshIndexed()
    if (errors.length) toast.warning(`批量索引结束：${totalChunks} 个信息块，${errors.length} 个失败${warnings.length ? `，${warnings.length} 个部分索引` : ''}`)
    else if (warnings.length) toast.warning(`批量索引完成：${totalChunks} 个信息块，${warnings.length} 个故事有向量缺失，可单独重试`)
    else toast.success(`索引完成！共 ${totalChunks} 个信息块`)
  } finally {
    indexAllLoading.value = false
  }
}

async function handleGenerateDossier(scriptId: string, storyName: string) {
  if (dossierStatus.value[scriptId] === 'loading') return
  const operationId = beginOperation('dossier', scriptId)
  dossierStatus.value[scriptId] = 'loading'
  toast.info(`正在为「${storyName}」生成守秘人档案，长篇故事可能需要几分钟...`)
  try {
    const result = await generateStoryDossier(scriptId, operationId)
    if (!result.ok) {
      dossierStatus.value[scriptId] = 'error'
      settleOperation('dossier', scriptId, operationId, 'failed', result.error || '档案生成失败')
      toast.error(`档案生成失败：${result.error || '未知错误'}`)
      return
    }

    dossierStatus.value[scriptId] = result.degraded || result.warnings?.length ? 'warning' : 'ok'
    settleOperation('dossier', scriptId, operationId, 'complete', result.warnings?.[0] || '档案生成完成', result.degraded ? result.warnings?.[0] : undefined)
    await refreshDossiers()
    if (result.degraded) {
      const coverage = typeof result.coveragePct === 'number' ? `（覆盖率 ${result.coveragePct}%）` : ''
      toast.warning(`档案已生成但质量不足${coverage}，单人开局可能仍被拦截。请查看生成告警或重试。`)
    } else if (result.warnings?.length) {
      toast.warning(`档案已生成：${result.warnings[0]}`)
    } else {
      toast.success(`守秘人档案生成完成（${result.scenes ?? 0} 个场景），返回单人创建页重试开局`)
    }
  } catch (e) {
    const retryable = isRetryableBridgeError(e)
    dossierStatus.value[scriptId] = 'error'
    settleOperation(
      'dossier',
      scriptId,
      operationId,
      retryable ? 'running' : 'failed',
      retryable ? '连接中断；自动重试次数已用完，可重新生成' : e instanceof Error ? e.message : String(e),
    )
    toast.error(`档案生成失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function dossierForStory(storyId: string): StoryDossierSummary | undefined {
  return storyDossiers.value.find((dossier) => dossier.scriptId === storyId)
}

function operationProgressFor(operation: 'index' | 'dossier', scriptId: string): StoryOperationProgress | undefined {
  return operationProgress.value[progressKey(operation, scriptId)]
}

function progressWidth(operation: 'index' | 'dossier', scriptId: string): string {
  return `${Math.max(0, Math.min(100, operationProgressFor(operation, scriptId)?.percent ?? 0))}%`
}

/** 删除确认（ADR-0004 UX 缺口：删除文件/索引不可恢复，需 Modal 确认） */
type PendingDelete = { kind: 'file' | 'index'; id: string; name: string } | null
const pendingDelete = ref<PendingDelete>(null)
const deleting = ref(false)

function askDeleteStory(id: string, name: string) {
  pendingDelete.value = { kind: 'file', id, name }
}

function askDeleteIndex(id: string, name: string) {
  pendingDelete.value = { kind: 'index', id, name }
}

async function confirmDeleteStory() {
  if (!pendingDelete.value || deleting.value) return
  const pd = pendingDelete.value
  deleting.value = true
  try {
    if (pd.kind === 'file') {
      await storyStore.deleteStory(pd.id)
      toast.info(`已删除文件「${pd.name}」`)
    } else {
      await deleteStoryIndex(pd.id)
      toast.info(`已删除索引「${pd.name}」`)
    }
    await refreshIndexed()
  } catch (e) {
    toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    deleting.value = false
    pendingDelete.value = null
  }
}

/** 索引状态判断：服务端 storyId 即文件 id（含扩展名，Task 7 语义） */
function isIndexed(id: string): boolean {
  return indexedStories.value.some((s) => s.storyId === id)
}

/** 小程序端 toLocaleDateString(locale, options) 支持不全 → 手写格式化 */
function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <app-layout active="scripts" bg="/static/bg/bg_archives.webp" :overlay="0.7">
    <view class="page-root">
      <!-- 页头 -->
      <view class="page-head">
        <view class="head-left">
          <text class="page-title">故事管理</text>
          <text class="page-desc">导入并索引故事；单人开局前还需生成守秘人档案</text>
        </view>
        <view class="head-actions">
          <button class="gothic-btn import-btn" @click="handleImport">导入故事</button>
        </view>
        <view class="head-divider ink-divider" />
      </view>

      <view class="page-body">
        <!-- 故事文件区 -->
        <view class="section">
          <view class="section-head">
            <view class="section-title-row">
              <app-icon name="scroll" :size="16" class="section-title-icon" />
              <text class="section-title">故事文件</text>
            </view>
            <view class="section-actions">
              <text class="link-btn" @click="storyStore.loadStories()">刷新</text>
              <text v-if="storyFiles.length" class="link-btn" @click="handleIndexAll">索引全部</text>
            </view>
          </view>

          <!-- 加载中 -->
          <view v-if="storiesLoading && storyFiles.length === 0" class="gothic-card loading-card">
            <view class="sigil-spinner" />
            <text class="loading-text">加载中...</text>
          </view>

          <!-- 文件列表 -->
          <view v-else-if="storyFiles.length" class="file-list">
            <view v-if="indexAllLoading" class="gothic-card task-progress batch-progress">
              <view class="progress-meta">
                <text>批量索引 {{ indexAllProgress.completed }}/{{ indexAllProgress.total }} · {{ indexAllProgress.percent }}%</text>
                <text v-if="indexAllProgress.currentStory">正在处理：{{ indexAllProgress.currentStory }}</text>
              </view>
              <view class="progress-track"><view class="progress-fill" :style="{ width: indexAllProgress.percent + '%' }" /></view>
            </view>
            <view
              v-for="story in storyFiles"
              :key="story.id"
              class="gothic-card file-card"
              hover-class="file-card-hover"
            >
              <view class="file-inner">
                <view class="file-badge">
                  <text>{{ story.name.charAt(0) }}</text>
                </view>
                <view class="file-info">
                  <text class="file-name">{{ story.name }}</text>
                  <text class="file-status" :style="{ color: isIndexed(story.id) ? 'var(--c-eld-300)' : 'var(--c-obsidian-light)' }">
                    {{ isIndexed(story.id) ? '已索引' : '未索引' }}
                  </text>
                  <view
                    v-if="indexStatus[story.id] === 'loading' || operationProgressFor('index', story.id)?.state === 'running'"
                    class="task-progress inline-progress"
                  >
                    <view class="progress-meta">
                      <text>{{ operationProgressFor('index', story.id)?.message || '正在准备索引...' }}</text>
                      <text>{{ operationProgressFor('index', story.id)?.percent ?? 0 }}%</text>
                    </view>
                    <view class="progress-track"><view class="progress-fill" :style="{ width: progressWidth('index', story.id) }" /></view>
                  </view>
                  <text v-else-if="indexStatus[story.id] === 'error'" class="file-meta dossier-error">
                    {{ operationProgressFor('index', story.id)?.message || '索引失败，可重试' }}
                  </text>
                  <text v-else-if="indexStatus[story.id] === 'warning'" class="file-meta dossier-warning">
                    {{ operationProgressFor('index', story.id)?.warning || operationProgressFor('index', story.id)?.message || '索引已完成但有告警，可重新索引' }}
                  </text>
                </view>
              </view>
              <view class="file-actions">
                <button
                  class="mini-btn index-btn"
                  :disabled="indexStatus[story.id] === 'loading' || indexAllLoading"
                  :class="{ 'is-disabled': indexStatus[story.id] === 'loading' || indexAllLoading }"
                  @click="handleIndexStory(story.id)"
                >
                  {{ indexStatus[story.id] === 'loading' ? '索引中...'
                   : indexStatus[story.id] === 'error' ? '重试索引'
                   : indexStatus[story.id] === 'ok' || indexStatus[story.id] === 'warning' ? '重新索引' : '索引' }}
                </button>
                <button class="mini-btn delete-btn" @click="askDeleteStory(story.id, story.name)">删除</button>
              </view>
            </view>
          </view>

          <!-- 空态 -->
          <view v-else class="gothic-card">
            <empty-state
              icon="scroll"
              title="书架上空无一物..."
              desc="点击「导入故事」添加 PDF、TXT 或 MD 文件"
            />
          </view>
        </view>

        <!-- 已索引故事区 -->
        <view class="section">
          <view class="section-head">
            <view class="section-title-row">
              <app-icon name="book-open" :size="16" class="section-title-icon" />
              <text class="section-title">已索引故事</text>
            </view>
            <text class="link-btn" @click="refreshIndexed">刷新</text>
          </view>

          <view v-if="indexedStories.length" class="file-list">
            <view v-for="idx in indexedStories" :key="idx.storyId" class="gothic-card indexed-card" hover-class="file-card-hover">
              <view class="indexed-head">
                <view class="file-inner">
                  <view class="file-badge idx-badge">
                    <text>{{ idx.name.charAt(0) }}</text>
                  </view>
                  <view class="file-info">
                    <text class="file-name">{{ idx.name }}</text>
                    <text class="file-meta">
                      {{ idx.chunkCount }} 个信息块
                      <text v-if="idx.indexedAt" class="ml-8"> {{ formatDate(idx.indexedAt) }}</text>
                    </text>
                    <text class="file-meta">单人开局需要守秘人档案；已生成的档案在下方单独管理</text>
                    <view
                      v-if="!dossierForStory(idx.storyId) && (dossierStatus[idx.storyId] === 'loading' || operationProgressFor('dossier', idx.storyId)?.state === 'running')"
                      class="task-progress inline-progress"
                    >
                      <view class="progress-meta">
                        <text>{{ operationProgressFor('dossier', idx.storyId)?.message || '正在准备档案...' }}</text>
                        <text>{{ operationProgressFor('dossier', idx.storyId)?.percent ?? 0 }}%</text>
                      </view>
                      <view class="progress-track"><view class="progress-fill" :style="{ width: progressWidth('dossier', idx.storyId) }" /></view>
                    </view>
                    <text v-else-if="!dossierForStory(idx.storyId) && dossierStatus[idx.storyId] === 'error'" class="file-meta dossier-error">
                      {{ operationProgressFor('dossier', idx.storyId)?.message || '档案生成失败，可重试' }}
                    </text>
                  </view>
                </view>

                <view class="file-actions">
                  <button
                    class="mini-btn index-btn"
                    :disabled="dossierStatus[idx.storyId] === 'loading'"
                    :class="{ 'is-disabled': dossierStatus[idx.storyId] === 'loading' }"
                    @click="handleGenerateDossier(idx.storyId, idx.name)"
                  >
                    {{ dossierStatus[idx.storyId] === 'loading' ? '生成中...'
                     : dossierStatus[idx.storyId] === 'error' ? '重试生成'
                     : dossierForStory(idx.storyId) ? '重生成档案' : '生成守秘人档案' }}
                  </button>
                  <button class="mini-btn delete-btn" @click="askDeleteIndex(idx.storyId, idx.name)">删除索引</button>
                </view>
              </view>
            </view>
          </view>

          <view v-else class="no-indexed">暂无已索引的故事</view>
        </view>

        <!-- 守秘人档案单独展示，便于区分索引和单人开局所需的档案 -->
        <view class="section">
          <view class="section-head">
            <view class="section-title-row">
              <app-icon name="book-open" :size="16" class="section-title-icon" />
              <text class="section-title">已生成守秘人档案</text>
            </view>
            <text class="link-btn" @click="refreshDossiers">刷新</text>
          </view>

          <view v-if="dossierListLoading && storyDossiers.length === 0" class="gothic-card loading-card">
            <view class="sigil-spinner" />
            <text class="loading-text">正在读取档案...</text>
          </view>
          <view v-else-if="dossierListError" class="gothic-card dossier-list-error">
            <text class="file-meta dossier-error">无法读取档案列表，请重试</text>
            <button class="mini-btn index-btn" @click="refreshDossiers">重试读取</button>
          </view>
          <view v-else-if="storyDossiers.length" class="file-list">
            <view v-for="dossier in storyDossiers" :key="dossier.scriptId" class="gothic-card indexed-card">
              <view class="indexed-head">
                <view class="file-inner">
                  <view class="file-badge idx-badge"><text>{{ dossier.name.charAt(0) }}</text></view>
                  <view class="file-info">
                    <text class="file-name">{{ dossier.name }}</text>
                    <text class="file-meta">
                      {{ dossier.sceneCount }} 个场景
                      <text v-if="typeof dossier.coveragePct === 'number'" class="ml-8">覆盖率 {{ dossier.coveragePct }}%</text>
                      <text class="ml-8">{{ formatDate(dossier.generatedAt) }}</text>
                    </text>
                    <text v-if="dossier.degraded" class="file-meta dossier-warning">
                      档案质量不足{{ dossier.failedBatches ? ` · ${dossier.failedBatches} 个批次失败` : '' }}，单人开局可能仍会拦截
                    </text>
                    <view
                      v-if="dossierStatus[dossier.scriptId] === 'loading' || operationProgressFor('dossier', dossier.scriptId)?.state === 'running'"
                      class="task-progress inline-progress"
                    >
                      <view class="progress-meta">
                        <text>{{ operationProgressFor('dossier', dossier.scriptId)?.message || '正在生成档案...' }}</text>
                        <text>{{ operationProgressFor('dossier', dossier.scriptId)?.percent ?? 0 }}%</text>
                      </view>
                      <view class="progress-track"><view class="progress-fill" :style="{ width: progressWidth('dossier', dossier.scriptId) }" /></view>
                    </view>
                    <text v-else-if="dossierStatus[dossier.scriptId] === 'error'" class="file-meta dossier-error">
                      {{ operationProgressFor('dossier', dossier.scriptId)?.message || '档案生成失败，可重试' }}
                    </text>
                    <text v-else-if="dossierStatus[dossier.scriptId] === 'warning' && !dossier.degraded" class="file-meta dossier-warning">
                      {{ operationProgressFor('dossier', dossier.scriptId)?.message || '档案已生成，但有告警' }}
                    </text>
                  </view>
                </view>
                <view class="file-actions">
                  <button
                    class="mini-btn index-btn"
                    :disabled="dossierStatus[dossier.scriptId] === 'loading'"
                    :class="{ 'is-disabled': dossierStatus[dossier.scriptId] === 'loading' }"
                    @click="handleGenerateDossier(dossier.scriptId, dossier.name)"
                  >
                    {{ dossierStatus[dossier.scriptId] === 'loading' ? '生成中...' : dossierStatus[dossier.scriptId] === 'error' ? '重试生成' : '重生成档案' }}
                  </button>
                </view>
              </view>
            </view>
          </view>
          <view v-else class="no-indexed">暂无已生成的守秘人档案</view>
        </view>
      </view>
    </view>

    <!-- 删除确认（ADR-0004：危险操作分级确认） -->
    <confirm-modal
      v-if="pendingDelete"
      :title="pendingDelete.kind === 'file' ? `删除「${pendingDelete.name}」？` : `删除索引「${pendingDelete.name}」？`"
      :message="pendingDelete.kind === 'file' ? '故事文件将永久删除，无法恢复。此操作不可撤销。' : '该故事的向量索引将删除，可重新索引。'"
      confirm-text="确认删除"
      tone="danger"
      :loading="deleting"
      @confirm="confirmDeleteStory"
      @cancel="pendingDelete = null"
    />
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
  max-width: 896px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.head-left { min-width: 0; }
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
.import-btn {
  background: rgba(0, 0, 0, 0.6);
}
.head-divider {
  max-width: 80px;
  margin-top: 12px;
  flex-basis: 100%;
}

.page-body {
  flex: 1;
  padding: 0 24px 48px;
  max-width: 896px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.section-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.section-title-icon {
  color: var(--c-eld-300);
}
.section-title {
  font-family: $font-display;
  font-size: 0.875rem;
  font-weight: bold;
  color: var(--c-paper-100);
  letter-spacing: 0.05em;
}
.section-actions {
  display: flex;
  gap: 12px;
}
.link-btn {
  font-size: 11px;
  color: var(--c-eld-300);
  padding: 2px 4px;
}
.link-btn:active {
  opacity: 0.6;
}

.loading-card {
  padding: 32px;
  text-align: center;
  background: rgba(0, 0, 0, 0.4);
}
.loading-text {
  display: block;
  margin-top: 12px;
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  color: var(--c-fog);
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.file-card,
.indexed-card {
  padding: 16px;
  background: rgba(0, 0, 0, 0.5);
}
.file-card-hover {
  background: rgba(0, 0, 0, 0.6);
}
.file-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.file-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}
.file-badge {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: $font-display;
  font-size: 0.875rem;
  background: color-mix(in srgb, var(--c-paper-900) 40%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-paper-800) 30%, transparent);
  color: var(--c-paper-400);
}
.idx-badge {
  background: color-mix(in srgb, var(--c-eld-900) 50%, transparent);
  border-color: color-mix(in srgb, var(--c-eld-700) 40%, transparent);
  color: var(--c-eld-100);
}
.file-info {
  min-width: 0;
}
.file-name {
  display: block;
  font-family: $font-serif;
  font-weight: 600;
  font-size: 0.875rem;
  word-break: break-all;
  color: var(--c-paper-100);
}
.file-status {
  display: block;
  margin-top: 2px;
  font-size: 10px;
}
.file-meta {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: var(--c-ash);
}
.ml-8 { margin-left: 8px; }

.file-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.mini-btn {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  box-sizing: border-box;
}
.index-btn {
  background: color-mix(in srgb, var(--c-eld-900) 50%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 30%, transparent);
  color: var(--c-eld-100);
}
.delete-btn {
  background: color-mix(in srgb, var(--c-blood-800) 30%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-blood-700) 30%, transparent);
  color: var(--c-blood-200);
}
.dossier-error { color: var(--c-blood-200); }
.dossier-warning { color: var(--c-eld-200); }

.task-progress {
  display: block;
  width: 100%;
  margin-top: 8px;
}
.batch-progress {
  padding: 12px 14px;
  background: rgba(0, 0, 0, 0.45);
}
.inline-progress { min-width: 150px; }
.progress-meta {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
  color: var(--c-fog);
  font-size: 10px;
  line-height: 1.4;
}
.progress-meta text:first-child { min-width: 0; flex: 1; }
.progress-meta text:last-child { flex-shrink: 0; color: var(--c-eld-200); }
.progress-track {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
}
.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--c-eld-700), var(--c-eld-300));
  transition: width 0.25s ease;
}
.dossier-list-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  background: rgba(0, 0, 0, 0.5);
}

.empty-card {
  padding: 32px;
  text-align: center;
  background: rgba(0, 0, 0, 0.4);
}
.empty-quote {
  display: block;
  font-family: $font-serif;
  font-style: italic;
  font-size: 1.125rem;
  margin-bottom: 8px;
  color: var(--c-ash);
}
.empty-hint {
  display: block;
  font-size: 0.875rem;
  color: var(--c-fog);
}

.indexed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.no-indexed {
  font-size: 0.875rem;
  padding: 16px 0;
  text-align: center;
  font-style: italic;
  font-family: $font-serif;
  color: var(--c-ash);
}

</style>
