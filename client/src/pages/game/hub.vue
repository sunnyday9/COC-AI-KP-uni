<script setup lang="ts">
import { computed, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { getBridge } from '../../platform'
import type { RoomListItem, RoomPhase, SoloRoomListItem } from '../../../../shared/types/room'
import AppLayout from '../../components/layout/AppLayout.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'

const soloRooms = ref<SoloRoomListItem[]>([])
const multiRooms = ref<RoomListItem[]>([])
const isLoading = ref(false)
const errorMsg = ref('')

const activeSoloRooms = computed(() => soloRooms.value.filter((room) => room.phase !== 'ended'))
const activeMultiRooms = computed(() => multiRooms.value.filter((room) => room.phase !== 'ended'))
const hasActiveRooms = computed(() => activeSoloRooms.value.length > 0 || activeMultiRooms.value.length > 0)

async function loadRooms() {
  isLoading.value = true
  errorMsg.value = ''

  const bridge = getBridge()
  const [soloResult, multiResult] = await Promise.allSettled([bridge.roomListSolo(), bridge.roomList()])

  if (soloResult.status === 'fulfilled') {
    soloRooms.value = soloResult.value
  }
  if (multiResult.status === 'fulfilled') {
    multiRooms.value = multiResult.value
  }
  if (soloResult.status === 'rejected' && multiResult.status === 'rejected') {
    errorMsg.value = '进行中的调查暂时无法加载，请稍后重试'
  }

  isLoading.value = false
}

function phaseLabel(phase: RoomPhase): string {
  return phase === 'playing' ? '调查中' : '等待开局'
}

function openSolo(room: SoloRoomListItem) {
  uni.navigateTo({ url: `/pages/game/index?roomId=${encodeURIComponent(room.roomId)}` })
}

function openMulti(room: RoomListItem) {
  if (room.phase === 'playing') {
    uni.navigateTo({ url: `/pages/game/index?roomId=${encodeURIComponent(room.roomId)}` })
    return
  }
  uni.navigateTo({ url: `/pages/game/rooms/room?roomId=${encodeURIComponent(room.roomId)}` })
}

function goRooms() {
  uni.navigateTo({ url: '/pages/game/rooms/index' })
}

// onShow runs once for the initial display and again after returning from a detail page.
onShow(() => { void loadRooms() })
</script>

<template>
  <app-layout active="game" bg="/static/bg/bg_home.webp" :overlay="0.75">
    <view class="page-root">
      <view class="head">
        <view class="head-copy">
          <text class="head-title">进行中的调查</text>
          <text class="head-sub">从这里继续单人调查，或返回多人等待室</text>
        </view>
        <Button variant="ghost" extra-class="refresh-btn" :loading="isLoading" @click="loadRooms">
          刷新
        </Button>
      </view>

      <text v-if="errorMsg" class="err-text">{{ errorMsg }}</text>

      <view v-if="isLoading && !hasActiveRooms" class="loading-card">
        <view class="sigil-spinner" />
        <text class="loading-text">查阅调查档案中...</text>
      </view>

      <template v-else-if="hasActiveRooms">
        <view v-if="activeSoloRooms.length" class="section">
          <view class="section-head">
            <app-icon name="feather" :size="16" class="section-icon" />
            <text class="section-title">单人调查</text>
          </view>
          <view class="room-list">
            <view
              v-for="room in activeSoloRooms"
              :key="room.roomId"
              class="investigation-card"
              hover-class="investigation-card-hover"
              @click="openSolo(room)"
            >
              <view class="room-mark solo-mark"><app-icon name="feather" :size="18" /></view>
              <view class="room-copy">
                <text class="room-story">{{ room.storyId || '未命名故事' }}</text>
                <text class="room-preview">{{ room.preview || '调查尚未留下新的记录' }}</text>
              </view>
              <view class="room-status" :class="'status-' + room.phase">
                <text class="status-dot" />
                <text>{{ phaseLabel(room.phase) }}</text>
              </view>
            </view>
          </view>
        </view>

        <view v-if="activeMultiRooms.length" class="section">
          <view class="section-head">
            <app-icon name="users" :size="16" class="section-icon" />
            <text class="section-title">多人房间</text>
          </view>
          <view class="room-list">
            <view
              v-for="room in activeMultiRooms"
              :key="room.roomId"
              class="investigation-card"
              hover-class="investigation-card-hover"
              @click="openMulti(room)"
            >
              <view class="room-mark multi-mark"><app-icon name="users" :size="18" /></view>
              <view class="room-copy">
                <text class="room-story">{{ room.storyId || '等待选择故事' }}</text>
                <text class="room-preview">邀请码 {{ room.inviteCode }} · {{ room.roomId }}</text>
              </view>
              <view class="room-status" :class="'status-' + room.phase">
                <text class="status-dot" />
                <text>{{ phaseLabel(room.phase) }}</text>
              </view>
            </view>
          </view>
        </view>
      </template>

      <empty-state
        v-else-if="!isLoading"
        icon="sword"
        title="没有进行中的调查"
        desc="新的调查会从首页故事卡启动；多人调查可以从房间入口加入。"
      >
        <template #action>
          <Button variant="outline" @click="goRooms">进入多人房间</Button>
        </template>
      </empty-state>
    </view>
  </app-layout>
</template>

<style scoped lang="scss">
.page-root {
  min-height: 100%;
  padding: 32px 24px 48px;
  max-width: 840px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 28px;
}
.head-copy {
  min-width: 0;
}
.head-title {
  display: block;
  font-family: $font-display;
  font-size: 1.5rem;
  font-weight: bold;
  color: var(--c-paper-100);
}
.head-sub {
  display: block;
  margin-top: 6px;
  font-size: 0.875rem;
  color: var(--c-ash);
  font-family: $font-serif;
}
.refresh-btn {
  flex-shrink: 0;
  min-width: 60px;
}
.err-text {
  display: block;
  margin: 0 0 16px;
  color: var(--c-blood-200);
  font-size: 0.875rem;
}
.loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 24px;
  border: 1px solid color-mix(in srgb, var(--c-slate) 70%, transparent);
  background: rgba(0, 0, 0, 0.42);
}
.loading-text {
  display: block;
  margin-top: 16px;
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  color: var(--c-ash);
}
.section {
  margin-bottom: 28px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
}
.section-icon {
  color: var(--c-eld-400);
}
.section-title {
  font-family: $font-display;
  font-size: 1rem;
  font-weight: bold;
  letter-spacing: 0.06em;
  color: var(--c-paper-100);
}
.room-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.investigation-card {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--c-obsidian-light) 80%, transparent);
  border-left: 3px solid color-mix(in srgb, var(--c-eld-500) 50%, transparent);
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.58);
  transition: all 0.2s;
}
.investigation-card-hover {
  background: rgba(0, 0, 0, 0.78);
  border-left-color: var(--c-eld-400);
  transform: translateY(-1px);
}
.room-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 0.5rem;
  color: var(--c-eld-100);
}
.solo-mark {
  background: color-mix(in srgb, var(--c-eld-900) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 60%, transparent);
}
.multi-mark {
  background: color-mix(in srgb, var(--c-ritual-900) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-ritual-700) 60%, transparent);
  color: var(--c-ritual-100);
}
.room-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.room-story {
  overflow: hidden;
  color: var(--c-paper-50);
  font-family: $font-serif;
  font-size: 1rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.room-preview {
  overflow: hidden;
  color: var(--c-fog);
  font-family: $font-mono;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.room-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 5px 9px;
  border: 1px solid;
  border-radius: 9999px;
  font-size: 11px;
}
.status-playing {
  color: var(--c-eld-200);
  border-color: color-mix(in srgb, var(--c-eld-600) 50%, transparent);
}
.status-lobby {
  color: var(--c-ritual-200);
  border-color: color-mix(in srgb, var(--c-ritual-600) 50%, transparent);
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
@media (max-width: 480px) {
  .investigation-card {
    align-items: flex-start;
  }
  .room-status {
    margin-left: auto;
  }
  .room-preview {
    max-width: 42vw;
  }
}
</style>
