<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoomStore } from '../../../stores/roomStore'
import ChatMessage from '../components/ChatMessage.vue'
import { getBridge } from '../../../platform'
import type { CharacterListItem } from '../../../../../shared/types/room'

const roomStore = useRoomStore()

const roomId = ref('')
const chatText = ref('')
const myCharacters = ref<CharacterListItem[]>([])
const showCharPicker = ref(false)
const selectedCharId = ref('')
const listRef = ref<unknown>(null)

function goBack() {
  if (roomStore.roomId === roomId.value) {
    roomStore.leaveRoom()
  }
  uni.navigateBack()
}

// 从 URL 参数读取 roomId
function readRoomId(): string {
  // uni-app 页面参数在 onLoad 里；这里兼容 onLoad 提前与直接访问两种
  const pages = getCurrentPages()
  const cur = pages[pages.length - 1] as { options?: Record<string, string> } | undefined
  return cur?.options?.roomId ?? ''
}

onMounted(() => {
  roomId.value = readRoomId()
  if (!roomId.value) {
    roomStore.errorMessage = '缺少房间 ID'
    return
  }
  void roomStore.joinRoom(roomId.value)
  loadMyCharacters()
})

onUnmounted(() => {
  // 离开页面 → 退出房间（若仍在房间内）
  if (roomStore.roomId === roomId.value) {
    roomStore.leaveRoom()
  }
})

/** 房间消息流（服务端事件回灌）。 */
const displayMessages = computed(() => roomStore.messages.map((m) => roomStore.toMessage(m)))

async function loadMyCharacters() {
  try {
    myCharacters.value = await getBridge().characterList!()
  } catch {
    myCharacters.value = []
  }
}

function send() {
  const text = chatText.value
  if (!text.trim()) return
  roomStore.sendChat(text)
  chatText.value = ''
}

async function startGame() {
  // 房主开始：需要选择一个已索引的剧本
  const stories = await getBridge().ragListStories()
  if (stories.length === 0) {
    uni.showToast({ title: '请先在「故事管理」索引一个剧本', icon: 'none' })
    return
  }
  const story = stories[0] // 当前版本取第一个剧本；后续可扩展选择器
  try {
    await getBridge().roomStart!(roomId.value, story.storyId)
    uni.showToast({ title: '游戏开始', icon: 'success' })
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : String(e), icon: 'none' })
  }
}

async function dissolveRoom() {
  try {
    await getBridge().roomDelete!(roomId.value)
    roomStore.leaveRoom()
    uni.navigateBack()
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : String(e), icon: 'none' })
  }
}

function openCharPicker() {
  showCharPicker.value = true
}

async function bindCharacter() {
  if (!selectedCharId.value) return
  try {
    await getBridge().roomBindCharacter!(roomId.value, selectedCharId.value)
    showCharPicker.value = false
    uni.showToast({ title: '角色已绑定', icon: 'success' })
    void roomStore.refreshMeta()
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : String(e), icon: 'none' })
  }
}

function scrollToBottom() {
  nextTick(() => {
    // 消息容器滚动到底部（H5 scroll-view）
  })
}

onMounted(() => scrollToBottom())
</script>

<template>
  <view class="room-root">
    <view class="room-header">
      <view class="header-left">
        <text class="room-title">{{ roomId || '房间' }}</text>
        <text class="room-phase">{{ roomStore.phase }}</text>
        <text v-if="roomStore.inviteCode" class="room-code">邀请码 {{ roomStore.inviteCode }}</text>
      </view>
      <view class="header-right">
        <button v-if="roomStore.isOwner && roomStore.phase === 'lobby'" class="mini-btn start-btn" @click="startGame">开始游戏</button>
        <button v-if="roomStore.isOwner" class="mini-btn danger-btn" @click="dissolveRoom">解散</button>
        <button class="mini-btn" @click="goBack">退出</button>
      </view>
    </view>

    <view v-if="roomStore.connectionState === 'error'" class="err-banner">
      <text>{{ roomStore.errorMessage }}</text>
      <button class="mini-btn" @click="roomStore.joinRoom(roomId)">重试</button>
    </view>

    <view class="room-body">
      <!-- 左侧：成员列表 -->
      <view class="side-panel">
        <view class="side-title">成员 ({{ roomStore.members.length }})</view>
        <view v-for="m in roomStore.members" :key="m.userId" class="member-row">
          <view class="member-avatar"><text>{{ m.username.charAt(0) }}</text></view>
          <view class="member-info">
            <text class="member-name">{{ m.username }}</text>
            <text class="member-role">{{ m.role === 'owner' ? '房主' : m.role === 'observer' ? '旁观' : '成员' }}</text>
          </view>
        </view>
        <button class="mini-btn bind-btn" @click="openCharPicker">绑定角色卡</button>
      </view>

      <!-- 右侧：消息流 + 输入 -->
      <view class="main-panel">
        <view class="chat-list">
          <view v-if="roomStore.messages.length === 0" class="chat-empty">
            房间里一片寂静……等待调查员的行动。
          </view>
          <view
            v-for="msg in displayMessages"
            :key="msg.id"
            class="msg-wrap"
            :id="'msg-' + msg.id"
          >
            <chat-message :msg="msg" />
          </view>
        </view>

        <view class="chat-input-row">
          <input
            v-model="chatText"
            class="chat-input"
            placeholder="说出你的行动…"
            confirm-type="send"
            @confirm="send"
          />
          <button class="gothic-btn send-btn" @click="send">发送</button>
        </view>
      </view>
    </view>

    <!-- 角色卡选择弹层 -->
    <view v-if="showCharPicker" class="picker-mask" @click="showCharPicker = false">
      <view class="picker" @click.stop>
        <view class="picker-title">选择角色卡</view>
        <view
          v-for="c in myCharacters"
          :key="c.id"
          class="char-option"
          :class="{ active: selectedCharId === c.id }"
          @click="selectedCharId = c.id"
        >
          <text>{{ c.name }}</text>
        </view>
        <view v-if="myCharacters.length === 0" class="picker-empty">暂无角色卡 — 请先到「创建角色」制作一张</view>
        <button class="gothic-btn" @click="bindCharacter">确认绑定</button>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.room-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background:
    radial-gradient(ellipse at top, hsla(165, 30%, 12%, 0.4), transparent 60%),
    #080a0c;
  color: hsl(38, 40%, 80%);
}

.room-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid hsla(220, 14%, 16%, 0.8);
  background: rgba(0, 0, 0, 0.5);
}
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.room-title {
  font-family: $font-display;
  font-size: 1.125rem;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
}
.room-phase {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid hsla(165, 50%, 30%, 0.4);
  color: hsl(165, 50%, 70%);
}
.room-code {
  font-size: 12px;
  font-family: $font-mono;
  color: hsl(42, 50%, 70%);
}
.header-right {
  display: flex;
  gap: 8px;
}
.mini-btn {
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  color: hsl(220, 20%, 70%);
}
.start-btn {
  color: hsl(165, 50%, 70%);
  border-color: hsla(165, 50%, 30%, 0.5);
}
.danger-btn {
  color: hsl(0, 50%, 65%);
  border-color: hsla(0, 50%, 30%, 0.5);
}
.err-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  background: hsla(0, 50%, 15%, 0.5);
  color: hsl(0, 55%, 75%);
  font-size: 0.875rem;
}

.room-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.side-panel {
  width: 200px;
  flex-shrink: 0;
  padding: 16px;
  border-right: 1px solid hsla(220, 14%, 16%, 0.8);
  overflow-y: auto;
}
.side-title {
  font-family: $font-display;
  font-size: 0.875rem;
  color: hsl(38, 40%, 70%);
  margin-bottom: 12px;
  letter-spacing: 0.05em;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  background: hsla(165, 45%, 22%, 0.5);
  border: 1px solid hsla(165, 55%, 28%, 0.4);
  color: hsl(165, 50%, 78%);
}
.member-info {
  display: flex;
  flex-direction: column;
}
.member-name {
  font-size: 0.875rem;
  color: hsl(38, 40%, 80%);
}
.member-role {
  font-size: 11px;
  color: hsl(220, 10%, 40%);
}
.bind-btn {
  margin-top: 16px;
  width: 100%;
}

.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg-wrap {
  width: 100%;
}
.chat-empty {
  color: hsl(220, 10%, 35%);
  font-style: italic;
  font-family: $font-serif;
  text-align: center;
  padding: 40px 0;
}
.chat-input-row {
  display: flex;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid hsla(220, 14%, 16%, 0.8);
  background: rgba(0, 0, 0, 0.5);
}
.chat-input {
  flex: 1;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  border-radius: 0.5rem;
  color: hsl(38, 40%, 80%);
  padding: 10px 14px;
  font-size: 0.9375rem;
}
.send-btn {
  flex-shrink: 0;
}

.picker-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.picker {
  width: 320px;
  max-height: 70vh;
  overflow-y: auto;
  background: #0d1114;
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  border-radius: 0.75rem;
  padding: 20px;
}
.picker-title {
  font-family: $font-display;
  font-size: 1rem;
  color: hsl(38, 50%, 88%);
  margin-bottom: 14px;
}
.char-option {
  padding: 12px 14px;
  border-radius: 0.5rem;
  border: 1px solid hsla(220, 14%, 18%, 0.8);
  margin-bottom: 8px;
  color: hsl(38, 35%, 75%);
}
.char-option.active {
  border-color: hsla(165, 50%, 35%, 0.6);
  background: hsla(165, 30%, 12%, 0.5);
}
.picker-empty {
  color: hsl(220, 10%, 40%);
  font-size: 0.875rem;
  padding: 12px 0;
}
</style>
