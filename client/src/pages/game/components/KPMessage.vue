<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../../../types/game'
import AppIcon from '../../../components/ui/AppIcon.vue'

/**
 * T4：KP 消息（ADR-0004）——左对齐羊皮纸卡 + 徽记 + 流式光标。
 * 「可选行动」解析保留 ChatMessage 现行为：选项按钮点击 → emit select-option(text)。
 */
const props = defineProps<{ msg: Message }>()
const emit = defineEmits<{ (e: 'select-option', text: string): void }>()

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
  <view class="msg-row kp-row">
    <view class="kp-msg">
      <view class="msg-head">
        <app-icon name="dice" :size="14" class="kp-sigil" />
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
</template>

<style scoped lang="scss">
.msg-row {
  display: flex;
  width: 100%;
  box-sizing: border-box;
}
.kp-row {
  justify-content: flex-start;
}

/* KP 卡：羊皮纸残片 + 左上暗金徽记 */
.kp-msg {
  max-width: 85%;
  border-radius: 0.75rem;
  border-top-left-radius: 2px;
  padding: 14px 18px;
  background: var(--c-paper-900);
  border: 1px solid var(--c-paper-800);
  border-left: 3px solid var(--c-eld-500);
  box-shadow: 0 2px 10px var(--shadow-ink), inset 0 0 24px var(--c-paper-900);
  color: var(--c-paper-200);
}
.msg-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
}
.kp-sigil {
  color: var(--c-eld-400);
  flex-shrink: 0;
}
.kp-label {
  font-size: 12px;
  font-family: $font-display;
  letter-spacing: 0.08em;
  color: var(--c-paper-400);
}
.kp-text-wrap {
  width: 100%;
}
.kp-text {
  color: var(--c-paper-200);
  font-family: $font-serif;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.cursor-bar {
  display: inline-block;
  width: 6px;
  height: 15px;
  margin-left: 4px;
  border-radius: 2px;
  background: var(--c-eld-400);
  animation: pulse-slow 1s ease-in-out infinite;
}

/* 选项按钮：暗色可点面板（.option-btn 契约保留） */
.option-block {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px dashed var(--c-paper-800);
  padding-top: 12px;
}
.option-title {
  font-size: 10px;
  font-family: $font-mono;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--c-paper-600);
  margin-bottom: 2px;
}
.option-btn {
  text-align: left;
  padding: 9px 13px;
  font-size: 13.5px;
  font-family: $font-serif;
  line-height: 1.5;
  border-radius: 8px;
  background: var(--c-card);
  border: 1px solid var(--c-outline-weak);
  color: var(--c-text-secondary);
  transition: all 0.2s;
  box-sizing: border-box;
}
.option-btn:active,
.option-btn:hover {
  background: var(--c-hover);
  color: var(--c-eld-200);
  border-color: var(--c-eld-700);
}
</style>
