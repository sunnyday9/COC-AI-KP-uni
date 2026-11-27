<script setup lang="ts">
import { useRoomStore } from '../../../stores/roomStore'

const room = useRoomStore()
</script>

<template>
  <view v-if="room.chatRetryNotices.length" class="chat-retry-notices">
    <view v-for="chat in room.chatRetryNotices" :key="chat.id" class="chat-retry-notice">
      <text>{{ chat.sendError }}</text>
      <text class="chat-retry-content">{{ chat.content }}</text>
      <button :disabled="room.connectionState !== 'joined'" @click="room.retryPendingChat(chat.id)">重试发送</button>
    </view>
  </view>
</template>

<style scoped>
.chat-retry-notices {
  max-height: 9rem;
  overflow: auto;
  font-size: 12px;
}
.chat-retry-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 4px 0;
}
.chat-retry-content {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button {
  margin: 0;
  font-size: inherit;
  line-height: 2;
}
</style>
