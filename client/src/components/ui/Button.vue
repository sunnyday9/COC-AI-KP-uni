<script setup lang="ts">
/**
 * Button —— ADR-0004 设计稿 Btn 5 变体基础基件（#27 项 2）。
 * 渲染为原生 <button>（uni-app 编译为 uni-button；全站 e2e 用 uni-button + 文本定位，
 * 类名契约不动）。变体/禁用/按压态样式复用全局 .btn/.btn-* 令牌类（App.vue），
 * 组件只做 props → class 映射，视觉与既有按钮渐进一致。
 *
 * 迁移约定：页面已用「.btn + .btn-<variant>」类名的按钮可换本组件；
 * 旧 .gothic-btn* / 页面私有 .mini-btn 系保留原样（契约/视觉不动）。
 */
withDefaults(
  defineProps<{
    /** 5 变体：primary（绿实底）/ outline（绿描边）/ outline-danger / ghost / danger-solid / warning */
    variant?: 'primary' | 'outline' | 'outline-danger' | 'ghost' | 'danger-solid' | 'warning'
    /** 禁用（uni-app MP 无 :disabled 样式 → 全局 .btn:disabled + .is-disabled） */
    disabled?: boolean
    /** 原生 loading 属性（uni-app 编译支持）+ 文案置灰 */
    loading?: boolean
    /** 按压态类（MP 无 :active → hover-class；默认全局 .btn-hover-press） */
    pressClass?: string
    /** 附加类（布局覆盖，如 .action-btn/.picker-btn 的字体/尺寸） */
    extraClass?: string
  }>(),
  {
    variant: 'primary',
    disabled: false,
    loading: false,
    pressClass: 'btn-hover-press',
    extraClass: '',
  },
)

defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <button
    class="btn"
    :class="[`btn-${variant}`, extraClass, { 'is-disabled': disabled || loading }]"
    :disabled="disabled || loading"
    :loading="loading"
    :hover-class="(disabled || loading) ? 'none' : pressClass"
    @click="$emit('click')"
  >
    <slot />
  </button>
</template>
