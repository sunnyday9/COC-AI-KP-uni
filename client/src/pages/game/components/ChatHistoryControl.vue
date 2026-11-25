<script setup lang="ts">
import { useRoomStore } from '../../../stores/roomStore'

const room = useRoomStore()
</script>

<template>
  <view v-if="room.canLoadHistory" class="chat-history">
    <button :disabled="room.historyLoading" @click="room.loadEarlierMessages()">
      {{ room.historyLoading ? '正在读取…' : '加载更早的消息' }}
    </button>
    <text v-if="room.historyError" role="alert">{{ room.historyError }}</text>
  </view>
</template>

<style scoped>
.chat-history {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 4px 0 10px;
  font-size: 12px;
}
button {
  margin: 0;
  font-size: inherit;
  line-height: 2;
}
</style>
