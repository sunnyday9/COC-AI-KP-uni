<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useDebugStore } from '../../../stores/debugStore'
import type { TraceEvent, Trace } from '../../../services/tracing'
import { downloadText } from '../../../utils/downloadText'

const debug = useDebugStore()

type Tab = 'live' | 'traces' | 'export'
const tab = ref<Tab>('live')
const autoScroll = ref(true)
const expandedTraceId = ref<string | null>(null)
const expandedEventId = ref<string | null>(null)

// 自动滚底：scroll-into-view 指向最后一条事件的锚点 id（替代原 scrollTo）
const lastEventAnchor = ref('')
watch(() => debug.liveEvents.length, () => {
  if (autoScroll.value && debug.liveEvents.length > 0) {
    lastEventAnchor.value = 'evt_' + debug.liveEvents[debug.liveEvents.length - 1].id
  }
})

onMounted(() => {
  if (!debug.enabled) {
    debug.setEnabled(true)
  }
  // 拦截 Ctrl+Shift+D（防止与游戏页快捷键冲突时双重触发展开）
  // #ifdef H5
  document.addEventListener('keydown', handleKeydown)
  // #endif
})

onUnmounted(() => {
  // #ifdef H5
  document.removeEventListener('keydown', handleKeydown)
  // #endif
})

function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault()
  }
}

const liveEvents = computed(() => debug.liveEvents)
const traces = computed(() => debug.traces)

function spanColor(span: string): string {
  const map: Record<string, string> = {
    rag_retrieval: 'c-cyan',
    prompt_assembly: 'c-purple',
    kp_agent: 'c-blue',
    tool_execution: 'c-amber',
    state_update: 'c-green',
    long_term_summary: 'c-pink',
  }
  return map[span] || 'c-gray'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(trace: Trace): string {
  if (!trace.endTime) return 'running...'
  return `${trace.endTime - trace.startTime}ms`
}

function eventSummary(evt: TraceEvent): string {
  const d = evt.data
  switch (evt.eventType) {
    case 'rag_query_sent': return `query="${(d.query as string)?.slice(0, 40)}..." topK=${d.topK}`
    case 'rag_context_received': return `len=${d.contextLength} graph=${d.hasGraphSummary}`
    case 'intent_classified': return `intent=${d.intent}`
    case 'agent_routed': return `→ ${d.agentType}`
    case 'tool_plan_created': return `tools=[${(d.requiredTools as string[])?.join(',')}]`
    case 'llm_generate_end': return `${d.responseLength}chars ${d.durationMs}ms tools=${d.toolCallCount}`
    case 'validation_result': return `${d.result} missing=[${(d.missingTools as string[])?.join(',')}]`
    case 'tool_executed': return `${d.name}(${d.success ? 'ok' : 'FAIL'}) ${d.durationMs}ms`
    case 'character_snapshot': return `HP=${d.hp}/${d.hpMax} SAN=${d.san}/${d.sanMax} MP=${d.mp}/${d.mpMax}`
    case 'scene_changed': return `${d.from} → ${d.to}`
    case 'clue_added': return `"${(d.description as string)?.slice(0, 40)}"`
    case 'memory_updated': return `len=${d.kpMemoryLength}`
    case 'summary_output': return `${d.newSummaryLength}chars`
    case 'trace_error': return `[${d.source}] ${(d.message as string)?.slice(0, 50)}`
    default: return JSON.stringify(d).slice(0, 60)
  }
}

function handleExport() {
  const json = debug.exportTraces()
  downloadText(`kptrace-${Date.now()}.json`, json, 'application/json;charset=utf-8')
}
</script>

<template>
  <view class="debug-panel">
    <!-- 头部 -->
    <view class="panel-header">
      <text class="header-title">KPTRACE</text>
      <view class="tabs">
        <view
          v-for="t in (['live', 'traces', 'export'] as Tab[])"
          :key="t"
          class="tab"
          :class="tab === t ? 'tab-active' : 'tab-dim'"
          @click="tab = t"
        >
          {{ t === 'live' ? 'Live' : t === 'traces' ? 'Traces' : 'Export' }}
        </view>
      </view>
      <view class="spacer" />
      <text class="count-label">{{ liveEvents.length }} events · {{ traces.length }} traces</text>
      <view class="autoscroll" @click="autoScroll = !autoScroll">
        <view class="checkbox" :class="autoScroll ? 'checked' : ''">
          <text v-if="autoScroll" class="check-mark">✓</text>
        </view>
        <text>Auto-scroll</text>
      </view>
      <text class="clear-btn" @click="debug.clearHistory()">Clear</text>
    </view>

    <!-- 实时事件 -->
    <scroll-view v-if="tab === 'live'" class="panel-body" :scroll-into-view="lastEventAnchor" scroll-y>
      <view v-if="!liveEvents.length" class="empty">Waiting for events... Send a message to start tracing.</view>
      <view
        v-for="evt in liveEvents"
        :id="'evt_' + evt.id"
        :key="evt.id"
        class="evt-row"
        @click="expandedEventId = expandedEventId === evt.id ? null : evt.id"
      >
        <view class="evt-line">
          <text class="evt-time">{{ formatTime(evt.timestamp) }}</text>
          <text class="evt-span" :class="spanColor(evt.spanName)">{{ evt.spanName }}</text>
          <text class="evt-type">{{ evt.eventType }}</text>
          <text class="evt-summary">{{ eventSummary(evt) }}</text>
        </view>
        <view v-if="expandedEventId === evt.id" class="evt-detail">
          <text class="evt-json">{{ JSON.stringify(evt.data, null, 2) }}</text>
        </view>
      </view>
    </scroll-view>

    <!-- 追踪历史 -->
    <scroll-view v-if="tab === 'traces'" class="panel-body" scroll-y>
      <view v-if="!traces.length" class="empty">No completed traces yet.</view>
      <view v-for="trace in [...traces].reverse()" :key="trace.id" class="trace-block">
        <view class="trace-head" @click="expandedTraceId = expandedTraceId === trace.id ? null : trace.id">
          <text class="evt-time">{{ formatTime(trace.startTime) }}</text>
          <text class="c-blue trace-id">{{ trace.id.slice(0, 12) }}</text>
          <text class="trace-meta">{{ trace.events.length }} events</text>
          <text class="trace-meta">{{ formatDuration(trace) }}</text>
          <view class="spacer" />
          <view class="span-chips">
            <text
              v-for="[name] in trace.spans"
              :key="name"
              class="span-chip"
              :class="spanColor(name)"
            >
              {{ name.replace(/_/g, ' ') }}
            </text>
          </view>
        </view>
        <view v-if="expandedTraceId === trace.id" class="trace-detail">
          <view v-for="[spanName, span] in trace.spans" :key="spanName" class="span-block">
            <text class="span-title" :class="spanColor(spanName)">
              {{ spanName }} ({{ span.events.length }} events, {{ (span.endTime || Date.now()) - span.startTime }}ms)
            </text>
            <view v-for="evt in span.events" :key="evt.id" class="span-evt">
              <text class="evt-time">+{{ evt.timestamp - trace.startTime }}ms</text>
              <text class="span-evt-type">{{ evt.eventType }}</text>
              <text class="evt-summary">{{ eventSummary(evt) }}</text>
            </view>
          </view>
        </view>
      </view>
    </scroll-view>

    <!-- 导出 -->
    <view v-if="tab === 'export'" class="panel-body export-body">
      <text class="export-hint">Export all trace data as JSON for offline analysis.</text>
      <button class="export-btn" @click="handleExport">Download Traces ({{ traces.length }})</button>
      <view class="preview-block">
        <text class="preview-label">Preview (latest trace):</text>
        <text v-if="debug.latestTrace" class="preview-json">{{ JSON.stringify({
          ...debug.latestTrace,
          spans: Object.fromEntries(debug.latestTrace.spans),
        }, null, 2).slice(0, 2000) }}...</text>
        <text v-else class="empty">No traces yet.</text>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
/* 原 Tailwind gray 系色板（Debug 面板为 dev-only 工具，独立于主题色） */
$g950: #030712;
$g900: #111827;
$g800: #1f2937;
$g700: #374151;
$g600: #4b5563;
$g500: #6b7280;
$g400: #9ca3af;
$g300: #d1d5db;
$cyan: #22d3ee;
$purple: #a78bfa;
$blue: #60a5fa;
$amber: #fbbf24;
$green: #34d399;
$pink: #f472b6;

.debug-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: $g950;
  color: $g300;
  font-size: 12px;
  font-family: $font-mono;
  /* 桌面端：右侧固定面板（H5） */
  /* #ifdef H5 */
  width: 420px;
  border-left: 1px solid $g800;
  /* #endif */
  /* #ifndef H5 */
  width: 100%;
  /* #endif */
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid $g800;
  background: rgba(17, 24, 39, 0.8);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.header-title {
  color: $amber;
  font-weight: bold;
  font-size: 10px;
  letter-spacing: 0.05em;
}
.tabs {
  display: flex;
  gap: 2px;
  margin-left: 8px;
}
.tab {
  padding: 2px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}
.tab-active {
  background: $g700;
  color: #fff;
}
.tab-dim {
  color: $g500;
}
.spacer { flex: 1; }
.count-label {
  font-size: 10px;
  color: $g600;
}
.autoscroll {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: $g500;
}
.checkbox {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: $g800;
  border: 1px solid $g600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.checked {
  background: $blue;
  border-color: $blue;
}
.check-mark {
  font-size: 9px;
  color: #fff;
}
.clear-btn {
  font-size: 10px;
  color: $g600;
  padding: 0 4px;
}
.clear-btn:active {
  color: #f87171;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.export-body {
  padding: 12px;
  overflow-y: auto;
}
.empty {
  color: $g600;
  text-align: center;
  padding: 32px 0;
  font-size: 12px;
}
.evt-row {
  padding: 2px 12px;
  border-bottom: 1px solid rgba(17, 24, 39, 0.4);
}
.evt-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.evt-time {
  color: $g600;
  width: 64px;
  flex-shrink: 0;
  font-size: 11px;
}
.evt-span {
  width: 112px;
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}
.evt-type {
  color: $g400;
  width: 144px;
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}
.evt-summary {
  color: $g500;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}
.evt-detail {
  margin: 4px 0 4px 64px;
}
.evt-json {
  display: block;
  font-size: 10px;
  color: $g400;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
  background: $g900;
  border-radius: 4px;
  padding: 8px;
}

.trace-block {
  border-bottom: 1px solid $g800;
}
.trace-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
}
.trace-id {
  flex-shrink: 0;
  font-size: 11px;
}
.trace-meta {
  color: $g500;
  font-size: 11px;
}
.span-chips {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
}
.span-chip {
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(31, 41, 55, 0.6);
  font-size: 9px;
}
.trace-detail {
  padding: 0 12px 8px;
}
.span-block {
  margin-left: 16px;
}
.span-title {
  display: block;
  font-weight: bold;
  font-size: 10px;
  margin-bottom: 2px;
}
.span-evt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0 2px 16px;
  font-size: 10px;
}
.span-evt-type {
  color: $g400;
  width: 128px;
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.export-hint {
  display: block;
  color: $g500;
  margin-bottom: 8px;
}
.export-btn {
  padding: 6px 12px;
  background: #2563eb;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  line-height: 1.5;
}
.export-btn:active {
  background: #3b82f6;
}
.preview-block {
  margin-top: 12px;
}
.preview-label {
  display: block;
  color: $g600;
  margin-bottom: 4px;
  font-size: 11px;
}
.preview-json {
  display: block;
  font-size: 10px;
  color: $g500;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
  background: $g900;
  border-radius: 4px;
  padding: 8px;
}

/* 跨度颜色 */
.c-cyan { color: $cyan; }
.c-purple { color: $purple; }
.c-blue { color: $blue; }
.c-amber { color: $amber; }
.c-green { color: $green; }
.c-pink { color: $pink; }
.c-gray { color: $g400; }
</style>
