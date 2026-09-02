<script setup lang="ts">
import type { Message } from '../../../types/game'

/**
 * T4：玩家消息（ADR-0004）——右侧气泡，eldritch 描边 + 顶部成员名（角色色）。
 */
defineProps<{ msg: Message }>()
</script>

<template>
  <view class="msg-row player-row">
    <view class="player-msg">
      <text class="player-name">{{ msg.playerName }}</text>
      <view class="player-text-wrap">
        <text class="player-text" decode>{{ msg.content }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.msg-row {
  display: flex;
  width: 100%;
  box-sizing: border-box;
}
.player-row {
  justify-content: flex-end;
}

.player-msg {
  max-width: 85%;
  border-radius: 0.75rem;
  border-top-right-radius: 2px;
  padding: 14px 18px;
  background: var(--c-card);
  border: 1px solid var(--c-eld-800);
  box-shadow: 0 2px 8px var(--shadow-ink);
}
.player-name {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--c-eld-300);
}
.player-text-wrap {
  width: 100%;
}
.player-text {
  color: var(--c-text-primary);
  font-family: $font-serif;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
