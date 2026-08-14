<script setup lang="ts">
// #ifdef H5
import { ref, watch, onMounted } from 'vue'
import {
  listIndexedStories,
  getStoryIndex,
  getStoryGraph,
  checkRagHealth,
  type IndexedStory,
} from '../../services/ragService'
import ChunkBrowser from '../../components/rag/ChunkBrowser.vue'
import GraphBrowser from '../../components/rag/GraphBrowser.vue'
import SearchTester from '../../components/rag/SearchTester.vue'
import AppLayout from '../../components/layout/AppLayout.vue'

/**
 * RAG Inspector（Task 9，迁移自 original/ai-trpg-web/src/views/RagInspectorView.vue）。
 * 仅 H5：pages.json 中以条件编译注释注册（MP 构建不包含本页，见 task-9-report §条件编译）。
 * 原 vue-router dev-only 路由（import.meta.env.DEV）→ 页面恒注册于 H5，
 * 页内保留 DEV ONLY 徽记（数据来自 ragService → platform bridge，无 DOM 依赖）。
 */

type Tab = 'chunks' | 'graph' | 'search'

const tab = ref<Tab>('chunks')
const stories = ref<IndexedStory[]>([])
const selectedStoryId = ref('')
const loading = ref(false)
const health = ref<'checking' | 'ok' | 'down'>('checking')

const pageBg = '/static/bg/bg_archives.webp'

const indexData = ref<{
  scriptId: string; storyName: string; chunkCount: number
  chunks: { id: string; content: string; type: string; metadata: Record<string, unknown>; hasVector: boolean }[]
} | null>(null)

const graphData = ref<{
  scriptId: string; storyName: string; indexedAt: number
  nodeCount: number; edgeCount: number
  nodes: { id: string; type: string; name: string; content: string; communityId: string | null; chunkIds: string[] }[]
  edges: { source: string; target: string; type: string; label: string }[]
  communitySummaries: Record<string, string>
} | null>(null)

onMounted(async () => {
  checkRagHealth().then((ok) => { health.value = ok ? 'ok' : 'down' }).catch(() => { health.value = 'down' })
  try {
    stories.value = await listIndexedStories()
    if (stories.value.length) {
      selectedStoryId.value = stories.value[0].storyId
    }
  } catch (e) {
    console.error('[RagInspector] list indexed stories failed', e)
  }
})

watch(selectedStoryId, async (id) => {
  if (!id) { indexData.value = null; graphData.value = null; return }
  loading.value = true
  try {
    const [idx, graph] = await Promise.all([getStoryIndex(id), getStoryGraph(id)])
    indexData.value = idx
    graphData.value = graph
  } catch (e) {
    console.error('[RagInspector] load failed', e)
  }
  loading.value = false
})
// #endif
</script>

<template>
  <!-- #ifdef H5 -->
  <app-layout active="settings" :bg="pageBg" :overlay="0.8">
    <view class="insp-root">
      <view class="insp-head">
        <view>
          <text class="insp-title">RAG Inspector</text>
          <text class="insp-sub">开发工具 — 检查 RAG 索引 / GraphRAG 提取结果 / 搜索质量</text>
        </view>
        <view class="insp-dev-badge">DEV ONLY</view>
      </view>

      <!-- 服务健康 + 故事选择 -->
      <view class="insp-toolbar">
        <text class="insp-label">RAG 服务:</text>
        <text :class="['insp-health', health === 'ok' ? 'health-ok' : health === 'down' ? 'health-down' : 'health-checking']">
          {{ health === 'checking' ? '检测中...' : health === 'ok' ? '正常' : '不可用' }}
        </text>
        <text class="insp-label">故事:</text>
        <select v-model="selectedStoryId" class="insp-select">
          <option value="" disabled>选择已索引的故事</option>
          <option v-for="s in stories" :key="s.storyId" :value="s.storyId">
            {{ s.name }} ({{ s.chunkCount }} chunks)
          </option>
        </select>
        <text v-if="indexData" class="insp-stats">
          {{ indexData.chunkCount }} chunks
          <template v-if="graphData"> · {{ graphData.nodeCount }} nodes · {{ graphData.edgeCount }} edges</template>
        </text>
      </view>

      <!-- Tabs -->
      <view class="insp-tabs">
        <button
          v-for="t in (['chunks', 'graph', 'search'] as Tab[])"
          :key="t"
          :class="['insp-tab', tab === t ? 'insp-tab-on' : 'insp-tab-off']"
          @click="tab = t"
        >
          {{ t === 'chunks' ? 'Chunk 浏览器' : t === 'graph' ? 'Graph 浏览器' : '搜索测试' }}
        </button>
      </view>

      <!-- Tab 内容 -->
      <chunk-browser
        v-if="tab === 'chunks'"
        :chunks="indexData?.chunks ?? []"
        :loading="loading"
      />
      <graph-browser
        v-if="tab === 'graph'"
        :graph="graphData ?? null"
        :loading="loading"
      />
      <search-tester
        v-if="tab === 'search'"
        :script-id="selectedStoryId"
      />
    </view>
  </app-layout>
  <!-- #endif -->
  <!-- #ifndef H5 -->
  <view class="h5-only-page">
    <text class="h5-only-title">RAG Inspector</text>
    <text class="h5-only-hint">该页面仅支持 H5 端访问（小程序不包含此页）。</text>
  </view>
  <!-- #endif -->
</template>

<style scoped lang="scss">
.h5-only-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 8px;
}
.h5-only-title {
  font-size: 1.25rem;
  font-family: $font-display;
  color: $c-parchment-100;
}
.h5-only-hint {
  font-size: 0.875rem;
  color: $c-ash;
}

.insp-root {
  padding: 24px 16px;
  max-width: 1152px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.insp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.insp-title {
  display: block;
  font-family: $font-display;
  font-size: 1.25rem;
  font-weight: bold;
  color: $c-parchment-100;
}
.insp-sub {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: $c-ash;
}
.insp-dev-badge {
  font-size: 12px;
  color: $c-ritual-200;
  background: hsla(42, 65%, 35%, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid hsla(42, 70%, 50%, 0.3);
  flex-shrink: 0;
}

.insp-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.insp-label {
  font-size: 0.875rem;
  color: $c-fog;
}
.insp-health {
  font-size: 0.875rem;
  font-weight: 500;
  margin-right: 8px;
}
.health-ok { color: $c-eldritch-200; }
.health-down { color: $c-blood-200; }
.health-checking { color: $c-fog; }
.insp-select {
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
  min-width: 260px;
}
.insp-stats {
  font-size: 12px;
  color: $c-ash;
}

.insp-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid $c-slate;
}
.insp-tab {
  padding: 8px 16px;
  font-size: 0.875rem;
  font-weight: 500;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s;
}
.insp-tab-on {
  color: $c-mana-200;
  border-bottom-color: $c-mana-300;
}
.insp-tab-off {
  color: $c-fog;
}
.insp-tab-off:hover {
  color: $c-parchment-200;
}
</style>
