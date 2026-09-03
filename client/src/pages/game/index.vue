<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { storeToRefs } from 'pinia'
import { useRoomStore } from '../../stores/roomStore'
import { useSettingsStore } from '../../stores/settingsStore'
import ChatMessage from './components/ChatMessage.vue'
import PlayerStatsBar from './components/PlayerStatsBar.vue'
import MemberSwitcher from './components/MemberSwitcher.vue'
import CharacterSheetCard from '../../components/domain/CharacterSheetCard.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import ConfirmModal from '../../components/ui/ConfirmModal.vue'
import AppLayout from '../../components/layout/AppLayout.vue'
import type { RoomMemberInfo } from '../../../../shared/types/room'
import type { COCCharacterSheet } from '../../../../shared/types/character'

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

/* ── T4 队友档案切换（#31，ADR-0005 决策 8）：桌面右栏 + 移动 dossier sheet 共用的成员档案选择 ── */

/** 可看档案的成员（多人在列 → 切换器显示；单人局单成员 → 无切换器零回归）。 */
const dossierMembers = computed(() => roomStore.members)
/** 多人在列（>1）才显示切换器（单人局天然单成员，隐藏）。 */
const showMemberPicker = computed(() => roomStore.members.length > 1)
/** 移动端档案按钮：多人局含未绑卡成员也要有入口（能看到空态），不再以自己绑卡为前提。 */
const showMobileDossier = computed(() => roomStore.members.length > 0)
/** 当前选中查看的成员 id（默认自己；成员离开/自己不在列 → 回落自己）。 */
const selectedMemberId = ref<number | null>(null)
function normalizeMemberPick(): void {
  const mine = roomStore.selfUserId
  const list = dossierMembers.value
  const stillThere = (id: number | null) => id !== null && list.some((m) => m.userId === id)
  if (selectedMemberId.value !== null && stillThere(selectedMemberId.value)) return
  // 默认自己；自己不在列（理论不发生——还在房间里）→ 取首个成员兜底
  selectedMemberId.value = mine !== null && list.some((m) => m.userId === mine) ? mine : (list[0]?.userId ?? null)
}
// members 响应式刷新（新绑卡/换绑/离开都会触发）→ 选中项合法性随动
watch(dossierMembers, normalizeMemberPick, { deep: true })
// 页面进入时初始化选中：roomStore 是全局单例（等待室已 join → 状态已是
// joined），immediate 保证本页 setup 即使不再有状态变迁也完成默认选中。
watch(() => roomStore.connectionState, (s) => {
  if (s === 'joined') normalizeMemberPick()
}, { immediate: true })

/** 选中成员行（members 中不存在 → null，卡区显示兜底）。 */
const selectedMember = computed<RoomMemberInfo | null>(
  () => dossierMembers.value.find((m) => m.userId === selectedMemberId.value) ?? null,
)
/** 选中成员的角色卡（characterId → roomStore.characters；换绑随 room_meta/state_patch 自动生效）。 */
const selectedSheet = computed<COCCharacterSheet | null>(() => {
  const cid = selectedMember.value?.characterId
  if (!cid) return null
  return (roomStore.characters[cid] as COCCharacterSheet | undefined) ?? null
})
/** 选中成员的档案区空态文案：未绑卡 / 已绑卡但档案未到（时序兜底）/ 成员不在列。 */
const dossierEmptyText = computed(() => {
  const m = selectedMember.value
  if (!m) return '档案加载中…'
  if (!m.characterId) return `${m.username} 尚未绑定角色卡`
  return '档案加载中…'
})
function pickMember(userId: number): void {
  selectedMemberId.value = userId
}

const inputText = ref('')
const textareaFocus = ref(false)
const lastMsgAnchor = ref('')
const cluesPanelOpen = ref(false)
/** T5：移动端 bottom sheet（clues | dossier），桌面不弹 sheet。 */
const sheetOpen = ref<'clues' | 'dossier' | null>(null)
/** 沉浸退出确认弹窗（复用项目 ConfirmModal，暗色哥特风）。 */
const exitOpen = ref(false)

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

/** 沉浸模式退出入口：打开确认弹窗（复用 ConfirmModal，暗色哥特风）。 */
function handleExit() {
  exitOpen.value = true
}

/** 确认离开：离开当前房间回首页。 */
function confirmExit() {
  exitOpen.value = false
  try {
    roomStore.leaveRoom()
  } catch { /* 忽略登出清理异常 */ }
  uni.reLaunch({ url: '/pages/home/index' })
}
</script>

<template>
  <app-layout active="game" :bg="pageBg" :overlay="0.8" :chrome="false">
    <view class="game-root">
      <!-- ══ 桌面左栏：场景 + 线索列表（≥1024px 常显） ══ -->
      <view class="left-rail">
        <view class="rail-block scene-block">
          <view class="rail-title-row">
            <app-icon name="scroll" :size="14" class="rail-title-icon" />
            <text class="rail-title">当前场景</text>
          </view>
          <text class="scene-text">{{ currentScene || '（未切换场景）' }}</text>
        </view>

        <view class="rail-block clues-rail">
          <view class="rail-title-row">
            <app-icon name="search" :size="14" class="rail-title-icon" />
            <text class="rail-title">线索簿</text>
            <text v-if="cluesObtained.length" class="clue-badge">{{ cluesObtained.length }}</text>
          </view>
          <scroll-view class="clues-rail-body" scroll-y>
            <view v-if="cluesObtained.length === 0" class="clues-empty">
              <text class="clues-empty-text">尚未发现线索…</text>
            </view>
            <view v-for="clue in cluesObtained" :key="clue.id || clue.description" class="clue-card">
              <text decode>{{ clue.description }}</text>
            </view>
          </scroll-view>
        </view>
      </view>

      <!-- ══ 主列：顶栏 + 对话流 + 输入 ══ -->
      <view class="main-col">
        <!-- 顶栏 -->
        <view class="game-header">
          <view class="header-info">
            <text class="header-title">{{ storyName || roomStore.storyId || '单人局' }}</text>
            <view class="header-meta">
              <text class="header-player">{{ playerName }}</text>
              <text v-if="currentScene" class="header-scene header-scene-mobile">
                <app-icon name="scroll" :size="11" class="scene-icon" />{{ currentScene }}
              </text>
            </view>
          </view>

          <!-- 移动端：档案/线索 sheet 唤起（桌面常显栏位不重复） -->
          <view class="mobile-actions">
            <button v-if="showMobileDossier" class="action-btn" @click="sheetOpen = 'dossier'">
              <app-icon name="users" :size="13" />
              <text>档案</text>
            </button>
            <button v-if="cluesObtained.length > 0" class="action-btn" @click="sheetOpen = 'clues'">
              <app-icon name="search" :size="13" />
              <text>线索</text>
              <text class="clue-badge">{{ cluesObtained.length }}</text>
            </button>
          </view>

          <!-- 退出（沉浸模式无全局导航；主列顶栏右缘，桌面/移动均显示，不碰右栏） -->
          <view class="game-exit" @click="handleExit">
            <app-icon name="x" :size="13" />
            <text>退出</text>
          </view>
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

        <!-- 移动端底部状态胶囊（桌面状态在右栏） -->
        <view class="stats-mobile-wrap">
          <player-stats-bar />
        </view>

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

      <!-- ══ 桌面右栏：状态胶囊 + CharacterSheet 档案（≥1024px 常显） ══ -->
      <view class="right-rail">
        <player-stats-bar />
        <view class="dossier-block">
          <view class="rail-title-row">
            <app-icon name="users" :size="14" class="rail-title-icon" />
            <text class="rail-title">调查员档案</text>
          </view>
          <!-- T4 队友档案切换：多人在列才显示（单人局单成员无切换器，零回归） -->
          <member-switcher
            v-if="showMemberPicker"
            class="dossier-switcher"
            :members="dossierMembers"
            :selected-id="selectedMemberId"
            :self-user-id="roomStore.selfUserId"
            @select="pickMember"
          />
          <character-sheet-card v-if="selectedSheet" :sheet="selectedSheet" />
          <view v-else class="dossier-empty">{{ dossierEmptyText }}</view>
        </view>
      </view>

      <!-- ══ 移动端 bottom sheet（clues / dossier） ══ -->
      <view v-if="sheetOpen" class="sheet-mask" @click="sheetOpen = null">
        <view class="sheet-panel" @click.stop>
          <view class="sheet-head">
            <text class="sheet-title">{{ sheetOpen === 'clues' ? '线索簿' : '调查员档案' }}</text>
            <text class="sheet-close" @click="sheetOpen = null">✕</text>
          </view>
          <scroll-view class="sheet-body" scroll-y>
            <template v-if="sheetOpen === 'clues'">
              <view v-if="cluesObtained.length === 0" class="clues-empty">
                <text class="clues-empty-text">尚未发现线索…</text>
              </view>
              <view v-for="clue in cluesObtained" :key="clue.id || clue.description" class="clue-card">
                <text decode>{{ clue.description }}</text>
              </view>
            </template>
            <template v-else>
              <!-- T4 队友档案切换：移动 sheet 顶部；多人在列才显示（单人局无切换器） -->
              <member-switcher
                v-if="showMemberPicker"
                class="dossier-switcher sheet-switcher"
                :members="dossierMembers"
                :selected-id="selectedMemberId"
                :self-user-id="roomStore.selfUserId"
                @select="pickMember"
              />
              <character-sheet-card v-if="selectedSheet" :sheet="selectedSheet" />
              <view v-else class="dossier-empty">{{ dossierEmptyText }}</view>
            </template>
          </scroll-view>
        </view>
      </view>

      <!-- 退出确认弹窗（项目 ConfirmModal：暗色卡片底 + 危险红确认） -->
      <confirm-modal
        v-if="exitOpen"
        title="离开房间"
        message="调查进度已保存在服务端，随时可回来继续。"
        confirm-text="离开房间"
        cancel-text="留下"
        tone="danger"
        @confirm="confirmExit"
        @cancel="exitOpen = false"
      />
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

/* 退出入口（沉浸模式无全局导航；置于主列顶栏右缘，随 header 布局不碰右栏） */
.game-exit {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid hsla(0, 60%, 40%, 0.35);
  background: rgba(24, 8, 10, 0.75);
  color: hsl(0, 45%, 72%);
  font-size: 0.75rem;
  line-height: 1.2;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all 0.25s;
}
.game-exit:hover {
  color: hsl(0, 90%, 90%);
  border-color: hsla(0, 90%, 55%, 0.9);
  background: hsla(0, 55%, 24%, 0.92);
  box-shadow: 0 0 10px hsla(0, 60%, 45%, 0.35);
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
.mobile-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

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

/* ═══════ 三栏布局（桌面 ≥1024px） ═══════ */

/* 桌面左栏：场景 + 线索（移动端隐藏——线索改 bottom sheet） */
.left-rail {
  display: none;
}
/* 桌面右栏：状态胶囊 + 档案（移动端隐藏——档案改 bottom sheet） */
.right-rail {
  display: none;
}
/* 桌面隐藏移动端状态胶囊与场景行内小字 */
.stats-mobile-wrap {
  flex-shrink: 0;
}
.header-scene-mobile {
  display: none;
}

@media (min-width: 1024px) {
  .left-rail {
    display: flex;
    flex-direction: column;
    width: 248px;
    flex-shrink: 0;
    border-right: 1px solid hsl(220, 14%, 16%);
    background: hsla(220, 18%, 7%, 0.98);
    min-height: 0;
  }
  .right-rail {
    display: flex;
    flex-direction: column;
    width: 280px;
    flex-shrink: 0;
    border-left: 1px solid hsl(220, 14%, 16%);
    background: hsla(220, 18%, 7%, 0.98);
    min-height: 0;
    overflow-y: auto;
    gap: 16px;
    padding: 16px 12px;
    box-sizing: border-box;
  }
  .stats-mobile-wrap {
    display: none;
  }
  .mobile-actions {
    display: none;
  }
  .header-scene-mobile {
    display: flex;
  }
}

.rail-block {
  display: flex;
  flex-direction: column;
  padding: 14px 12px;
  box-sizing: border-box;
}
.scene-block {
  border-bottom: 1px solid hsl(220, 14%, 16%);
  gap: 8px;
}
.clues-rail {
  flex: 1;
  min-height: 0;
  gap: 8px;
}
.clues-rail-body {
  flex: 1;
  min-height: 0;
}
.rail-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rail-title-icon {
  color: hsl(165, 45%, 45%);
}
.rail-title {
  font-family: $font-display;
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  color: hsl(38, 35%, 75%);
}
.scene-text {
  font-family: $font-serif;
  font-size: 13px;
  line-height: 1.6;
  color: hsl(165, 40%, 60%);
}
.clues-empty {
  padding: 16px 0;
  text-align: center;
}
.clues-empty-text {
  font-family: $font-serif;
  font-size: 12px;
  font-style: italic;
  color: hsl(220, 10%, 30%);
}
.clue-card {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  font-family: $font-serif;
  background: hsla(38, 18%, 18%, 0.25);
  border: 1px solid hsla(38, 20%, 30%, 0.2);
  color: hsl(38, 35%, 68%);
  margin-bottom: 8px;
}
.dossier-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
/* 切换器与档案卡同宽（两者都是块宽 100%） */
.dossier-block > .dossier-switcher {
  width: 100%;
}
/* 移动 sheet：切换器与卡之间的间距（sheet-body 已有 padding） */
.sheet-body > .dossier-switcher {
  width: 100%;
  margin-bottom: 12px;
}
.dossier-empty {
  font-family: $font-serif;
  font-style: italic;
  font-size: 12px;
  color: hsl(220, 10%, 30%);
  padding: 32px 0;
  text-align: center;
}

/* ═══════ 移动 bottom sheet ═══════ */
.sheet-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 60;
  background: hsla(220, 20%, 4%, 0.6);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.sheet-panel {
  width: 100%;
  max-width: 720px;
  max-height: 72vh;
  background: hsl(220, 18%, 7%);
  border-radius: 16px 16px 0 0;
  border: 1px solid hsl(220, 14%, 16%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid hsl(220, 14%, 16%);
  flex-shrink: 0;
}
.sheet-title {
  font-family: $font-display;
  font-size: 0.9375rem;
  letter-spacing: 0.06em;
  color: hsl(38, 45%, 85%);
}
.sheet-close {
  font-size: 14px;
  color: hsl(220, 10%, 40%);
  padding: 0 6px;
}
.sheet-body {
  flex: 1;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
}
@media (min-width: 1024px) {
  .sheet-mask {
    display: none;
  }
}
</style>
