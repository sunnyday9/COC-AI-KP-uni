import { defineStore } from 'pinia'
import { ref } from 'vue'
import { indexStory } from '../services/ragService'
import { createStoryOperationId } from '../services/operationId'
import { getBaseUrl, getBridge, getToken } from '../platform'
import type { StoryCatalogPage, StoryPreparationStatus } from '../../../shared/types/bridge'

/**
 * 差异说明（Task 7，简报决策 4）：原 StoryFile 为 `{ name, path }`（Electron
 * 文件路径）。新架构服务端以 `id` 替代原 path（安全要求，api-contract §1），
 * id = 含扩展名的 sanitized 文件名；公开 API 形状（storyFiles/loadStories/
 * importStory/deleteStory/indexStoryForRag/indexAllStories）保持不变，
 * 字段名由 path → id，方法签名中路径参数相应改为 id。
 */
export interface StoryFile {
  name: string
  /** 服务端 id（替代原文件路径；含扩展名的 sanitized 文件名） */
  id: string
  preparation?: StoryPreparationStatus
}

export const useStoryStore = defineStore('story', () => {
  const storyFiles = ref<StoryFile[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const nextCursor = ref<string | null>(null)
  const canPrepare = ref(true)
  const preparationMode = ref<StoryCatalogPage['preparationMode']>()
  const selectedStoryId = ref<string | null>(null)
  const selectedStory = ref<(StoryFile & { content: string; truncated?: boolean }) | null>(null)
  const isSelecting = ref(false)
  const selectionError = ref<string | null>(null)
  let listRevision = 0
  let librarySession = 0
  let libraryToken: ReturnType<typeof getToken>
  let selectionRevision = 0
  const preparationByStory = new Map<string, StoryPreparationStatus>()
  let preparationOwnerId: string | undefined
  type PendingOperations = Record<string, string>
  const pendingPreparationOperations = new Map<string, PendingOperations>()

  function operationStorage(storyId: string) {
    const owner = preparationOwnerId
    const key = 'aikp_preparation_ops:' + JSON.stringify([getBaseUrl(), owner ?? null, storyId])
    function read(): PendingOperations {
      const fallback = pendingPreparationOperations.get(key)
      if (fallback) return fallback
      if (owner) {
        try {
          const saved: unknown = uni.getStorageSync(key)
          return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as PendingOperations : {}
        } catch {
          // The current page still supports operation replay when browser storage is unavailable.
        }
      }
      return {}
    }
    function write(operations: PendingOperations) {
      const hasOperations = Object.keys(operations).length > 0
      if (owner) {
        try {
          if (hasOperations) uni.setStorageSync(key, operations)
          else uni.removeStorageSync(key)
          pendingPreparationOperations.delete(key)
          return
        } catch {
          // Fall back to the current page.
        }
      }
      if (hasOperations) pendingPreparationOperations.set(key, operations)
      else pendingPreparationOperations.delete(key)
    }
    function acknowledge(operationId: string) {
      const operations = read()
      const remaining = Object.fromEntries(Object.entries(operations).filter(([, id]) => id !== operationId))
      if (Object.keys(remaining).length !== Object.keys(operations).length) write(remaining)
    }
    return { read, write, acknowledge }
  }

  function clearSelection() {
    selectionRevision++
    selectedStoryId.value = null
    selectedStory.value = null
    isSelecting.value = false
    selectionError.value = null
  }

  function resetLibrary() {
    librarySession++
    preparationByStory.clear()
    pendingPreparationOperations.clear()
    preparationOwnerId = undefined
    listRevision++
    storyFiles.value = []
    nextCursor.value = null
    preparationMode.value = undefined
    isLoading.value = false
    error.value = null
    clearSelection()
  }

  async function loadPage(cursor?: string) {
    const token = getToken()
    if (token !== libraryToken) {
      resetLibrary()
      libraryToken = token
      cursor = undefined
    }
    const revision = ++listRevision
    const isCurrent = () => revision === listRevision && token === getToken()
    try {
      isLoading.value = true
      error.value = null
      const page = await getBridge().listStoryPage(cursor)
      if (!isCurrent()) return
      preparationOwnerId = page.preparationOwnerId
      const rows = page.stories.map((story) => story.preparation
        ? { ...story, preparation: mergePreparation(story.id, story.preparation) }
        : story)
      storyFiles.value = cursor ? [...storyFiles.value, ...rows] : rows
      if (!cursor) {
        const visible = new Set(rows.map(({ id }) => id))
        for (const id of preparationByStory.keys()) {
          if (!visible.has(id)) preparationByStory.delete(id)
        }
      }
      nextCursor.value = page.nextCursor
      canPrepare.value = page.canPrepare !== false
      preparationMode.value = page.preparationMode
    } catch (e) {
      if (isCurrent()) error.value = e instanceof Error ? e.message : '无法加载故事'
    } finally {
      if (isCurrent()) isLoading.value = false
    }
  }

  async function loadStories() {
    clearSelection()
    storyFiles.value = []
    nextCursor.value = null
    await loadPage()
  }

  async function loadMoreStories() {
    if (nextCursor.value && !isLoading.value) await loadPage(nextCursor.value)
  }

  function mergePreparation(id: string, incoming: StoryPreparationStatus): StoryPreparationStatus {
    if (incoming.job?.operationId) operationStorage(id).acknowledge(incoming.job.operationId)
    const current = preparationByStory.get(id)
    const currentVersion = current?.job?.version ?? ''
    const incomingVersion = incoming.job?.version ?? ''
    if (current && (
      currentVersion.length > incomingVersion.length ||
      (currentVersion.length === incomingVersion.length && currentVersion > incomingVersion)
    )) return current
    preparationByStory.set(id, incoming)
    return incoming
  }

  async function updateStoryPreparation(id: string, request: () => Promise<StoryPreparationStatus>) {
    const token = getToken()
    const session = librarySession
    if (token !== libraryToken) return
    const status = await request()
    if (token !== getToken() || session !== librarySession) return
    const story = storyFiles.value.find((item) => item.id === id)
    if (!story && !isLoading.value) return
    const preparation = mergePreparation(id, status)
    if (story) story.preparation = preparation
  }

  async function submitStoryPreparation(id: string, retryOfJobId?: string) {
    if (getToken() !== libraryToken) return
    const intent = retryOfJobId ?? 'prepare'
    const saved = operationStorage(id)
    const operations = saved.read()
    const operationId = typeof operations[intent] === 'string' ? operations[intent] : createStoryOperationId('prepare')
    saved.write({ ...operations, [intent]: operationId })
    try {
      const api = getBridge()
      await updateStoryPreparation(id, () => retryOfJobId
        ? api.retryStoryPreparation(id, retryOfJobId, operationId)
        : api.prepareStory(id, operationId))
      saved.acknowledge(operationId)
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode
      // Keep the same ID when a transport failure leaves the outcome unknown.
      if (status !== undefined && status >= 400 && status < 500) saved.acknowledge(operationId)
      throw error
    }
  }

  const cancelStoryPreparation = (id: string, jobId: string) =>
    updateStoryPreparation(id, () => getBridge().cancelStoryPreparation(id, jobId))
  const refreshStoryPreparation = (id: string) =>
    updateStoryPreparation(id, () => getBridge().readStoryPreparation(id))

  async function selectStory(id: string) {
    clearSelection()
    selectedStoryId.value = id
    const revision = selectionRevision
    const token = getToken()
    const isCurrent = () => revision === selectionRevision && token === getToken()
    try {
      isSelecting.value = true
      const story = await getBridge().readStory(id, true)
      if (isCurrent()) selectedStory.value = { id, ...story }
    } catch (e) {
      if (isCurrent()) selectionError.value = e instanceof Error ? e.message : '无法读取故事'
    } finally {
      if (isCurrent()) isSelecting.value = false
    }
  }

  /** Explicit batch indexing still processes every local story. */
  async function listAllStories(): Promise<StoryFile[]> {
    const token = getToken()
    const stories: StoryFile[] = []
    let cursor: string | undefined
    do {
      const page = await getBridge().listStoryPage(cursor)
      if (token !== getToken()) throw new Error('登录状态已更改')
      if (page.canPrepare === false || page.preparationMode === 'durable') throw new Error('此网关尚未开放剧本准备')
      stories.push(...page.stories)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return stories
  }

  /**
   * 差异说明：原实现由 Electron 打开文件对话框（无参数）。新架构文件选择在
   * 页面层（Task 8）—— 页面选择后调用 `importStory(filePath)` 显式传参。
   */
  async function importStory(filePath?: string): Promise<{ ok: boolean; error?: string; id?: string; name?: string }> {
    const result = await getBridge().importStory(filePath)
    if (result?.ok) await loadStories()
    return result
  }

  async function deleteStory(id: string) {
    await getBridge().deleteStory(id)
    await loadStories()
  }

  /**
   * 差异说明：参数由原 path 改为服务端 storyId（含扩展名，可直接推导
   * filename/displayName/是否 Markdown）。原 pathToId（去扩展名）不再需要——
   * 索引键必须与服务端 storyId 一致（api-contract §8 按 userId + storyId 隔离）。
   */
  async function indexStoryForRag(storyId: string, operationId?: string): Promise<{ ok: boolean; error?: string; warning?: string; indexed?: number; networkError?: boolean }> {
    try {
      const filename = storyId.split(/[/\\]/).pop() || 'story.txt'
      const displayName = filename.replace(/\.[^./\\]+$/i, '')
      // M1-T3：切块搬到服务端——只报 storyId，服务端自读原文、自切块（递归语义 + 字符偏移）。
      const result = await indexStory(storyId, { name: displayName }, operationId)
      return result.ok
        ? { ok: true, indexed: result.indexed, warning: result.warning }
        : { ok: false, error: result.error ?? 'Index failed', warning: result.warning }
    } catch (e) {
      const details = e && typeof e === 'object' ? e as { networkError?: unknown; statusCode?: unknown } : {}
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        networkError: details.networkError === true || (typeof details.statusCode === 'number' && (details.statusCode === 408 || details.statusCode === 425 || details.statusCode === 429 || details.statusCode >= 500)),
      }
    }
  }

  async function indexAllStories(): Promise<{ ok: boolean; total: number; errors: string[] }> {
    const stories = await listAllStories()
    const errors: string[] = []
    let total = 0
    for (const story of stories) {
      const result = await indexStoryForRag(story.id)
      if (result.ok) {
        total += result.indexed || 0
      } else {
        errors.push(`${story.name}: ${result.error || 'Unknown error'}`)
      }
    }
    return { ok: errors.length === 0, total, errors }
  }

  return {
    storyFiles,
    isLoading,
    error,
    nextCursor,
    canPrepare,
    preparationMode,
    submitStoryPreparation,
    cancelStoryPreparation,
    refreshStoryPreparation,
    selectedStory,
    selectedStoryId,
    isSelecting,
    selectionError,
    resetLibrary,
    clearSelection,
    selectStory,
    loadStories,
    loadMoreStories,
    listAllStories,
    importStory,
    deleteStory,
    indexStoryForRag,
    indexAllStories,
  }
})
