<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getBridge } from '../../../platform'
import type { RoomListItem } from '../../../../../shared/types/room'
import AppLayout from '../../../components/layout/AppLayout.vue'

const myRooms = ref<RoomListItem[]>([])
const inviteCodeInput = ref('')
const isLoading = ref(false)
const errorMsg = ref('')
const noticeMsg = ref('')

async function loadRooms() {
  try {
    myRooms.value = await getBridge().roomList()
  } catch {
    myRooms.value = []
  }
}

onMounted(() => { loadRooms() })

async function createRoom() {
  errorMsg.value = ''
  noticeMsg.value = ''
  try {
    const r = await getBridge().roomCreate()
    noticeMsg.value = `房间已创建，邀请码 ${r.inviteCode}`
    uni.navigateTo({ url: `/pages/rooms/room?roomId=${r.roomId}` })
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

async function joinByCode() {
  const code = inviteCodeInput.value.trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    errorMsg.value = '邀请码为 6 位字母数字'
    return
  }
  errorMsg.value = ''
  try {
    const r = await getBridge().roomJoin(code)
    uni.navigateTo({ url: `/pages/rooms/room?roomId=${r.roomId}` })
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

function openRoom(room: RoomListItem) {
  uni.navigateTo({ url: `/pages/rooms/room?roomId=${room.roomId}` })
}
</script>

<template>
  <app-layout active="game" bg="/static/bg/bg_home.webp" :overlay="0.75">
    <view class="page-root">
      <view class="head">
        <text class="head-title">多人房间</text>
        <text class="head-sub">邀请同伴，共赴不可名状之夜</text>
      </view>

      <view class="panel">
        <view class="panel-title">创建房间</view>
        <view class="panel-row">
          <button class="gothic-btn" :loading="isLoading" @click="createRoom">创建新房间</button>
          <text class="hint">作为房主创建，分享邀请码给同伴</text>
        </view>
      </view>

      <view class="panel">
        <view class="panel-title">加入房间</view>
        <view class="panel-row join-row">
          <input
            v-model="inviteCodeInput"
            class="code-input"
            placeholder="输入 6 位邀请码"
            maxlength="6"
            @confirm="joinByCode"
          />
          <button class="gothic-btn" @click="joinByCode">加入</button>
        </view>
      </view>

      <text v-if="errorMsg" class="err-text">{{ errorMsg }}</text>
      <text v-if="noticeMsg" class="notice-text">{{ noticeMsg }}</text>

      <view class="panel">
        <view class="panel-title">我的房间</view>
        <view v-if="myRooms.length === 0" class="empty">暂无房间 — 创建或加入一个吧</view>
        <view
          v-for="room in myRooms"
          :key="room.roomId"
          class="room-row"
          @click="openRoom(room)"
        >
          <view class="room-info">
            <text class="room-id">{{ room.roomId }}</text>
            <text class="room-code">邀请码 {{ room.inviteCode }}</text>
          </view>
          <view class="room-phase" :class="'phase-' + room.phase">{{ room.phase }}</view>
        </view>
      </view>
    </view>
  </app-layout>
</template>

<style scoped lang="scss">
.page-root {
  padding: 32px 24px 48px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.head {
  margin-bottom: 24px;
}
.head-title {
  display: block;
  font-family: $font-display;
  font-size: 1.5rem;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
}
.head-sub {
  display: block;
  margin-top: 6px;
  font-size: 0.875rem;
  color: hsl(220, 10%, 40%);
  font-family: $font-serif;
}
.panel {
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid hsla(220, 14%, 16%, 0.8);
  border-left: 3px solid hsla(165, 60%, 35%, 0.4);
  border-radius: 0.75rem;
  padding: 20px;
  margin-bottom: 16px;
}
.panel-title {
  font-family: $font-display;
  font-size: 1rem;
  font-weight: bold;
  color: hsl(38, 40%, 80%);
  margin-bottom: 14px;
  letter-spacing: 0.05em;
}
.panel-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hint {
  font-size: 12px;
  color: hsl(220, 10%, 40%);
}
.join-row {
  width: 100%;
}
.code-input {
  flex: 1;
  min-width: 160px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  border-radius: 0.5rem;
  color: hsl(38, 40%, 80%);
  padding: 10px 14px;
  font-size: 1rem;
  letter-spacing: 0.2em;
  font-family: $font-mono;
  text-transform: uppercase;
}
.err-text {
  display: block;
  color: hsl(0, 60%, 65%);
  font-size: 0.875rem;
  margin: 0 0 12px;
}
.notice-text {
  display: block;
  color: hsl(165, 50%, 65%);
  font-size: 0.875rem;
  margin: 0 0 12px;
}
.empty {
  color: hsl(220, 10%, 35%);
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  padding: 8px 0;
}
.room-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 4px;
  border-bottom: 1px solid hsla(220, 14%, 14%, 0.5);
}
.room-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.room-id {
  font-family: $font-mono;
  font-size: 0.875rem;
  color: hsl(38, 40%, 80%);
}
.room-code {
  font-size: 12px;
  color: hsl(220, 10%, 40%);
}
.room-phase {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 9999px;
  border: 1px solid;
}
.phase-lobby { color: hsl(42, 50%, 70%); border-color: hsla(42, 50%, 40%, 0.4); }
.phase-playing { color: hsl(165, 50%, 70%); border-color: hsla(165, 50%, 30%, 0.4); }
.phase-ended { color: hsl(0, 40%, 65%); border-color: hsla(0, 40%, 35%, 0.4); }
</style>
