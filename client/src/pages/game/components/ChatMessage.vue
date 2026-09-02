<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../../../types/game'
import KPMessage from './KPMessage.vue'
import PlayerMessage from './PlayerMessage.vue'
import SystemMessage from './SystemMessage.vue'

/**
 * T4：聊天消息路由（ADR-0004 消息类型体系）——按 role 分发差异化组件。
 * - kp     → KPMessage（羊皮纸卡 + 徽记 + 流式光标 + 可选行动按钮）
 * - player → PlayerMessage（右侧 eldritch 描边气泡）
 * - system → SystemMessage（骰子/线索/伤害/属性/场景分隔/系统叙事）
 *
 * 对外契约（.option-btn / select-option 事件）保持 ChatMessage 现行为——
 * game 与 room 聊天流无感替换（ticket #19）。
 */
const props = defineProps<{ msg: Message }>()
const emit = defineEmits<{ (e: 'select-option', text: string): void }>()

const role = computed(() => props.msg.role)
</script>

<template>
  <kp-message v-if="role === 'kp'" :msg="msg" @select-option="(t: string) => emit('select-option', t)" />
  <player-message v-else-if="role === 'player'" :msg="msg" />
  <system-message v-else :msg="msg" />
</template>
