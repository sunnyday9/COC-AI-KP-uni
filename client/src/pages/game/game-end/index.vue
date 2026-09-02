<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { useRoomStore } from '../../../stores/roomStore'
import { downloadText } from '../../../utils/downloadText'
import AppLayout from '../../../components/layout/AppLayout.vue'
import CharacterSheetCard from '../../../components/domain/CharacterSheetCard.vue'

/** 结局数据来自房间事件流（end_game → state_patch/ending，ADR-0002）。 */
const roomStore = useRoomStore()

interface EndingView {
  title?: string
  outcome?: string
  summary?: string
  storyName?: string
  endedAt?: number
  keyFacts?: string[]
  epilogueOptions?: string[]
  scenesVisited?: string[]
  cluesObtained?: string[]
  finalSnapshot?: Record<string, unknown>
}

const storyName = ref('')
const endingState = computed(() => (roomStore.ending as EndingView | null) ?? null)
const storyId = computed(() => roomStore.storyId)
const playerName = computed(() => roomStore.selfName)
/** 调查员最终状态档案卡（T3：CharacterSheetCard 三处复用之一 —— game-end 最终态） */
const charSheet = computed(() => roomStore.selfCharacterSheet)

/**
 * 背景图（Task 9 分包）：H5 走主包 public 目录；MP 子包页面引用子包内 static。
 */
// #ifdef H5
const pageBg = '/static/bg/bg_end.webp'
// #endif
// #ifndef H5
const pageBg = '/pages/game/static/bg_end.webp'
// #endif

const exporting = ref(false)

const title = computed(() => endingState.value?.title || '结局')
const outcome = computed(() => endingState.value?.outcome || 'unknown')
const summary = computed(() => endingState.value?.summary || '')

const outcomeLabel = computed(() => {
  const o = outcome.value
  if (o === 'victory') return '胜利'
  if (o === 'defeat') return '失败'
  if (o === 'partial') return '部分成功'
  if (o === 'survival') return '幸存'
  return '未知'
})

const outcomeColor = computed(() => {
  const o = outcome.value
  // T9 结局分级视觉（文本/边框走令牌；glow 为 rgba 字面量供 boxShadow 拼接）
  if (o === 'victory') return { text: 'var(--c-ritual-200)', border: 'var(--c-ritual-500)', glow: 'hsla(42, 70%, 50%, 0.12)' }
  if (o === 'defeat') return { text: 'var(--c-blood-200)', border: 'var(--c-blood-500)', glow: 'hsla(0, 65%, 45%, 0.12)' }
  if (o === 'survival') return { text: 'var(--c-eld-200)', border: 'var(--c-eld-500)', glow: 'hsla(165, 60%, 40%, 0.12)' }
  return { text: 'var(--c-sanity-200)', border: 'var(--c-sanity-500)', glow: 'hsla(260, 55%, 50%, 0.12)' }
})

function buildMarkdownReport(): string {
  const e = endingState.value
  if (!e) return '# 结局报告\n\n(无结局数据)\n'
  const lines: string[] = []
  lines.push(`# 结局报告：${e.title}`)
  lines.push('')
  lines.push(`- **故事**: ${e.storyName || storyName.value || storyId.value || ''}`)
  lines.push(`- **调查员**: ${playerName.value || ''}`)
  lines.push(`- **结局**: ${outcomeLabel.value} (${e.outcome})`)
  lines.push(`- **结束时间**: ${new Date(e.endedAt).toLocaleString('zh-CN')}`)
  lines.push('')
  lines.push('## 总结')
  lines.push(e.summary)
  lines.push('')
  if (e.keyFacts?.length) {
    lines.push('## 关键事实 / 真相')
    for (const f of e.keyFacts) lines.push(`- ${f}`)
    lines.push('')
  }
  if (e.epilogueOptions?.length) {
    lines.push('## 尾声 / 后续选项')
    for (const o of e.epilogueOptions) lines.push(`- ${o}`)
    lines.push('')
  }
  if (e.scenesVisited?.length) {
    lines.push('## 到访场景')
    for (const s of e.scenesVisited) lines.push(`- ${s}`)
    lines.push('')
  }
  if (e.cluesObtained?.length) {
    lines.push('## 获得线索')
    for (const c of e.cluesObtained) lines.push(`- ${c}`)
    lines.push('')
  }
  if (e.finalSnapshot) {
    lines.push('## 最终状态')
    const fs = e.finalSnapshot
    lines.push(`- HP: ${fs.hp ?? '?'} / ${fs.hpMax ?? '?'}`)
    lines.push(`- SAN: ${fs.san ?? '?'} / ${fs.sanMax ?? '?'}`)
    lines.push(`- MP: ${fs.mp ?? '?'} / ${fs.mpMax ?? '?'}`)
    if (fs.luck != null) lines.push(`- Luck: ${fs.luck}`)
    if (fs.insanityState) lines.push(`- Insanity: ${fs.insanityState}`)
    if (fs.dailySanLoss != null) lines.push(`- Daily SAN Loss: ${fs.dailySanLoss}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function exportReport() {
  exporting.value = true
  try {
    const md = buildMarkdownReport()
    const json = JSON.stringify(endingState.value ?? {}, null, 2)
    // 原 Blob 下载（DOM）→ downloadText：H5 下载文件，其他端复制到剪贴板
    downloadText(`ending-report-${Date.now()}.md`, md, 'text/markdown;charset=utf-8')
    downloadText(`ending-report-${Date.now()}.json`, json, 'application/json;charset=utf-8')
  } finally {
    exporting.value = false
  }
}

function startNew() {
  roomStore.leaveRoom()
  uni.reLaunch({ url: '/pages/home/index' })
}

function goGame() {
  const rid = roomStore.roomId
  if (rid) uni.redirectTo({ url: `/pages/game/index?roomId=${encodeURIComponent(rid)}&storyName=${encodeURIComponent(storyName.value)}` })
  else uni.reLaunch({ url: '/pages/home/index' })
}

function goScripts() {
  uni.navigateTo({ url: '/pages/scripts/index' })
}

function goSettings() {
  uni.navigateTo({ url: '/pages/settings/index' })
}

// 房间上下文（ADR-0002）：经参数或已加入的 roomStore 进入；未结束局回游戏页
onLoad((options) => {
  const rid = String(options?.roomId ?? roomStore.roomId ?? '')
  storyName.value = decodeURIComponent(String(options?.storyName ?? ''))
  if (!rid) {
    try { uni.reLaunch({ url: '/pages/home/index' }) } catch { /* 导航失败不抛出 */ }
    return
  }
  if (roomStore.roomId !== rid) void roomStore.joinRoom(rid)
})
onShow(() => {
  if (roomStore.roomId && roomStore.phase !== 'ended') {
    goGame()
  }
})
</script>

<template>
  <app-layout active="game" :bg="pageBg" :overlay="0.8">
    <view class="page-root">
      <view class="ending-card" :style="{ borderColor: outcomeColor.border, boxShadow: '0 10px 40px ' + outcomeColor.glow }">
        <view class="card-head">
          <view class="head-text">
            <text class="ending-title" :style="{ color: outcomeColor.text, textShadow: '0 0 20px ' + outcomeColor.glow }">
              {{ title }}
            </text>
            <text class="ending-meta">{{ outcomeLabel }} · {{ storyName || storyId }} · {{ playerName }}</text>
          </view>
          <view class="head-actions">
            <button class="gothic-btn-secondary head-btn" @click="goGame">回看对话</button>
            <button class="gothic-btn head-btn" :class="{ 'is-disabled': exporting }" @click="exportReport">
              {{ exporting ? '导出中...' : '导出报告' }}
            </button>
          </view>
        </view>

        <view class="card-divider ink-divider" />

        <view class="summary-grid">
          <view class="summary-col">
            <text class="block-title">结局总结</text>
            <view class="summary-card">
              <text decode>{{ summary || '（无结局摘要）' }}</text>
            </view>
          </view>
          <view class="side-col">
            <view v-if="charSheet" class="char-sheet-wrap">
              <text class="block-title">调查员最终状态</text>
              <character-sheet-card :sheet="charSheet" />
            </view>
            <view v-if="endingState?.keyFacts?.length" class="info-card">
              <text class="block-title">关键事实</text>
              <view class="list">
                <text v-for="(f, idx) in endingState.keyFacts" :key="idx" class="list-item">- {{ f }}</text>
              </view>
            </view>
            <view v-if="endingState?.epilogueOptions?.length" class="info-card">
              <text class="block-title">尾声选项</text>
              <view class="list">
                <text v-for="(o, idx) in endingState.epilogueOptions" :key="idx" class="list-item">- {{ o }}</text>
              </view>
            </view>
            <view class="info-card">
              <text class="block-title">下一步</text>
              <view class="next-actions">
                <button class="gothic-btn next-btn" @click="startNew">开始新游戏</button>
                <button class="gothic-btn-secondary next-btn" @click="goScripts">故事管理</button>
                <button class="gothic-btn-secondary next-btn" @click="goSettings">设置</button>
              </view>
            </view>
          </view>
        </view>

        <view class="lower-grid">
          <view class="info-card">
            <text class="block-title">到访场景</text>
            <view v-if="endingState?.scenesVisited?.length" class="list">
              <text v-for="(s, idx) in endingState.scenesVisited" :key="idx" class="list-item">- {{ s }}</text>
            </view>
            <text v-else class="none-text">（无记录）</text>
          </view>
          <view class="info-card">
            <text class="block-title">获得线索</text>
            <view v-if="endingState?.cluesObtained?.length" class="list scroll-list">
              <text v-for="(c, idx) in endingState.cluesObtained" :key="idx" class="list-item">- {{ c }}</text>
            </view>
            <text v-else class="none-text">（无记录）</text>
          </view>
        </view>
      </view>
    </view>
  </app-layout>
</template>

<style scoped lang="scss">
.page-root {
  padding: 40px 24px;
  max-width: 896px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.ending-card {
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid;
  border-radius: 0.5rem;
  padding: 24px 32px;
}
@media (min-width: 768px) {
  .ending-card { padding: 32px; }
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.head-text { min-width: 0; }
.ending-title {
  display: block;
  font-family: $font-display;
  font-size: 1.5rem;
  letter-spacing: 0.05em;
  word-break: break-all;
}
.ending-meta {
  display: block;
  margin-top: 8px;
  font-size: 0.875rem;
  color: hsl(220, 10%, 65%);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.head-btn {
  font-size: 0.875rem;
}

.card-divider {
  margin: 24px 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 768px) {
  .summary-grid {
    grid-template-columns: 2fr 1fr;
  }
}
.block-title {
  display: block;
  font-family: $font-display;
  font-size: 1.125rem;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
  color: hsl(38, 50%, 88%);
}
.summary-card {
  padding: 20px;
  border-radius: 8px;
  font-size: 0.875rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: $font-serif;
  background: hsla(38, 18%, 18%, 0.2);
  border: 1px solid hsla(38, 20%, 30%, 0.2);
  color: hsl(38, 40%, 78%);
}
.side-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.char-sheet-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-radius: 8px;
  background: hsla(38, 18%, 18%, 0.25);
  border: 1px solid hsla(38, 20%, 30%, 0.25);
}
.info-card {
  padding: 16px;
  border-radius: 8px;
  background: hsla(220, 16%, 11%, 0.5);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.list-item {
  font-size: 12px;
  line-height: 1.6;
  color: hsl(38, 30%, 65%);
}
.none-text {
  font-size: 12px;
  font-family: $font-serif;
  font-style: italic;
  color: hsl(220, 10%, 22%);
}
.next-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.next-btn {
  width: 100%;
  font-size: 0.875rem;
}

.lower-grid {
  margin-top: 24px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 768px) {
  .lower-grid {
    grid-template-columns: 1fr 1fr;
  }
}
.scroll-list {
  max-height: 160px;
  overflow-y: auto;
  padding-right: 4px;
}
</style>
