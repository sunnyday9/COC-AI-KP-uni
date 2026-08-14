import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fileToChunks } from '../services/storyService'
import { indexStory } from '../services/ragService'
import { getBridge } from '../platform'

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
}

export const useStoryStore = defineStore('story', () => {
  const storyFiles = ref<StoryFile[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  async function loadStories() {
    try {
      isLoading.value = true
      error.value = null
      storyFiles.value = await getBridge().listStories()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load stories'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 差异说明：原实现由 Electron 打开文件对话框（无参数）。新架构文件选择在
   * 页面层（Task 8）—— 页面选择后调用 `importStory(filePath)`，或先
   * `getBridge().setImportFilePath(path)` 再无参调用（保持原 API 形状）。
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
  async function indexStoryForRag(storyId: string): Promise<{ ok: boolean; error?: string; indexed?: number }> {
    try {
      const content = await getBridge().readStoryForRag(storyId)
      const filename = storyId.split(/[/\\]/).pop() || 'story.txt'
      const displayName = filename.replace(/\.[^./\\]+$/i, '')
      const isMarkdown = /\.(md|markdown)$/i.test(filename)
      const chunks = fileToChunks(content, storyId, filename, {
        useStructuredMarkdown: isMarkdown,
      })
      const result = await indexStory(storyId, chunks, { name: displayName })
      return result.ok ? { ok: true, indexed: result.indexed } : { ok: false, error: 'Index failed' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function indexAllStories(): Promise<{ ok: boolean; total: number; errors: string[] }> {
    await loadStories()
    const errors: string[] = []
    let total = 0
    for (const story of storyFiles.value) {
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
    loadStories,
    importStory,
    deleteStory,
    indexStoryForRag,
    indexAllStories,
  }
})
