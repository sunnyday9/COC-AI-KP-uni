<script setup lang="ts">
import { useToast } from '../../composables/useToast'

const { toasts, dismiss } = useToast()

const typeStyles: Record<string, string> = {
  success: 'toast-success',
  error: 'toast-error',
  info: 'toast-info',
  warning: 'toast-warning',
}

const typeIcons: Record<string, string> = {
  success: '\u2713',
  error: '\u2717',
  info: '\u2139',
  warning: '\u26A0',
}
</script>

<template>
  <!--
    Task 8 适配：原 Teleport to="body" 在小程序端不受支持 → 去掉 Teleport，
    由 AppLayout 在各页面根节点渲染本容器（position: fixed 固定于视口右上）。
    原 TransitionGroup（H5 only）→ CSS 进入动画（小程序端仅入场动画，无离场）。
  -->
  <view class="toast-stack">
    <view
      v-for="toast in toasts"
      :key="toast.id"
      class="toast-item toast-base"
      :class="typeStyles[toast.type] || typeStyles.info"
      @click="dismiss(toast.id)"
    >
      <text class="toast-icon">{{ typeIcons[toast.type] || typeIcons.info }}</text>
      <text class="toast-message">{{ toast.message }}</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 0.5rem;
  max-width: 320px;
  box-shadow: $shadow-ink-lg;
  animation: toast-in 0.3s ease-out;
}
.toast-icon {
  font-size: 1.125rem;
  font-weight: bold;
  flex-shrink: 0;
}
.toast-message {
  font-size: 0.875rem;
  line-height: 1.4;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateX(32px); }
  to { opacity: 1; transform: translateX(0); }
}

.toast-base {
  backdrop-filter: blur(12px);
}
.toast-success {
  background: hsla(165, 45%, 15%, 0.9);
  border: 1px solid hsla(165, 60%, 35%, 0.5);
  color: hsl(165, 50%, 85%);
  box-shadow: 0 4px 16px hsla(220, 20%, 4%, 0.5), 0 0 12px hsla(165, 60%, 35%, 0.15);
}
.toast-error {
  background: hsla(0, 50%, 15%, 0.9);
  border: 1px solid hsla(0, 65%, 35%, 0.5);
  color: hsl(0, 55%, 88%);
  box-shadow: 0 4px 16px hsla(220, 20%, 4%, 0.5), 0 0 12px hsla(0, 65%, 35%, 0.2);
}
.toast-info {
  background: hsla(220, 18%, 12%, 0.9);
  border: 1px solid hsla(165, 55%, 28%, 0.4);
  color: hsl(165, 50%, 85%);
  box-shadow: 0 4px 16px hsla(220, 20%, 4%, 0.5);
}
.toast-warning {
  background: hsla(42, 40%, 14%, 0.9);
  border: 1px solid hsla(42, 70%, 50%, 0.4);
  color: hsl(42, 65%, 88%);
  box-shadow: 0 4px 16px hsla(220, 20%, 4%, 0.5), 0 0 12px hsla(42, 70%, 50%, 0.15);
}
</style>
