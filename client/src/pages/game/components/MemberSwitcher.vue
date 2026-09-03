<script setup lang="ts">
/**
 * MemberSwitcher —— 档案区成员切换器（T4 #31，ADR-0005 决策 8）。
 * 横向滚动胶囊 chips：列出自己 + 各成员（首字头像 + 用户名 + (我) + 绑卡标记），
 * 选中高亮。纯展示/选择组件，数据由父传入（roomStore.members），选中结果 emit。
 * 桌面右栏与移动 dossier sheet 共用；单人局单成员由父控制不渲染。
 * 样式对齐 lobby member-row / occupation filter-pill 哥特风。
 */
import type { RoomMemberInfo } from '../../../../../shared/types/room'

defineProps<{
  members: RoomMemberInfo[]
  selectedId: number | null
  selfUserId: number | null
}>()

const emit = defineEmits<{ select: [userId: number] }>()
</script>

<template>
  <scroll-view class="member-switcher" scroll-x :show-scrollbar="false">
    <view class="switcher-row">
      <view
        v-for="m in members"
        :key="m.userId"
        class="member-chip"
        :class="{ 'member-chip-active': m.userId === selectedId }"
        @click="emit('select', m.userId)"
      >
        <text class="chip-avatar">{{ m.username.charAt(0) }}</text>
        <text class="chip-name">{{ m.username }}</text>
        <text v-if="m.userId === selfUserId" class="chip-self">(我)</text>
        <text class="chip-bind" :class="m.characterId ? 'chip-bind-ok' : 'chip-bind-none'">
          {{ m.characterId ? '已绑卡' : '未绑卡' }}
        </text>
      </view>
    </view>
  </scroll-view>
</template>

<style scoped lang="scss">
/* 横向滚动 chips 行（scroll-view scroll-x 内容不换行） */
.member-switcher {
  width: 100%;
}
.switcher-row {
  display: inline-flex;
  align-items: center;
  padding: 2px 0;
}
.member-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 3px 10px;
  margin-right: 6px;
  border-radius: 9999px;
  border: 1px solid hsla(220, 14%, 16%, 0.55);
  background: hsla(220, 16%, 11%, 0.55);
  color: hsl(220, 10%, 58%);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  transition: all 0.2s;
}
.member-chip-active {
  background: hsla(165, 45%, 22%, 0.3);
  border-color: hsla(165, 55%, 32%, 0.55);
  color: hsl(165, 50%, 82%);
}
.member-chip:active {
  color: hsl(38, 25%, 55%);
  border-color: hsla(220, 12%, 22%, 0.6);
}
.chip-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  background: hsla(165, 45%, 22%, 0.5);
  border: 1px solid hsla(165, 55%, 28%, 0.4);
  color: hsl(165, 50%, 78%);
}
.chip-name {
  max-width: 96px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chip-self {
  font-size: 10px;
  color: hsl(220, 10%, 42%);
}
.chip-bind {
  font-size: 10px;
  margin-left: 1px;
}
.chip-bind-ok {
  color: hsl(165, 45%, 62%);
}
.chip-bind-none {
  color: hsl(0, 30%, 52%);
}
</style>
