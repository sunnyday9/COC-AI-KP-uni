<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoomStore } from '../../../stores/roomStore'
import { getSkillName } from '../../../../../shared/coc/coc7'
import type { COCAttributes } from '../../../types/character'

/** 服务端权威角色卡（state_patch 推平，ADR-0002）：自己绑定的卡即属性来源。 */
const roomStore = useRoomStore()

const showSkills = ref(false)
const char = computed(() => roomStore.selfCharacterSheet)
const derived = computed(() => {
  return char.value?.derived ?? { hp: 0, hpMax: 0, mp: 0, mpMax: 0, san: 0, sanMax: 0 }
})
const skills = computed(() => {
  const s = char.value?.skills ?? {}
  return Object.entries(s)
    .filter(([, v]) => v > 0)
    .sort(([a], [b]) => a.localeCompare(b))
})
const attributes = computed((): COCAttributes => char.value?.attributes ?? {
  str: 0, con: 0, siz: 0, dex: 0, app: 0, int: 0, pow: 0, edu: 0, luck: 0,
})

const hpPct = computed(() => {
  const max = derived.value.hpMax
  return max > 0 ? Math.min(100, Math.max(0, (derived.value.hp / max) * 100)) : 0
})
const sanPct = computed(() => {
  const max = derived.value.sanMax
  return max > 0 ? Math.min(100, Math.max(0, (derived.value.san / max) * 100)) : 0
})
</script>

<template>
  <view v-if="char" class="stats-root">
    <!-- 主状态条 -->
    <view class="dossier-bar">
      <!-- 角色身份 -->
      <view class="identity">
        <view class="avatar-stamp"><text>{{ char.playerName.charAt(0) }}</text></view>
        <view class="identity-text">
          <text class="dossier-name">{{ char.playerName }}</text>
          <text class="record-label">Subject Record</text>
        </view>
      </view>

      <!-- 核心数值 -->
      <view class="core-stats">
        <view class="stat-block">
          <text class="stat-label">SAN</text>
          <view class="stat-values" :class="{ 'san-critical': sanPct <= 30 }">
            <text class="stat-current">{{ derived.san }}</text>
            <text class="stat-divider">/</text>
            <text class="stat-max">{{ derived.sanMax }}</text>
          </view>
        </view>
        <view class="stat-block">
          <text class="stat-label">HP</text>
          <view class="stat-values" :class="{ 'hp-critical': hpPct <= 25 }">
            <text class="stat-current">{{ derived.hp }}</text>
            <text class="stat-divider">/</text>
            <text class="stat-max">{{ derived.hpMax }}</text>
          </view>
        </view>
        <view class="stat-block">
          <text class="stat-label">MP</text>
          <view class="stat-values">
            <text class="stat-current">{{ derived.mp }}</text>
            <text class="stat-divider">/</text>
            <text class="stat-max">{{ derived.mpMax }}</text>
          </view>
        </view>
        <view class="stat-block">
          <text class="stat-label">LUCK</text>
          <view class="stat-values luck-values">
            <text class="stat-current">{{ attributes.luck }}</text>
          </view>
        </view>
      </view>

      <!-- 属性条（桌面 xl+） -->
      <view class="attr-strip">
        <text>STR.{{ attributes.str }}</text><text class="attr-dot">·</text>
        <text>CON.{{ attributes.con }}</text><text class="attr-dot">·</text>
        <text>SIZ.{{ attributes.siz }}</text><text class="attr-dot">·</text>
        <text>DEX.{{ attributes.dex }}</text><text class="attr-dot">·</text>
        <text>INT.{{ attributes.int }}</text><text class="attr-dot">·</text>
        <text>POW.{{ attributes.pow }}</text><text class="attr-dot">·</text>
        <text>EDU.{{ attributes.edu }}</text>
      </view>

      <!-- 技能抽屉开关 -->
      <button
        v-if="skills.length > 0"
        class="classified-tab"
        :class="{ 'tab-active': showSkills }"
        @click="showSkills = !showSkills"
      >
        <view class="dot" :class="showSkills ? 'dot-on' : 'dot-off'" />
        <text>[ CLASSIFIED: SKILLS ]</text>
      </button>
    </view>

    <!-- 技能抽屉（绝对覆盖层） -->
    <view v-if="showSkills && skills.length > 0" class="skills-drawer animate-slide-up">
      <view class="drawer-head">
        <text class="drawer-title">Investigator Competencies</text>
        <button class="drawer-close" @click="showSkills = false"><text>[ CLOSE ]</text></button>
      </view>
      <view class="skills-grid">
        <view v-for="[name, val] in skills" :key="name" class="skill-cell">
          <text class="skill-name">{{ getSkillName(name) }}</text>
          <text class="skill-val">{{ val }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.stats-root {
  position: relative;
  z-index: 20;
  flex-shrink: 0;
}

.dossier-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 32px;
  padding: 16px 24px;
  background: hsla(220, 18%, 7%, 0.95);
  border-top: 1px solid hsla(220, 14%, 22%, 0.8);
  box-shadow: 0 -4px 24px hsla(220, 20%, 4%, 0.8);
  backdrop-filter: blur(12px);
}

.identity {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  margin-right: 16px;
}
.avatar-stamp {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: $font-display;
  font-size: 1.125rem;
  background: hsla(38, 18%, 18%, 0.4);
  border: 1px solid hsla(38, 20%, 30%, 0.3);
  color: hsl(38, 35%, 68%);
  box-shadow: inset 0 0 10px hsla(220, 20%, 4%, 0.5);
}
.identity-text {
  display: flex;
  flex-direction: column;
}
.dossier-name {
  font-family: $font-serif;
  font-size: 0.875rem;
  letter-spacing: 0.05em;
  color: hsl(38, 50%, 88%);
}
.record-label {
  font-family: $font-mono;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: hsl(220, 8%, 50%);
}

.core-stats {
  display: flex;
  align-items: flex-end;
  gap: 32px;
  flex: 1;
  min-width: 300px;
}
.stat-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.stat-label {
  font-family: $font-mono;
  font-size: 0.65rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: hsl(220, 10%, 40%);
}
.stat-values {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-family: $font-serif;
}
.stat-current {
  font-size: 1.75rem;
  line-height: 1;
  color: hsl(38, 40%, 78%);
  transition: all 0.3s;
}
.stat-divider {
  font-size: 1rem;
  color: hsl(220, 10%, 30%);
}
.stat-max {
  font-size: 1rem;
  color: hsl(220, 10%, 40%);
}

/* 危险状态 */
.san-critical .stat-current {
  color: hsl(330, 60%, 65%);
  text-shadow: 0 0 12px hsla(330, 60%, 50%, 0.6), 0 0 24px hsla(330, 60%, 40%, 0.4);
  animation: sanity-flicker 3s ease-in-out infinite alternate;
}
.hp-critical .stat-current {
  color: hsl(0, 60%, 60%);
  text-shadow: 0 0 12px hsla(0, 65%, 45%, 0.6);
  animation: pulse-slow 2s ease-in-out infinite;
}
.luck-values .stat-current {
  color: hsl(42, 50%, 60%);
  font-size: 1.25rem;
}

/* 属性条（桌面 xl+） */
.attr-strip {
  display: none;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-family: $font-mono;
  letter-spacing: 0.15em;
  padding: 4px 16px;
  background: hsla(220, 16%, 11%, 0.5);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
  border-radius: 4px;
  color: hsl(220, 10%, 40%);
}
@media (min-width: 1280px) {
  .attr-strip {
    display: flex;
  }
}
.attr-dot {
  color: hsl(220, 14%, 22%);
}

/* 分类标签按钮 */
.classified-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding: 6px 12px;
  flex-shrink: 0;
  font-family: $font-mono;
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  color: hsl(220, 10%, 40%);
  background: hsla(220, 16%, 11%, 0.6);
  border: 1px solid hsla(220, 14%, 22%, 0.4);
  border-radius: 4px;
  line-height: 1.4;
}
.classified-tab:active,
.tab-active {
  color: hsl(38, 35%, 68%);
  border-color: hsla(38, 30%, 40%, 0.4);
  background: hsla(220, 16%, 14%, 0.8);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.dot-on { background: $c-eldritch-400; }
.dot-off { background: hsl(220, 8%, 50%); }

/* 技能抽屉 */
.skills-drawer {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 100%;
  padding: 24px;
  box-sizing: border-box;
  background: hsla(220, 18%, 6%, 0.96);
  border-top: 1px solid hsla(38, 20%, 30%, 0.2);
  backdrop-filter: blur(16px);
  max-height: 50vh;
  overflow-y: auto;
  box-shadow: 0 -8px 32px hsla(220, 20%, 4%, 0.7);
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.drawer-title {
  font-family: $font-display;
  font-size: 1.125rem;
  letter-spacing: 0.1em;
  color: hsl(38, 40%, 78%);
}
.drawer-close {
  background: transparent;
  border: none;
  padding: 0;
  font-family: $font-mono;
  font-size: 12px;
  color: hsl(220, 8%, 50%);
  line-height: 1.4;
}
.skills-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 24px;
}
@media (min-width: 768px) {
  .skills-grid { grid-template-columns: repeat(3, 1fr); }
}
@media (min-width: 1024px) {
  .skills-grid { grid-template-columns: repeat(4, 1fr); }
}
.skill-cell {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.skill-name {
  font-family: $font-serif;
  font-size: 0.875rem;
  color: hsl(220, 8%, 50%);
}
.skill-val {
  font-family: $font-mono;
  font-size: 0.875rem;
  color: hsl(38, 30%, 60%);
}

/* 动画 */
@keyframes sanity-flicker {
  0%, 100% { opacity: 1; text-shadow: 0 0 12px hsla(330, 60%, 50%, 0.6); }
  30% { opacity: 0.8; text-shadow: 0 0 16px hsla(330, 60%, 50%, 0.8); }
  40% { opacity: 1; text-shadow: 0 0 8px hsla(330, 60%, 50%, 0.4); }
  80% { opacity: 0.9; text-shadow: 0 0 20px hsla(330, 60%, 50%, 0.7); }
}
</style>
