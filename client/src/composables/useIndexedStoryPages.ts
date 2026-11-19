import { ref } from 'vue'
import { getBridge } from '../platform'
import type { IndexedStory } from '../../../shared/types/bridge'

/** Shared paging for the solo launch and multiplayer story selection controls. */
export function useIndexedStoryPages() {
  const stories = ref<IndexedStory[]>([])
  const nextCursor = ref<string | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  let revision = 0

  async function loadPage(cursor?: string) {
    const request = ++revision
    isLoading.value = true
    error.value = null
    try {
      const page = await getBridge().ragListStoryPage(cursor)
      if (request !== revision) return
      stories.value = cursor ? [...stories.value, ...page.stories] : page.stories
      nextCursor.value = page.nextCursor
    } catch {
      if (request === revision) error.value = '无法加载已索引故事'
    } finally {
      if (request === revision) isLoading.value = false
    }
  }

  function refresh() {
    stories.value = []
    nextCursor.value = null
    return loadPage()
  }

  async function loadMore() {
    if (nextCursor.value && !isLoading.value) await loadPage(nextCursor.value)
  }

  return { stories, nextCursor, isLoading, error, refresh, loadMore }
}
