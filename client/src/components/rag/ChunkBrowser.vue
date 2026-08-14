<script setup lang="ts">
import { ref, computed, watch } from 'vue'

/**
 * RAG Chunk 浏览器（Task 9，迁移自 original/ai-trpg-web/src/components/rag/ChunkBrowser.vue）。
 * 仅 H5 上下文使用（RAG Inspector 页面为 H5-only，见 pages.json 条件编译）；
 * Tailwind 工具类 → 本组件 scoped SCSS（色调对应 Tailwind gray/blue/amber/green 系）。
 */

const props = defineProps<{
  chunks: { id: string; content: string; type: string; metadata: Record<string, unknown>; hasVector: boolean }[]
  loading: boolean
}>()

const search = ref('')
const typeFilter = ref('')
const expandedId = ref<string | null>(null)
const page = ref(0)
const PAGE_SIZE = 30

const chunkTypes = computed(() => {
  const s = new Set(props.chunks.map(c => c.type))
  return [...s].sort()
})

const filtered = computed(() => {
  let list = props.chunks
  if (typeFilter.value) list = list.filter(c => c.type === typeFilter.value)
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter(c => c.content.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
  }
  return list
})

const paged = computed(() => filtered.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE))
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))

watch([search, typeFilter], () => { page.value = 0 })

function toggle(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function typeBadgeClass(t: string) {
  const map: Record<string, string> = {
    scene: 'badge-blue', clue: 'badge-amber', npc: 'badge-green',
    item: 'badge-purple', rule: 'badge-red', overview: 'badge-cyan',
  }
  return map[t] || 'badge-gray'
}
</script>

<template>
  <!-- #ifdef H5 -->
  <div class="cb-root">
    <div class="cb-toolbar">
      <input
        v-model="search"
        type="text"
        placeholder="搜索内容 / ID..."
        class="cb-search"
      />
      <select v-model="typeFilter" class="cb-select">
        <option value="">全部类型</option>
        <option v-for="t in chunkTypes" :key="t" :value="t">{{ t }}</option>
      </select>
      <span class="cb-count">{{ filtered.length }} / {{ chunks.length }} chunks</span>
    </div>

    <div v-if="loading" class="cb-state">加载中...</div>

    <div v-else-if="!chunks.length" class="cb-state dim">
      尚无索引数据，请先选择一个已索引的故事
    </div>

    <div v-else class="cb-list">
      <div
        v-for="chunk in paged"
        :key="chunk.id"
        class="cb-item"
        @click="toggle(chunk.id)"
      >
        <div class="cb-item-head">
          <span :class="['cb-badge', typeBadgeClass(chunk.type)]">
            {{ chunk.type }}
          </span>
          <span class="cb-id">{{ chunk.id }}</span>
          <span class="cb-preview">
            {{ chunk.content.slice(0, 80) }}{{ chunk.content.length > 80 ? '...' : '' }}
          </span>
          <span v-if="chunk.hasVector" class="cb-vec" title="已向量化">⬡</span>
          <span v-else class="cb-novec" title="仅 TF-IDF">○</span>
        </div>

        <div v-if="expandedId === chunk.id" class="cb-detail">
          <pre class="cb-pre">{{ chunk.content }}</pre>
          <div v-if="Object.keys(chunk.metadata).length" class="cb-meta">
            <div class="cb-meta-label">Metadata:</div>
            <div class="cb-meta-tags">
              <span
                v-for="(v, k) in chunk.metadata"
                :key="String(k)"
                class="cb-meta-tag"
              >
                {{ k }}: {{ v }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="totalPages > 1" class="cb-pager">
      <button
        :disabled="page === 0"
        class="cb-page-btn"
        @click="page--"
      >
        ◀
      </button>
      <span class="cb-page-info">{{ page + 1 }} / {{ totalPages }}</span>
      <button
        :disabled="page >= totalPages - 1"
        class="cb-page-btn"
        @click="page++"
      >
        ▶
      </button>
    </div>
  </div>
  <!-- #endif -->
  <!-- #ifndef H5 -->
  <text class="h5-only-hint">仅 H5 可用</text>
  <!-- #endif -->
</template>

<style scoped lang="scss">
/* 色调对齐 client 全局设计令牌（$c-* / $c-parchment-* / $c-eldritch-* 等） */
.h5-only-hint {
  display: block;
  padding: 16px;
  color: $c-ash;
  font-size: 12px;
}

.cb-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.cb-search {
  flex: 1;
  min-width: 200px;
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
  outline: none;
}
.cb-search:focus {
  border-color: $c-mana-300;
}
.cb-select {
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
}
.cb-count {
  font-size: 12px;
  color: $c-fog;
}

.cb-state {
  text-align: center;
  padding: 32px 0;
  color: $c-fog;
  font-size: 0.875rem;
}
.cb-state.dim {
  color: $c-ash;
}

.cb-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cb-item {
  background: hsla(220, 16%, 11%, 0.6);
  border: 1px solid $c-slate;
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.cb-item:hover {
  border-color: $c-slate-light;
}
.cb-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}
.cb-badge {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  color: #fff;
  font-family: $font-mono;
  flex-shrink: 0;
}
.badge-blue { background: hsl(217, 91%, 60%); }
.badge-amber { background: hsl(38, 92%, 50%); }
.badge-green { background: hsl(160, 84%, 39%); }
.badge-purple { background: hsl(271, 81%, 56%); }
.badge-red { background: hsl(0, 72%, 51%); }
.badge-cyan { background: hsl(192, 91%, 36%); }
.badge-gray { background: hsl(220, 9%, 46%); }
.cb-id {
  font-size: 12px;
  color: $c-fog;
  font-family: $font-mono;
  flex-shrink: 0;
}
.cb-preview {
  font-size: 0.875rem;
  color: $c-parchment-300;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.cb-vec {
  font-size: 12px;
  color: $c-eldritch-300;
  flex-shrink: 0;
}
.cb-novec {
  font-size: 12px;
  color: $c-ash;
  flex-shrink: 0;
}

.cb-detail {
  padding: 0 12px 12px;
  border-top: 1px solid $c-slate;
}
.cb-pre {
  font-size: 12px;
  color: $c-parchment-300;
  white-space: pre-wrap;
  margin-top: 8px;
  max-height: 240px;
  overflow: auto;
  font-family: $font-mono;
}
.cb-meta {
  margin-top: 8px;
}
.cb-meta-label {
  font-size: 12px;
  color: $c-ash;
  margin-bottom: 4px;
}
.cb-meta-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cb-meta-tag {
  font-size: 12px;
  background: $c-slate;
  padding: 2px 6px;
  border-radius: 4px;
  color: $c-parchment-300;
}

.cb-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding-top: 8px;
}
.cb-page-btn {
  padding: 4px 8px;
  font-size: 12px;
  background: $c-slate;
  border: none;
  border-radius: 6px;
  color: $c-parchment-200;
}
.cb-page-btn:disabled {
  opacity: 0.3;
}
.cb-page-info {
  font-size: 12px;
  color: $c-fog;
}
</style>
