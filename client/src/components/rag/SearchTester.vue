<script setup lang="ts">
import { ref } from 'vue'
import { queryChunks, getContext, type RAGChunkResult } from '../../services/ragService'

/**
 * RAG 搜索测试（Task 9，迁移自 original/ai-trpg-web/src/components/rag/SearchTester.vue）。
 * 仅 H5 上下文使用（RAG Inspector 页面为 H5-only）；数据经由 ragService → platform bridge。
 */

const props = defineProps<{ scriptId: string }>()

const query = ref('')
const topK = ref(5)
const running = ref(false)
const mode = ref<'chunks' | 'context'>('chunks')

const chunkResults = ref<RAGChunkResult[]>([])
const contextResult = ref('')
const elapsed = ref(0)

async function runSearch() {
  if (!query.value.trim() || !props.scriptId) return
  running.value = true
  chunkResults.value = []
  contextResult.value = ''
  const t0 = performance.now()
  try {
    if (mode.value === 'chunks') {
      const res = await queryChunks({
        query: query.value,
        scriptId: props.scriptId,
        topK: topK.value,
      })
      chunkResults.value = res.chunks
    } else {
      const res = await getContext({
        query: query.value,
        scriptId: props.scriptId,
        topK: topK.value,
      })
      contextResult.value = res.context
    }
  } catch (e: unknown) {
    contextResult.value = `Error: ${e instanceof Error ? e.message : String(e)}`
  }
  elapsed.value = Math.round(performance.now() - t0)
  running.value = false
}
</script>

<template>
  <!-- #ifdef H5 -->
  <div class="st-root">
    <div v-if="!scriptId" class="st-state dim">请先选择已索引的故事</div>

    <template v-else>
      <div class="st-form">
        <div class="st-field grow">
          <label class="st-label">查询文本</label>
          <input
            v-model="query"
            type="text"
            placeholder="例: 谁是凶手？图书馆里有什么线索？"
            class="st-input"
            @keydown.enter="runSearch"
          />
        </div>
        <div class="st-field">
          <label class="st-label">TopK</label>
          <input
            v-model.number="topK"
            type="number"
            min="1"
            max="30"
            step="1"
            class="st-topk"
          />
        </div>
        <div class="st-field">
          <label class="st-label">模式</label>
          <select v-model="mode" class="st-select">
            <option value="chunks">Raw Chunks</option>
            <option value="context">Formatted Context</option>
          </select>
        </div>
        <button
          :disabled="running || !query.trim()"
          class="st-run"
          @click="runSearch"
        >
          {{ running ? '查询中...' : '搜索' }}
        </button>
      </div>

      <div v-if="elapsed" class="st-elapsed">耗时 {{ elapsed }}ms</div>

      <!-- Chunk 结果 -->
      <div v-if="mode === 'chunks' && chunkResults.length" class="st-results">
        <div
          v-for="(c, i) in chunkResults"
          :key="i"
          class="st-result"
        >
          <div class="st-result-head">
            <span class="st-rank">#{{ i + 1 }}</span>
            <span class="st-distance">distance: {{ c.distance.toFixed(4) }}</span>
            <span
              v-for="(mv, mk) in c.metadata"
              :key="String(mk)"
              class="st-meta-tag"
            >
              {{ mk }}: {{ mv }}
            </span>
          </div>
          <pre class="st-pre">{{ c.content }}</pre>
        </div>
      </div>

      <!-- Context 结果 -->
      <div v-if="mode === 'context' && contextResult" class="st-result">
        <pre class="st-pre-lg">{{ contextResult }}</pre>
      </div>

      <div v-if="!running && elapsed && !chunkResults.length && !contextResult" class="st-state dim">
        无结果
      </div>
    </template>
  </div>
  <!-- #endif -->
  <!-- #ifndef H5 -->
  <text class="h5-only-hint">仅 H5 可用</text>
  <!-- #endif -->
</template>

<style scoped lang="scss">
.h5-only-hint {
  display: block;
  padding: 16px;
  color: $c-ash;
  font-size: 12px;
}

.st-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.st-state {
  text-align: center;
  padding: 32px 0;
  color: $c-fog;
  font-size: 0.875rem;
}
.st-state.dim {
  color: $c-ash;
}

.st-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
}
.st-field {
  display: flex;
  flex-direction: column;
}
.st-field.grow {
  flex: 1;
  min-width: 220px;
}
.st-label {
  display: block;
  font-size: 12px;
  color: $c-fog;
  margin-bottom: 4px;
}
.st-input {
  width: 100%;
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
  outline: none;
}
.st-input:focus {
  border-color: $c-mana-300;
}
.st-topk {
  width: 80px;
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
}
.st-select {
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
}
.st-run {
  padding: 6px 16px;
  background: hsl(221, 83%, 53%);
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
}
.st-run:hover:not(:disabled) {
  background: hsl(217, 91%, 60%);
}
.st-run:disabled {
  background: $c-slate;
  color: $c-ash;
}

.st-elapsed {
  font-size: 12px;
  color: $c-ash;
}

.st-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.st-result {
  padding: 12px;
  background: hsla(220, 16%, 11%, 0.6);
  border-radius: 6px;
  border: 1px solid $c-slate;
}
.st-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.st-rank {
  font-size: 12px;
  color: $c-mana-200;
  font-family: $font-mono;
}
.st-distance {
  font-size: 12px;
  color: $c-ritual-200;
}
.st-meta-tag {
  font-size: 12px;
  background: $c-slate;
  padding: 2px 6px;
  border-radius: 4px;
  color: $c-parchment-300;
}
.st-pre {
  font-size: 12px;
  color: $c-parchment-300;
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
  font-family: $font-mono;
}
.st-pre-lg {
  font-size: 12px;
  color: $c-parchment-300;
  white-space: pre-wrap;
  max-height: 60vh;
  overflow: auto;
  font-family: $font-mono;
}
</style>
