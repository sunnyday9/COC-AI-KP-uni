<script setup lang="ts">
import { ref, computed } from 'vue'

/**
 * GraphRAG 浏览器（Task 9，迁移自 original/ai-trpg-web/src/components/rag/GraphBrowser.vue）。
 * 仅 H5 上下文使用（RAG Inspector 页面为 H5-only）。原组件无 canvas/SVG 渲染
 * （节点/关系边/社区摘要均为表格与列表），故无渲染层适配需求。
 */

interface GraphNode {
  id: string; type: string; name: string; content: string
  communityId: string | null; chunkIds: string[]
}
interface GraphEdge {
  source: string; target: string; type: string; label: string
}
interface GraphData {
  scriptId: string; storyName: string; indexedAt: number
  nodeCount: number; edgeCount: number
  nodes: GraphNode[]; edges: GraphEdge[]
  communitySummaries: Record<string, string>
}

const props = defineProps<{ graph: GraphData | null; loading: boolean }>()

type Tab = 'nodes' | 'edges' | 'communities'
const tab = ref<Tab>('nodes')
const nodeTypeFilter = ref('')
const nodeSearch = ref('')
const selectedNodeId = ref<string | null>(null)

const nodeTypes = computed(() => {
  if (!props.graph) return []
  return [...new Set(props.graph.nodes.map(n => n.type))].sort()
})

const filteredNodes = computed(() => {
  if (!props.graph) return []
  let list = props.graph.nodes
  if (nodeTypeFilter.value) list = list.filter(n => n.type === nodeTypeFilter.value)
  if (nodeSearch.value) {
    const q = nodeSearch.value.toLowerCase()
    list = list.filter(n => n.name.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
  }
  return list
})

const selectedNode = computed(() => {
  if (!selectedNodeId.value || !props.graph) return null
  return props.graph.nodes.find(n => n.id === selectedNodeId.value) || null
})

const selectedNodeEdges = computed(() => {
  if (!selectedNodeId.value || !props.graph) return []
  return props.graph.edges.filter(e => e.source === selectedNodeId.value || e.target === selectedNodeId.value)
})

const communityEntries = computed(() => {
  if (!props.graph?.communitySummaries) return []
  return Object.entries(props.graph.communitySummaries).filter(([, v]) => v)
})

function nodeColorClass(type: string) {
  const map: Record<string, string> = {
    person: 'node-person', location: 'node-location', item: 'node-item',
    event: 'node-event', creature: 'node-creature', organization: 'node-org',
    clue: 'node-clue',
  }
  return map[type] || 'node-default'
}
</script>

<template>
  <!-- #ifdef H5 -->
  <div class="gb-root">
    <div v-if="loading" class="gb-state">加载中...</div>
    <div v-else-if="!graph" class="gb-state dim">无 GraphRAG 数据</div>

    <template v-else>
      <div class="gb-stats">
        <span>节点: <strong>{{ graph.nodeCount }}</strong></span>
        <span>边: <strong>{{ graph.edgeCount }}</strong></span>
        <span>社区: <strong>{{ communityEntries.length }}</strong></span>
        <span>索引时间: {{ new Date(graph.indexedAt).toLocaleString() }}</span>
      </div>

      <div class="gb-tabs">
        <button
          v-for="t in (['nodes', 'edges', 'communities'] as Tab[])"
          :key="t"
          :class="['gb-tab', tab === t ? 'gb-tab-on' : 'gb-tab-off']"
          @click="tab = t"
        >
          {{ t === 'nodes' ? '节点' : t === 'edges' ? '关系边' : '社区摘要' }}
        </button>
      </div>

      <!-- 节点 -->
      <div v-if="tab === 'nodes'" class="gb-section">
        <div class="gb-filters">
          <input
            v-model="nodeSearch"
            type="text"
            placeholder="搜索节点名称..."
            class="gb-input"
          />
          <select v-model="nodeTypeFilter" class="gb-select">
            <option value="">全部类型</option>
            <option v-for="t in nodeTypes" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>

        <div class="gb-node-grid">
          <div
            v-for="node in filteredNodes"
            :key="node.id"
            :class="['gb-node', selectedNodeId === node.id ? 'gb-node-on' : 'gb-node-off']"
            @click="selectedNodeId = selectedNodeId === node.id ? null : node.id"
          >
            <div class="gb-node-head">
              <span :class="['gb-node-type', nodeColorClass(node.type)]">{{ node.type }}</span>
              <span class="gb-node-name">{{ node.name }}</span>
            </div>
            <div class="gb-node-preview">{{ node.content.slice(0, 100) }}</div>
          </div>
        </div>

        <div v-if="selectedNode" class="gb-node-detail">
          <div class="gb-node-detail-title">{{ selectedNode.name }} ({{ selectedNode.type }})</div>
          <pre class="gb-pre">{{ selectedNode.content }}</pre>
          <div class="gb-node-meta">
            Community: {{ selectedNode.communityId || 'N/A' }} · 关联 Chunks: {{ selectedNode.chunkIds.join(', ') || 'N/A' }}
          </div>
          <div v-if="selectedNodeEdges.length" class="gb-edges-for-node">
            <div class="gb-edges-label">关系 ({{ selectedNodeEdges.length }}):</div>
            <div v-for="(e, i) in selectedNodeEdges" :key="i" class="gb-edge-row">
              <span class="gb-edge-node">{{ e.source }}</span>
              <span class="gb-edge-type">--[{{ e.type }}]--></span>
              <span class="gb-edge-node">{{ e.target }}</span>
              <span v-if="e.label" class="gb-edge-label">({{ e.label }})</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 关系边 -->
      <div v-if="tab === 'edges'" class="gb-scroll">
        <table class="gb-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th>Target</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(e, i) in graph.edges"
              :key="i"
              class="gb-tr"
            >
              <td class="gb-td">{{ e.source }}</td>
              <td class="gb-td gb-td-type">{{ e.type }}</td>
              <td class="gb-td">{{ e.target }}</td>
              <td class="gb-td gb-td-label">{{ e.label }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 社区摘要 -->
      <div v-if="tab === 'communities'" class="gb-scroll gb-communities">
        <div v-if="!communityEntries.length" class="gb-comm-empty">无社区摘要</div>
        <div
          v-for="[cid, summary] in communityEntries"
          :key="cid"
          class="gb-comm-card"
        >
          <div class="gb-comm-id">{{ cid }}</div>
          <div class="gb-comm-summary">{{ summary }}</div>
        </div>
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

.gb-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gb-state {
  text-align: center;
  padding: 32px 0;
  color: $c-fog;
  font-size: 0.875rem;
}
.gb-state.dim {
  color: $c-ash;
}

.gb-stats {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: $c-fog;
}
.gb-stats strong {
  color: $c-parchment-200;
}

.gb-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid $c-slate;
}
.gb-tab {
  padding: 6px 12px;
  font-size: 0.875rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.gb-tab-on {
  color: $c-mana-200;
  border-bottom-color: $c-mana-300;
}
.gb-tab-off {
  color: $c-fog;
}
.gb-tab-off:hover {
  color: $c-parchment-200;
}

.gb-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gb-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.gb-input {
  flex: 1;
  min-width: 180px;
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
  outline: none;
}
.gb-input:focus {
  border-color: $c-mana-300;
}
.gb-select {
  background: $c-obsidian;
  border: 1px solid $c-slate-light;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.875rem;
  color: $c-parchment-200;
}

.gb-node-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  max-height: 60vh;
  overflow: auto;
}
@media (min-width: 768px) {
  .gb-node-grid {
    grid-template-columns: 1fr 1fr;
  }
}
.gb-node {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid $c-slate;
  cursor: pointer;
  transition: border-color 0.15s;
}
.gb-node-on {
  border-color: $c-mana-300;
  background: $c-obsidian;
}
.gb-node-off {
  background: hsla(220, 16%, 11%, 0.4);
}
.gb-node-off:hover {
  border-color: $c-slate-light;
}
.gb-node-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gb-node-type {
  font-size: 12px;
  font-family: $font-mono;
}
.node-person { color: $c-mana-200; }
.node-location { color: $c-eldritch-200; }
.node-item { color: $c-sanity-200; }
.node-event { color: $c-ritual-200; }
.node-creature { color: $c-blood-200; }
.node-org { color: hsl(189, 94%, 53%); }
.node-clue { color: hsl(48, 96%, 53%); }
.node-default { color: $c-fog; }
.gb-node-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: $c-parchment-200;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gb-node-preview {
  font-size: 12px;
  color: $c-fog;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gb-node-detail {
  margin-top: 12px;
  padding: 12px;
  background: $c-obsidian;
  border-radius: 6px;
  border: 1px solid hsla(217, 91%, 60%, 0.5);
}
.gb-node-detail-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: $c-parchment-200;
  margin-bottom: 8px;
}
.gb-pre {
  font-size: 12px;
  color: $c-parchment-300;
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
  font-family: $font-mono;
}
.gb-node-meta {
  margin-top: 8px;
  font-size: 12px;
  color: $c-fog;
}
.gb-edges-for-node {
  margin-top: 8px;
}
.gb-edges-label {
  font-size: 12px;
  color: $c-ash;
  margin-bottom: 4px;
}
.gb-edge-row {
  font-size: 12px;
  color: $c-parchment-300;
}
.gb-edge-node {
  color: $c-ash;
}
.gb-edge-type {
  color: $c-ritual-200;
  margin: 0 4px;
}
.gb-edge-label {
  color: $c-ash;
  margin-left: 4px;
}

.gb-scroll {
  max-height: 60vh;
  overflow: auto;
}
.gb-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}
.gb-table th {
  text-align: left;
  padding: 6px 8px;
  color: $c-fog;
  border-bottom: 1px solid $c-slate;
  position: sticky;
  top: 0;
  background: $c-abyss;
}
.gb-tr {
  border-bottom: 1px solid $c-obsidian;
}
.gb-tr:hover {
  background: hsla(220, 16%, 11%, 0.6);
}
.gb-td {
  padding: 4px 8px;
  color: $c-parchment-300;
}
.gb-td-type {
  color: $c-ritual-200;
}
.gb-td-label {
  color: $c-ash;
}

.gb-communities {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gb-comm-empty {
  color: $c-ash;
  font-size: 0.875rem;
  text-align: center;
  padding: 16px 0;
}
.gb-comm-card {
  padding: 12px;
  background: hsla(220, 16%, 11%, 0.6);
  border-radius: 6px;
  border: 1px solid $c-slate;
}
.gb-comm-id {
  font-size: 12px;
  color: hsl(189, 94%, 53%);
  font-family: $font-mono;
  margin-bottom: 4px;
}
.gb-comm-summary {
  font-size: 0.875rem;
  color: $c-parchment-300;
  white-space: pre-wrap;
}
</style>
