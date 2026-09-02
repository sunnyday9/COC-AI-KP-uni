<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useStoryStore } from '../../stores/storyStore'
import { listIndexedStories, deleteStoryIndex, getStoryGraph, type IndexedStory } from '../../services/ragService'
import { useToast } from '../../composables/useToast'
import { onUnauthorized } from '../../platform/token'
import AppLayout from '../../components/layout/AppLayout.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import ConfirmModal from '../../components/ui/ConfirmModal.vue'
import EmptyState from '../../components/ui/EmptyState.vue'

const toast = useToast()
const storyStore = useStoryStore()
const { storyFiles, isLoading: storiesLoading } = storeToRefs(storyStore)
const isDev = import.meta.env.DEV

const indexedStories = ref<IndexedStory[]>([])
const indexStatus = ref<Record<string, 'idle' | 'loading' | 'ok' | 'error'>>({})
const expandedGraph = ref<Record<string, boolean>>({})
const graphCache = ref<Record<string, Awaited<ReturnType<typeof getStoryGraph>> | undefined>>({})
const graphLoading = ref<Record<string, boolean>>({})

const graphRagTestStatus = ref<Record<string, 'idle' | 'loading' | 'ok' | 'error'>>({})
const graphRagTestError = ref<Record<string, string>>({})
const graphRagTestPreviewText = ref<Record<string, string>>({})

async function refreshIndexed() {
  try { indexedStories.value = await listIndexedStories() } catch { indexedStories.value = [] }
}

onMounted(() => {
  storyStore.loadStories()
  refreshIndexed()
  // 401（登录过期）时提示重新登录
  offUnauthorized = onUnauthorized(() => {
    toast.warning('登录已过期，请到设置页重新登录')
  })
})

onUnmounted(() => {
  if (offUnauthorized) offUnauthorized()
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

async function handleIndexStory(id: string) {
  indexStatus.value[id] = 'loading'
  try {
    const result = await storyStore.indexStoryForRag(id)
    if (result.ok) {
      indexStatus.value[id] = 'ok'
      toast.success(`索引成功！共 ${result.indexed || 0} 个信息块`)
      await refreshIndexed()
    } else {
      indexStatus.value[id] = 'error'
      toast.error(`索引失败：${result.error || '未知错误'}`)
    }
  } catch (e) {
    indexStatus.value[id] = 'error'
    toast.error(`索引失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleIndexAll() {
  const result = await storyStore.indexAllStories()
  if (result.ok) toast.success(`索引完成！共 ${result.total} 个信息块`)
  else toast.warning(`索引完成（${result.errors.length} 个错误），共 ${result.total} 个信息块`)
  await refreshIndexed()
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

async function toggleGraphPanel(storyId: string) {
  expandedGraph.value[storyId] = !expandedGraph.value[storyId]
  if (!expandedGraph.value[storyId]) return
  if (graphCache.value[storyId] !== undefined) return

  graphLoading.value[storyId] = true
  try {
    graphCache.value[storyId] = await getStoryGraph(storyId)
  } catch (e) {
    toast.error(`加载 GraphRAG 失败：${e instanceof Error ? e.message : String(e)}`)
    graphCache.value[storyId] = null
  } finally {
    graphLoading.value[storyId] = false
  }
}

async function handleTestGraphRagExtract(storyId: string) {
  graphRagTestStatus.value[storyId] = 'loading'
  graphRagTestError.value[storyId] = ''
  graphRagTestPreviewText.value[storyId] = ''

  try {
    const bridge = (await import('../../platform')).getBridge()
    const result = await bridge.ragTestGraphRagExtract({ scriptId: storyId, maxChunks: 6, maxBatches: 3 })
    if (!result?.ok) throw new Error(result?.error || 'GraphRAG extract test failed')

    graphRagTestStatus.value[storyId] = 'ok'
    graphRagTestPreviewText.value[storyId] = JSON.stringify(result, null, 2).slice(0, 8000)
  } catch (e) {
    graphRagTestStatus.value[storyId] = 'error'
    graphRagTestError.value[storyId] = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <app-layout active="scripts" bg="/static/bg/bg_archives.webp" :overlay="0.7">
    <view class="page-root">
      <!-- 页头 -->
      <view class="page-head">
        <view class="head-left">
          <text class="page-title">故事管理</text>
          <text class="page-desc">导入故事文件并索引到向量数据库，供 AI KP 参考</text>
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
                  <text class="file-status" :style="{ color: isIndexed(story.id) ? 'hsl(165, 50%, 50%)' : 'hsl(220, 10%, 25%)' }">
                    {{ isIndexed(story.id) ? '已索引' : '未索引' }}
                  </text>
                </view>
              </view>
              <view class="file-actions">
                <button
                  class="mini-btn index-btn"
                  :class="{ 'is-disabled': indexStatus[story.id] === 'loading' }"
                  @click="handleIndexStory(story.id)"
                >
                  {{ indexStatus[story.id] === 'loading' ? '索引中...'
                   : indexStatus[story.id] === 'ok' ? '✓ 完成' : '索引' }}
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
                  </view>
                </view>

                <view class="file-actions">
                  <button v-if="isDev" class="mini-btn graph-btn" @click="toggleGraphPanel(idx.storyId)">
                    {{ expandedGraph[idx.storyId] ? '收起 GraphRAG' : '查看 GraphRAG' }}
                  </button>
                  <button class="mini-btn delete-btn" @click="askDeleteIndex(idx.storyId, idx.name)">删除索引</button>
                </view>
              </view>

              <!-- GraphRAG 面板（dev only；图谱浏览器组件由 Task 9 提供） -->
              <view v-if="isDev && expandedGraph[idx.storyId]" class="graph-panel">
                <view class="graph-tools">
                  <button
                    class="gothic-btn-secondary graph-test-btn"
                    :class="{ 'is-disabled': graphRagTestStatus[idx.storyId] === 'loading' }"
                    @click="handleTestGraphRagExtract(idx.storyId)"
                  >
                    {{ graphRagTestStatus[idx.storyId] === 'loading' ? '测试中...' : '测试 GraphRAG 抽取（前6chunks）' }}
                  </button>
                  <text v-if="graphRagTestStatus[idx.storyId] === 'ok'" class="ok-text">✓ 测试完成</text>
                  <text v-if="graphRagTestStatus[idx.storyId] === 'error'" class="err-text">✕ {{ graphRagTestError[idx.storyId] }}</text>
                </view>

                <text v-if="graphRagTestPreviewText[idx.storyId]" class="preview-text">{{ graphRagTestPreviewText[idx.storyId] }}</text>

                <view class="graph-placeholder">
                  <text v-if="graphLoading[idx.storyId]" class="placeholder-text">加载图数据中...</text>
                  <!-- #ifdef H5 -->
                  <text v-else class="placeholder-text">
                    图谱浏览请使用 RAG Inspector（设置页开发调试区入口）
                  </text>
                  <!-- #endif -->
                  <!-- #ifndef H5 -->
                  <text v-else class="placeholder-text">
                    图谱浏览工具仅 H5 端可用
                  </text>
                  <!-- #endif -->
                </view>
              </view>
            </view>
          </view>

          <view v-else class="no-indexed">暂无已索引的故事</view>
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
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
}
.page-desc {
  display: block;
  margin-top: 4px;
  font-size: 0.875rem;
  color: hsl(220, 10%, 60%);
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
  color: hsl(165, 50%, 50%);
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
  color: hsl(220, 10%, 50%);
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
  background: hsla(38, 18%, 18%, 0.4);
  border: 1px solid hsla(38, 20%, 30%, 0.3);
  color: var(--c-paper-400);
}
.idx-badge {
  background: hsla(165, 35%, 10%, 0.5);
  border-color: hsla(165, 45%, 22%, 0.4);
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
  background: hsla(165, 35%, 10%, 0.5);
  border: 1px solid hsla(165, 45%, 22%, 0.3);
  color: var(--c-eld-100);
}
.delete-btn {
  background: hsla(0, 50%, 15%, 0.3);
  border: 1px solid hsla(0, 55%, 22%, 0.3);
  color: hsl(0, 55%, 65%);
}
.graph-btn {
  background: hsla(220, 16%, 11%, 0.5);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
  color: hsl(38, 25%, 55%);
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
  color: hsl(220, 10%, 45%);
}
.empty-hint {
  display: block;
  font-size: 0.875rem;
  color: hsl(220, 10%, 55%);
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
  color: hsl(220, 10%, 40%);
}

/* GraphRAG 面板 */
.graph-panel {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid hsla(220, 14%, 16%, 0.5);
}
.graph-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.graph-test-btn {
  font-size: 12px;
}
.ok-text {
  font-size: 12px;
  color: hsl(165, 50%, 60%);
}
.err-text {
  font-size: 12px;
  color: hsl(0, 55%, 65%);
}
.preview-text {
  display: block;
  font-family: $font-mono;
  font-size: 12px;
  border-radius: 4px;
  padding: 8px;
  max-height: 224px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: hsl(38, 25%, 55%);
  background: hsla(220, 20%, 4%, 0.5);
  border: 1px solid var(--c-slate);
}
.graph-placeholder {
  margin-top: 12px;
  padding: 24px;
  border: 1px dashed hsla(220, 14%, 16%, 0.6);
  border-radius: 8px;
  text-align: center;
}
.placeholder-text {
  font-size: 12px;
  color: var(--c-ash);
  font-family: $font-serif;
}
</style>
