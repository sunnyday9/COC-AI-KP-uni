<script setup lang="ts">
/**
 * ConfirmModal —— 危险/重要操作确认对话框（T2 基础基件，ADR-0004 设计稿 ModalConfirm）。
 * 跨端：不用 Teleport（小程序不支持），由页面在根节点条件渲染 <confirm-modal v-if>，
 * fixed 遮罩 + 居中面板。按钮分级：danger（血，确认删除类）/ warning（金）/ 默认（绿主）。
 * 按钮复用 ui/Button（#27 项 2），类名 .btn* 契约不变。
 */
import Button from './Button.vue'
withDefaults(
  defineProps<{
    /** 面板标题（如「删除这条调查？」） */
    title: string
    /** 正文说明（如「进度将永久删除，无法恢复。」） */
    message: string
    /** 确认按钮文案（默认「确认删除」→ 各页可按语境传，如「解散房间」） */
    confirmText?: string
    cancelText?: string
    /** 危险分级：danger=血实底危险主操作；warning=金；默认 primary 绿 */
    tone?: 'danger' | 'warning' | 'primary'
    /** 确认按钮 loading（删除中禁用防重复） */
    loading?: boolean
  }>(),
  {
    confirmText: '确认删除',
    cancelText: '取消',
    tone: 'danger',
    loading: false,
  },
)

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <view class="cm-mask" @click.self="emit('cancel')">
    <view class="cm-panel">
      <view class="cm-head">
        <text class="cm-title">{{ title }}</text>
        <text class="cm-close" @click="emit('cancel')">✕</text>
      </view>
      <text class="cm-msg">{{ message }}</text>
      <view class="cm-foot">
        <Button variant="ghost" extra-class="cm-btn" :disabled="loading" @click="emit('cancel')">
          {{ cancelText }}
        </Button>
        <Button
          :variant="tone === 'danger' ? 'danger-solid' : tone === 'warning' ? 'warning' : 'primary'"
          extra-class="cm-btn"
          :disabled="loading"
          @click="emit('confirm')"
        >
          {{ loading ? '处理中…' : confirmText }}
        </Button>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.cm-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 12, 0.72);
  backdrop-filter: blur(2px);
  padding: 24px;
  box-sizing: border-box;
}
.cm-panel {
  width: 360px;
  max-width: 100%;
  box-sizing: border-box;
  background: var(--c-card);
  border: 1px solid var(--c-outline);
  border-radius: 6px;
  box-shadow: 0 16px 40px rgba(8, 10, 12, 0.6);
  overflow: hidden;
}
.cm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
}
.cm-title {
  font-family: $font-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-primary);
}
.cm-close {
  color: var(--c-text-secondary);
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
}
.cm-msg {
  display: block;
  padding: 0 16px;
  font-family: $font-serif;
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  color: var(--c-text-secondary);
  box-sizing: border-box;
}
.cm-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
}
.cm-btn {
  height: 36px;
  padding: 0 0.875rem;
  font-size: 12px;
  min-width: 72px;
}
</style>
