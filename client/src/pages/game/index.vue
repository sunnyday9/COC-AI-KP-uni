<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { storeToRefs } from 'pinia'
import { useGameStore } from '../../stores/gameStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGameGuard } from '../../composables/useGameGuard'
import ChatMessage from '../../components/game/ChatMessage.vue'
import PlayerStatsBar from '../../components/game/PlayerStatsBar.vue'
import DebugPanel from '../../components/game/DebugPanel.vue'
import AppLayout from '../../components/layout/AppLayout.vue'

const isDev = import.meta.env.DEV
const gameStore = useGameStore()
const settingsStore = useSettingsStore()
const { messages, isSending, storyId, storyName, playerName, gamePhase, characterSheet, currentScene, cluesObtained } = storeToRefs(gameStore)
const isEnded = computed(() => gamePhase.value === 'ended')
const inputText = ref('')
const textareaFocus = ref(false)
const lastMsgAnchor = ref('')
const cluesPanelOpen = ref(false)
/** Task 8（简报决策 5）：DebugPanel 仅 debugMode；开发模式默认展开（原行为） */
const debugPanelOpen = ref(isDev)
const saveModalOpen = ref(false)
const loadModalOpen = ref(false)
const saveNameInput = ref('')
const saveError = ref('')
const loadError = ref('')
const saveList = ref<string[]>([])
const saveMetaCache = ref<Record<string, { name?: string; storyName?: string }>>({})
const loadLoading = ref(false)

/** 消息列表自动滚底：scroll-into-view 锚点 = 最后一条消息 id（替代 scrollIntoView） */
function scrollToBottom() {
  nextTick(() => {
    const last = messages.value[messages.value.length - 1]
    if (last) lastMsgAnchor.value = 'msg-' + last.id
  })
}

watch(messages, () => scrollToBottom(), { deep: true })

// 键盘快捷键（Ctrl+Shift+D 切换 Debug Panel）—— H5 only（小程序无全局键盘）
// #ifdef H5
function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault()
    debugPanelOpen.value = !debugPanelOpen.value
  }
}
onMounted(() => document.addEventListener('keydown', handleGlobalKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleGlobalKeydown))
// #endif

onLoad(() => {
  const guard = useGameGuard()
  if (!guard.checkGameAccess()) return
  if (gamePhase.value === 'ended') {
    uni.redirectTo({ url: '/pages/game-end/index' })
  }
})

// 原 GameRoomView.onMounted：页面子组件（DebugPanel 等）挂载完成后执行，
// 保证 traceBus 已启用（DebugPanel onMounted 开启）再发起开场请求
onMounted(async () => {
  const guard = useGameGuard()
  if (!guard.checkGameAccess()) return
  // 读取 debugMode（设置页持久化开关）；成功且非 dev 时打开面板
  settingsStore.load().then(() => {
    if (settingsStore.debugMode && !isDev) debugPanelOpen.value = true
  }).catch(() => {})
  if (messages.value.length === 0) {
    await gameStore.requestOpening()
  }
  scrollToBottom()
})

onShow(() => {
  const guard = useGameGuard()
  if (!guard.checkGameAccess()) return
  if (gamePhase.value === 'ended') {
    uni.redirectTo({ url: '/pages/game-end/index' })
  }
})

watch(gamePhase, (p) => {
  if (p === 'ended') uni.redirectTo({ url: '/pages/game-end/index' })
})

async function handleSend() {
  const text = inputText.value.trim()
  if (!text || isSending.value || isEnded.value) return
  inputText.value = ''
  await gameStore.sendPlayerMessage(text)
}

function handleKeydown(e: KeyboardEvent) {
  // H5 回车发送（不拦截 Shift+Enter 换行）
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function handleOptionSelected(opt: string) {
  if (isSending.value || isEnded.value) return
  inputText.value = opt
  textareaFocus.value = true
  nextTick(() => { textareaFocus.value = false })
}

function openSaveModal() {
  saveModalOpen.value = true
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  saveNameInput.value = `${storyName.value || '存档'} ${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  saveError.value = ''
}

async function confirmSave() {
  saveError.value = ''
  const name = saveNameInput.value.trim() || '未命名存档'
  try {
    const saveId = 'save_' + Date.now()
    await gameStore.saveGame(saveId, name)
    saveModalOpen.value = false
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  }
}

function openLoadModal() {
  loadModalOpen.value = true
  loadError.value = ''
  gameStore.listSaves().then((ids) => {
    saveList.value = ids
    saveMetaCache.value = {}
    ids.forEach((id) => {
      gameStore.getSaveMeta(id).then((meta) => {
        if (meta) saveMetaCache.value[id] = meta
      })
    })
  })
}

async function confirmLoad(saveId: string) {
  loadError.value = ''
  loadLoading.value = true
  try {
    await gameStore.loadGame(saveId)
    loadModalOpen.value = false
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadLoading.value = false
  }
}
</script>

<template>
  <app-layout active="game" bg="/static/bg/bg_game.png" :overlay="0.8">
    <view class="game-root">
      <!-- 主聊天列 -->
      <view class="main-col">
        <!-- 顶栏 -->
        <view class="game-header">
          <view class="header-info">
            <text class="header-title">{{ storyName || storyId }}</text>
            <view class="header-meta">
              <text class="header-player">{{ playerName }}</text>
              <text v-if="currentScene" class="header-scene">
                <text class="scene-icon">⛩</text>{{ currentScene }}
              </text>
            </view>
          </view>

          <button class="action-btn" @click="openSaveModal">💾 存档</button>
          <button class="action-btn" @click="openLoadModal">📄 读档</button>
          <button v-if="isDev" class="action-btn" :class="{ 'action-btn-active': debugPanelOpen }" @click="debugPanelOpen = !debugPanelOpen">
            <text class="dbg-text">DBG</text>
          </button>
          <button v-if="cluesObtained.length > 0" class="action-btn" @click="cluesPanelOpen = !cluesPanelOpen">
            <text>📜 线索</text>
            <text class="clue-badge">{{ cluesObtained.length }}</text>
          </button>
        </view>

        <!-- 聊天区（scroll-view 自动滚底） -->
        <scroll-view class="chat-area vignette-overlay" :scroll-into-view="lastMsgAnchor" scroll-y scroll-with-animation>
          <text v-if="messages.length === 0 && !isSending" class="chat-empty">
            "黑暗中，一个故事正在苏醒..."
          </text>
          <view
            v-for="msg in messages"
            :id="'msg-' + msg.id"
            :key="msg.id"
            class="msg-wrap"
          >
            <chat-message :msg="msg" @select-option="handleOptionSelected" />
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
              :placeholder="isEnded ? '游戏已结束，请前往结局总结' : '描述你的行动...'"
              :disabled="isSending || isEnded"
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
              :class="{ 'is-disabled': !inputText.trim() || isSending || isEnded }"
              @click="handleSend"
            >
              <view v-if="isSending" class="sigil-spinner small-spinner" />
              <text v-else>发送</text>
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
          <view v-for="(clue, idx) in cluesObtained" :key="idx" class="clue-card">
            <text decode>{{ clue }}</text>
          </view>
        </scroll-view>
      </view>

      <!-- 调试面板（仅 debugMode；开发模式默认展开，Ctrl+Shift+D 切换） -->
      <view v-if="debugPanelOpen" class="debug-aside">
        <debug-panel />
      </view>

      <!-- 存档弹窗 -->
      <view v-if="saveModalOpen" class="modal-overlay">
        <view class="modal-box">
          <text class="modal-title">存档</text>
          <input
            v-model="saveNameInput"
            class="gothic-input save-input"
            placeholder="存档名称"
            placeholder-class="gothic-ph"
          />
          <text v-if="saveError" class="modal-error">{{ saveError }}</text>
          <view class="modal-actions">
            <button class="gothic-btn-secondary modal-btn" @click="saveModalOpen = false">取消</button>
            <button class="gothic-btn modal-btn" @click="confirmSave">保存</button>
          </view>
        </view>
      </view>

      <!-- 读档弹窗 -->
      <view v-if="loadModalOpen" class="modal-overlay">
        <view class="modal-box modal-box-lg">
          <view class="modal-section-header">
            <text class="modal-title">读档</text>
          </view>
          <scroll-view class="save-list" scroll-y>
            <text v-if="saveList.length === 0" class="no-saves">暂无存档</text>
            <button
              v-for="id in saveList"
              :key="id"
              class="save-item"
              :class="{ 'is-disabled': loadLoading }"
              @click="confirmLoad(id)"
            >
              <text class="save-name">{{ saveMetaCache[id]?.name ?? id }}</text>
              <text v-if="saveMetaCache[id]?.storyName" class="save-story">{{ saveMetaCache[id]?.storyName }}</text>
            </button>
          </scroll-view>
          <text v-if="loadError" class="modal-error load-error">{{ loadError }}</text>
          <view class="modal-section-footer modal-actions">
            <button class="gothic-btn-secondary modal-btn" @click="loadModalOpen = false">关闭</button>
          </view>
        </view>
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
