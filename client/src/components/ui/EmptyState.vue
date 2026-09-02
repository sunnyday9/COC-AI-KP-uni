<script setup lang="ts">
/**
 * EmptyState —— 空态引导（T2 基础基件，ADR-0004 UX 缺口：房间空/线索空/技能空）。
 * icon 用 AppIcon 线性图标；title + 可选 desc + 可选动作按钮（slot）。
 */
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    icon?: string
    title: string
    desc?: string
  }>(),
  { icon: 'scroll' },
)
</script>

<template>
  <view class="es">
    <view class="es-icon-wrap">
      <app-icon :name="icon" :size="22" class="es-icon" />
    </view>
    <text class="es-title">{{ title }}</text>
    <text v-if="desc" class="es-desc">{{ desc }}</text>
    <view v-if="$slots.action" class="es-action">
      <slot name="action" />
    </view>
  </view>
</template>

<style scoped lang="scss">
.es {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  text-align: center;
  box-sizing: border-box;
}
.es-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(51, 204, 166, 0.08);
  border: 1px solid rgba(51, 204, 166, 0.2);
  margin-bottom: 12px;
}
.es-icon {
  color: var(--c-eld-300);
}
.es-title {
  font-family: $font-serif;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text-primary);
}
.es-desc {
  display: block;
  margin-top: 6px;
  font-family: $font-serif;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text-secondary);
}
.es-action {
  margin-top: 16px;
}
</style>
