<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { storeToRefs } from 'pinia'
import { useRoomStore } from '../../stores/roomStore'
import { useSettingsStore } from '../../stores/settingsStore'
import ChatMessage from './components/ChatMessage.vue'
import PlayerStatsBar from './components/PlayerStatsBar.vue'
import AppLayout from '../../components/layout/AppLayout.vue'

const roomStore = useRoomStore()
const settingsStore = useSettingsStore()

/**
 * 背景图（Task 9 分包）：H5 走主包 public 目录（src/static/bg，H5 仅拷贝该目录）；
 * MP 子包页面引用子包内 static（pages/game/static，WeChat 子包可引用自身资源）。
 */
// #ifdef H5
const pageBg = '/static/bg/bg_game.webp'
// #endif
// #ifndef H5
const pageBg = '/pages/game/static/bg_game.webp'
// #endif

/** 页面级故事名（从导航参数带入；服务端权威是 roomStore.storyId）。 */
const storyName = ref('')

const { messages } = storeToRefs(roomStore)
const isEnded = computed(() => roomStore.phase === 'ended')
const playerName = computed(() => roomStore.selfName)
const currentScene = computed(() => roomStore.scene)
const cluesObtained = computed(() => roomStore.clues)
const isJoined = computed(() => roomStore.connectionState === 'joined')

const inputText = ref('')
const textareaFocus = ref(false)
const lastMsgAnchor = ref('')
const cluesPanelOpen = ref(false)

/** 消息列表自动滚底：scroll-into-view 锚点 = 最后一条消息 id（替代 scrollIntoView） */
function scrollToBottom() {
  nextTick(() => {
    const last = messages.value[messages.value.length - 1]
    if (last) lastMsgAnchor.value = 'msg-' + last.id
  })
}

watch(messages, () => scrollToBottom(), { deep: true })

onLoad((options) => {
  const rid = String(options?.roomId ?? '')
  if (!rid) {
    try { uni.reLaunch({ url: '/pages/home/index' }) } catch { /* 导航失败不抛出 */ }
    return
  }
  storyName.value = decodeURIComponent(String(options?.storyName ?? ''))
  // 加入 solo 房间即续玩（ADR-0002：服务端快照权威，重进=恢复）
  void roomStore.joinRoom(rid)
})

// DebugPanel 等子组件挂载后读取设置（持久化偏好）
onMounted(() => {
  settingsStore.load().catch(() => {})
  scrollToBottom()
})

onShow(() => {
  if (isEnded.value) {
    uni.redirectTo({ url: '/pages/game/game-end/index' })
  }
})

watch(() => roomStore.phase, (p) => {
  if (p === 'ended') uni.redirectTo({ url: '/pages/game/game-end/index' })
})

function handleSend() {
  const text = inputText.value.trim()
  if (!text || isEnded.value || !isJoined.value) return
  inputText.value = ''
  roomStore.sendChat(text)
}

function handleKeydown(e: KeyboardEvent) {
  // H5 回车发送（不拦截 Shift+Enter 换行）
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function handleOptionSelected(opt: string) {
  if (isEnded.value || !isJoined.value) return
  inputText.value = opt
  textareaFocus.value = true
  nextTick(() => { textareaFocus.value = false })
}
</script>

<template>
  <app-layout active="game" :bg="pageBg" :overlay="0.8">
    <view class="game-root">
      <!-- 主聊天列 -->
      <view class="main-col">
        <!-- 顶栏 -->
        <view class="game-header">
          <view class="header-info">
            <text class="header-title">{{ storyName || roomStore.storyId || '单人局' }}</text>
            <view class="header-meta">
              <text class="header-player">{{ playerName }}</text>
              <text v-if="currentScene" class="header-scene">
                <text class="scene-icon">⛩</text>{{ currentScene }}
              </text>
            </view>
          </view>

          <button v-if="cluesObtained.length > 0" class="action-btn" @click="cluesPanelOpen = !cluesPanelOpen">
            <text>📜 线索</text>
            <text class="clue-badge">{{ cluesObtained.length }}</text>
          </button>
        </view>

        <!-- 聊天区（scroll-view 自动滚底） -->
        <scroll-view class="chat-area vignette-overlay" :scroll-into-view="lastMsgAnchor" scroll-y scroll-with-animation>
          <text v-if="messages.length === 0 && !roomStore.awaitingKp" class="chat-empty">
            "黑暗中，一个故事正在苏醒..."
          </text>
          <view
            v-for="msg in messages"
            :id="'msg-' + msg.id"
            :key="msg.id"
            class="msg-wrap"
            :class="{ 'msg-pending': msg.pending }"
          >
            <chat-message :msg="roomStore.toMessage(msg)" @select-option="handleOptionSelected" />
          </view>
          <view v-if="roomStore.awaitingKp" class="kp-pending">
            <view class="sigil-spinner small-spinner" />
            <text class="kp-pending-text">KP 推进中…</text>
          </view>
        </scroll-view>

        <!-- 角色状态栏 -->
        <player-stats-bar />

        <!-- 输入区 -->
        <view class="input-area">
          <view class="input-row">
            <textarea
              v-model="inputText"
              :focus="textareaFocus"
              :placeholder="isEnded ? '游戏已结束，请前往结局总结' : (isJoined ? '描述你的行动...' : '正在连接房间...')"
              :disabled="isEnded || !isJoined"
              placeholder-class="gothic-ph"
              confirm-type="send"
              auto-height
              :maxlength="-1"
              @confirm="handleSend"
              @keydown="handleKeydown"
              class="chat-input"
            />
            <button
              class="gothic-btn send-btn"
              :class="{ 'is-disabled': !inputText.trim() || isEnded || !isJoined }"
              hover-class="send-btn-hover"
              @click="handleSend"
            >
              <text>发送</text>
            </button>
          </view>
        </view>
      </view>

      <!-- 线索侧面板 -->
      <view v-if="cluesPanelOpen && cluesObtained.length > 0" class="clues-panel animate-slide-up">
        <view class="clues-header">
          <text class="clues-title">已获得线索</text>
          <text class="close-btn" @click="cluesPanelOpen = false">✕</text>
        </view>
        <scroll-view class="clues-body" scroll-y>
          <view v-for="clue in cluesObtained" :key="clue.id || clue.description" class="clue-card">
            <text decode>{{ clue.description }}</text>
          </view>
        </scroll-view>
      </view>
    </view>
  </app-layout>
</template>

<style scoped lang="scss">
.game-root {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative;
  width: 100%;
}

.main-col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ── 顶栏 ── */
.game-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  flex-shrink: 0;
  border-bottom: 1px solid hsla(220, 14%, 16%, 0.5);
  background: hsla(220, 18%, 7%, 0.98);
  flex-wrap: wrap;
}
.header-info {
  flex: 1;
  min-width: 0;
}
.header-title {
  display: block;
  font-family: $font-display;
  font-size: 1.125rem;
  letter-spacing: 0.05em;
  word-break: break-all;
  color: hsl(38, 55%, 92%);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.9);
}
.header-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
  font-size: 12px;
  color: hsl(220, 10%, 65%);
  flex-wrap: wrap;
}
.header-player {
  font-family: $font-serif;
}
.header-scene {
  display: flex;
  align-items: center;
  gap: 4px;
  color: hsl(165, 50%, 60%);
}
.scene-icon { font-size: 12px; }

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 0.5rem;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  box-sizing: border-box;
  background: hsla(220, 16%, 11%, 0.7);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
  color: hsl(220, 10%, 65%);
}
.action-btn:active {
  background: hsla(220, 16%, 14%, 0.8);
  color: hsl(38, 25%, 55%);
  border-color: hsla(220, 12%, 22%, 0.8);
}
.action-btn-active {
  background: hsla(42, 40%, 14%, 0.4);
  border-color: hsla(42, 70%, 50%, 0.3);
  color: hsl(42, 65%, 70%);
}
.dbg-text {
  font-family: $font-mono;
  font-size: 10px;
}
.clue-badge {
  margin-left: 4px;
  padding: 2px 6px;
  border-radius: 9999px;
  font-size: 10px;
  font-family: $font-mono;
  background: hsla(38, 18%, 18%, 0.5);
  color: hsl(38, 40%, 78%);
}

/* ── 聊天区 ── */
.chat-area {
  flex: 1;
  min-height: 0;
  padding: 20px 16px;
  box-sizing: border-box;
}
.chat-empty {
  display: block;
  text-align: center;
  padding: 48px 0;
  font-family: $font-serif;
  font-size: 0.875rem;
  font-style: italic;
  color: hsl(220, 10%, 55%);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}
.msg-wrap {
  padding: 8px 0;
}
.msg-pending {
  opacity: 0.55;
}
.kp-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px 16px;
}
.kp-pending-text {
  font-family: $font-serif;
  font-size: 0.8125rem;
  font-style: italic;
  color: hsl(220, 10%, 55%);
}

/* ── 输入区 ── */
.input-area {
  flex-shrink: 0;
  border-top: 1px solid hsla(220, 14%, 16%, 0.5);
  background: hsla(220, 18%, 7%, 1);
  padding: 12px 16px;
}
.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.chat-input {
  flex: 1;
  min-height: 40px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
  line-height: 1.6;
  font-family: $font-serif;
  background: hsla(220, 18%, 7%, 0.85);
  color: hsl(38, 40%, 78%);
  border: 1px solid hsl(220, 14%, 16%);
  box-sizing: border-box;
}
.send-btn {
  flex-shrink: 0;
  padding: 8px 20px;
  align-self: flex-end;
}
/* 发送主 CTA 按压态（Task 9 / Task 8 Minor ③：MP 端 :active 不生效 → hover-class） */
.send-btn-hover {
  background: hsla(165, 50%, 25%, 0.85);
  border-color: hsl(165, 60%, 35%);
}
.small-spinner {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

/* ── 线索面板 ── */
.clues-panel {
  width: 256px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid hsl(220, 14%, 16%);
  background: hsla(220, 18%, 7%, 0.98);
}
.clues-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid hsl(220, 14%, 16%);
  flex-shrink: 0;
}
.clues-title {
  font-family: $font-display;
  font-size: 0.875rem;
  letter-spacing: 0.05em;
  color: hsl(38, 35%, 68%);
}
.close-btn {
  font-size: 12px;
  color: hsl(220, 10%, 30%);
  padding: 0 4px;
}
.close-btn:active {
  color: hsl(38, 25%, 55%);
}
.clues-body {
  flex: 1;
  min-height: 0;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.clue-card {
  padding: 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  font-family: $font-serif;
  background: hsla(38, 18%, 18%, 0.25);
  border: 1px solid hsla(38, 20%, 30%, 0.2);
  color: hsl(38, 35%, 68%);
}

/* ── 调试面板 ── */
.debug-aside {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid hsl(220, 14%, 16%);
}

/* ── 弹窗 ── */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: hsla(220, 20%, 4%, 0.85);
}
.modal-box {
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 20px;
  background: hsl(220, 18%, 7%);
  border: 1px solid hsl(220, 14%, 16%);
  border-radius: 0.75rem;
  box-shadow: 0 8px 32px hsla(220, 20%, 4%, 0.8), 0 0 0 1px hsla(220, 14%, 16%, 0.3);
}
.modal-box-lg {
  width: 448px;
  display: flex;
  flex-direction: column;
  padding: 0;
  max-height: 70vh;
}
.modal-title {
  display: block;
  font-family: $font-display;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
  color: hsl(38, 50%, 88%);
}
.save-input {
  margin-bottom: 8px;
}
.modal-error {
  display: block;
  font-size: 12px;
  margin-bottom: 8px;
  color: hsl(0, 55%, 65%);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-btn {
  font-size: 0.875rem;
}
.modal-section-header {
  padding: 20px 20px 12px;
  border-bottom: 1px solid hsl(220, 14%, 16%);
}
.modal-section-header .modal-title {
  margin-bottom: 0;
}
.modal-section-footer {
  padding: 16px 20px;
  border-top: 1px solid hsl(220, 14%, 16%);
}
.save-list {
  flex: 1;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.no-saves {
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  color: hsl(220, 10%, 30%);
  padding: 8px 0;
}
.save-item {
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
  line-height: 1.5;
  box-sizing: border-box;
  background: hsla(220, 16%, 11%, 0.5);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
}
.save-item:active {
  background: hsla(220, 16%, 14%, 0.7);
  border-color: hsla(220, 12%, 22%, 0.6);
}
.save-name {
  color: hsl(38, 40%, 78%);
  font-weight: 500;
}
.save-story {
  margin-left: 8px;
  font-size: 12px;
  color: hsl(220, 10%, 30%);
}
.load-error {
  padding: 0 20px;
}
</style>
