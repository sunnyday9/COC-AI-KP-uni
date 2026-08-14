<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../../types/game'

const props = defineProps<{ msg: Message }>()
const emit = defineEmits<{ (e: 'select-option', text: string): void }>()

function systemMsgType(msg: Message): 'dice' | 'hp' | 'san' | 'mp' | 'scene' | 'clue' | 'generic' {
  if ((msg as { type?: string }).type === 'dice') return 'dice'
  const c = msg.content ?? ''
  if (/^HP\s[+-]/.test(c)) return 'hp'
  if (/^SAN\s[+-]/.test(c)) return 'san'
  if (/^MP\s[+-]/.test(c)) return 'mp'
  if (c.startsWith('场景切换')) return 'scene'
  if (c.startsWith('获得线索')) return 'clue'
  return 'generic'
}

const parsedMessage = computed(() => {
  const content = props.msg.content ?? ''
  if (props.msg.role !== 'kp') return { text: content, options: [] }

  // During streaming, show raw text to prevent jitter
  if (props.msg.isStreaming) return { text: content, options: [] }

  // Try to find the options header
  const headerRegex = /(?:【?可选行动】?|你可以选择[：:]|接下来[你]?打算怎么做[？?]|选项[：:]|你[可以]?的选择[：:])\s*\n+/
  const match = content.match(headerRegex)

  if (match) {
    const mainText = content.substring(0, match.index).trim()
    const afterHeader = content.substring(match.index + match[0].length)

    const lines = afterHeader.split('\n')
    const options: string[] = []
    const trailingText: string[] = []
    let stillInList = true

    for (const line of lines) {
      if (line.trim() === '') continue

      const isListItem = /^(?:[-*+]|\d+\.)\s+/.test(line)
      if (stillInList && isListItem) {
        // Strip out the bullet/number and markdown bolding for cleaner buttons
        options.push(line.replace(/^(?:[-*+]|\d+\.)\s+/, '').replace(/\*\*/g, '').trim())
      } else {
        stillInList = false
        trailingText.push(line)
      }
    }

    if (options.length > 0 && options.length <= 6) {
      const finalMainText = mainText + (trailingText.length > 0 ? '\n\n' + trailingText.join('\n') : '')
      return { text: finalMainText || content, options }
    }
  } else {
    // Fallback: Check if there's just a raw list at the very end
    const fallbackRegex = /\n+((?:(?:[-*+]|\d+\.)\s+[^\n]+(?:\n|$))+)$/
    const fbMatch = content.match(fallbackRegex)
    if (fbMatch) {
      const mainText = content.substring(0, fbMatch.index).trim()
      const options = fbMatch[1]
        .split('\n')
        .map(line => line.replace(/^(?:[-*+]|\d+\.)\s+/, '').replace(/\*\*/g, '').trim())
        .filter(line => line.length > 0)

      if (options.length > 0 && options.length <= 6) {
        return { text: mainText || content, options }
      }
    }
  }

  return { text: content, options: [] }
})
</script>

<template>
  <!-- KP 消息：陈旧的羊皮纸残片 -->
  <view v-if="msg.role === 'kp'" class="msg-row kp-row animate-ink-spread">
    <view class="kp-msg">
      <view class="msg-head">
        <view class="kp-avatar"><text>K</text></view>
        <text class="kp-label">守密人</text>
      </view>
      <view class="kp-text-wrap">
        <text class="kp-text" decode>{{ parsedMessage.text }}<text v-if="msg.isStreaming" class="cursor-bar" /></text>
      </view>

      <!-- 解析出的可选行动 -->
      <view v-if="!msg.isStreaming && parsedMessage.options.length > 0" class="option-block">
        <text class="option-title">Possible Actions</text>
        <button
          v-for="(opt, idx) in parsedMessage.options"
          :key="idx"
          class="option-btn"
          @click="emit('select-option', opt)"
        >
          {{ opt }}
        </button>
      </view>
    </view>
  </view>

  <!-- 玩家消息 -->
  <view v-else-if="msg.role === 'player'" class="msg-row player-row animate-fade-in">
    <view class="player-msg">
      <text class="player-name">{{ msg.playerName }}</text>
      <view class="player-text-wrap"><text class="player-text" decode>{{ msg.content }}</text></view>
    </view>
  </view>

  <!-- 系统消息 -->
  <view v-else class="msg-row sys-row animate-slide-up">
    <view v-if="systemMsgType(msg) === 'dice'" class="sys-pill sys-dice">
      <text class="sys-icon">🎲</text><text decode>{{ msg.content }}</text>
    </view>
    <view v-else-if="systemMsgType(msg) === 'hp'" class="sys-pill sys-hp">
      <text class="sys-icon">♥</text><text decode>{{ msg.content }}</text>
    </view>
    <view v-else-if="systemMsgType(msg) === 'san'" class="sys-pill sys-san">
      <text class="sys-icon">◉</text><text decode>{{ msg.content }}</text>
    </view>
    <view v-else-if="systemMsgType(msg) === 'mp'" class="sys-pill sys-mp">
      <text class="sys-icon">✦</text><text decode>{{ msg.content }}</text>
    </view>
    <view v-else-if="systemMsgType(msg) === 'scene'" class="sys-scene-block">
      <view class="full-divider" />
      <view class="sys-scene"><text class="sys-icon">⛩</text><text decode>{{ msg.content }}</text></view>
      <view class="full-divider" />
    </view>
    <view v-else-if="systemMsgType(msg) === 'clue'" class="sys-pill sys-clue">
      <text class="sys-icon">📜</text><text decode>{{ msg.content }}</text>
    </view>
    <view v-else class="sys-pill sys-generic"><text decode>{{ msg.content }}</text></view>
  </view>
</template>

<style scoped lang="scss">
.msg-row {
  display: flex;
  width: 100%;
  box-sizing: border-box;
}
.kp-row { justify-content: flex-start; }
.player-row { justify-content: flex-end; }
.sys-row { justify-content: center; word-break: break-all; text-align: center; }

.kp-msg {
  max-width: 85%;
  border-radius: 0.75rem;
  border-top-left-radius: 2px;
  padding: 16px 20px;
  background: hsla(38, 18%, 18%, 0.35);
  border: 1px solid hsla(38, 20%, 30%, 0.25);
  border-left: 3px solid hsla(165, 60%, 35%, 0.35);
  box-shadow: 0 2px 8px hsla(220, 20%, 4%, 0.4), inset 0 0 30px hsla(38, 18%, 18%, 0.1);
}
.msg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.kp-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-family: $font-display;
  background: hsla(165, 45%, 22%, 0.5);
  border: 1px solid hsla(165, 55%, 28%, 0.4);
  color: hsl(165, 50%, 78%);
}
.kp-label {
  font-size: 12px;
  font-family: $font-display;
  letter-spacing: 0.05em;
  color: hsl(38, 25%, 55%);
}
.kp-text-wrap {
  width: 100%;
}
.kp-text {
  color: hsl(38, 40%, 78%);
  font-family: $font-serif;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.cursor-bar {
  display: inline-block;
  width: 6px;
  height: 16px;
  margin-left: 4px;
  border-radius: 2px;
  background: hsl(165, 60%, 35%);
  animation: pulse-slow 1s ease-in-out infinite;
}
.option-block {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  padding-top: 12px;
}
.option-title {
  font-size: 10px;
  font-family: $font-mono;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: hsl(220, 8%, 50%);
  margin-bottom: 4px;
}
.option-btn {
  text-align: left;
  padding: 8px 12px;
  font-size: 14px;
  font-family: $font-serif;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.05);
  color: hsl(220, 8%, 50%);
  line-height: 1.5;
  box-sizing: border-box;
  transition: all 0.2s;
}
.option-btn:active,
.option-btn:hover {
  background: rgba(0, 0, 0, 0.4);
  color: hsl(38, 40%, 78%);
}

.player-msg {
  max-width: 85%;
  border-radius: 0.75rem;
  border-top-right-radius: 2px;
  padding: 16px 20px;
  background: hsla(220, 16%, 14%, 0.7);
  border: 1px solid hsla(220, 14%, 22%, 0.5);
  box-shadow: 0 2px 8px hsla(220, 20%, 4%, 0.3);
}
.player-name {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
  color: hsl(165, 50%, 65%);
}
.player-text-wrap { width: 100%; }
.player-text {
  color: hsl(38, 35%, 75%);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.sys-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 9999px;
  font-size: 14px;
  font-weight: 500;
}
.sys-icon { font-size: 1rem; }
.sys-dice {
  background: hsla(42, 50%, 30%, 0.3);
  border: 1px solid hsla(42, 70%, 50%, 0.35);
  color: hsl(42, 65%, 80%);
  box-shadow: 0 0 12px hsla(42, 70%, 50%, 0.15);
}
.sys-hp {
  background: hsla(0, 50%, 15%, 0.4);
  border: 1px solid hsla(0, 65%, 35%, 0.35);
  color: hsl(0, 55%, 82%);
  box-shadow: 0 0 12px hsla(0, 65%, 35%, 0.2);
}
.sys-san {
  background: hsla(260, 35%, 18%, 0.4);
  border: 1px solid hsla(260, 50%, 45%, 0.35);
  color: hsl(260, 45%, 80%);
  box-shadow: 0 0 12px hsla(260, 50%, 45%, 0.2);
}
.sys-mp {
  background: hsla(210, 40%, 15%, 0.4);
  border: 1px solid hsla(210, 60%, 45%, 0.35);
  color: hsl(210, 50%, 78%);
  box-shadow: 0 0 12px hsla(210, 60%, 45%, 0.15);
}
.sys-scene-block {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 8px;
}
.full-divider {
  width: 100%;
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    hsl(220, 14%, 16%),
    hsla(165, 60%, 35%, 0.2),
    hsl(220, 14%, 16%),
    transparent
  );
}
.sys-scene {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  font-family: $font-display;
  font-size: 14px;
  letter-spacing: 0.1em;
  color: hsl(165, 50%, 65%);
}
.sys-clue {
  background: hsla(38, 18%, 18%, 0.4);
  border: 1px solid hsla(38, 20%, 30%, 0.35);
  color: hsl(38, 40%, 78%);
  box-shadow: 0 0 12px hsla(38, 40%, 50%, 0.1);
}
.sys-generic {
  background: hsla(220, 16%, 11%, 0.6);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
  color: hsl(220, 10%, 30%);
}
</style>
