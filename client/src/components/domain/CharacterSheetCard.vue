<script setup lang="ts">
/**
 * CharacterSheetCard —— 羊皮纸调查员档案卡（T3 领域组件，ADR-0004 设计稿 CharacterSheet）。
 * 仿 1920s 空白角色卡数字化：墨底 + 羊皮纸文字 + 徽记 + 档案编号。
 * 三处复用：桌面 game 右栏 / 建卡 Step3 预览 / game-end 结局卡。
 * 纯展示组件，接收 COCCharacterSheet；不含 store 依赖。
 */
import { computed } from 'vue'
import type { COCCharacterSheet } from '../../../../shared/types/character'
import { getSkillName } from '../../../../shared/coc/coc7'

const props = defineProps<{
  sheet: COCCharacterSheet
  /** 展示完整档案（属性格+核心技能+编号）还是紧凑（仅头+vitals） */
  variant?: 'full' | 'compact'
}>()

const ATTR_LABELS: Array<{ key: keyof COCCharacterSheet['attributes']; label: string }> = [
  { key: 'str', label: 'STR' },
  { key: 'con', label: 'CON' },
  { key: 'siz', label: 'SIZ' },
  { key: 'dex', label: 'DEX' },
  { key: 'int', label: 'INT' },
  { key: 'pow', label: 'POW' },
  { key: 'app', label: 'APP' },
  { key: 'edu', label: 'EDU' },
]

const attrs = computed(() => props.sheet.attributes)

/** 核心技能（职业技能优先，按值降序，取前 6） */
const coreSkills = computed(() => {
  const keys = props.sheet.occupationSkillKeys?.length
    ? props.sheet.occupationSkillKeys
    : Object.keys(props.sheet.skills ?? {})
  return keys
    .map((k) => ({ name: getSkillName(k), value: props.sheet.skills?.[k] ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)
})

const derived = computed(() => props.sheet.derived)
/** 档案编号（职业缩写 + 姓名 hash 尾号；无则省略） */
const recordNo = computed(() => {
  const occ = props.sheet.occupationName || ''
  const seg = occ ? `-${occ.slice(0, 2).toUpperCase()}` : ''
  const tail = String((props.sheet.playerName?.length ?? 0) * 37).padStart(4, '0')
  return `NO. 1926${seg}-${tail}`
})

/** 时代章：职业含「现代」→ 现代；否则 1920s（按职业字段粗判，后续可扩展） */
const era = computed(() => (props.sheet.occupationName?.includes('现代') ? '现代' : '1920s'))
</script>

<template>
  <view class="cs-card" :class="variant === 'compact' ? 'cs-compact' : ''">
    <!-- 头：姓氏章 + 姓名/职业 -->
    <view class="cs-head">
      <view class="cs-seal">
        <text class="cs-seal-char">{{ (sheet.playerName || '?').charAt(0) }}</text>
      </view>
      <view class="cs-id">
        <text class="cs-name">{{ sheet.playerName }}</text>
        <text class="cs-sub">SUBJECT RECORD · {{ sheet.occupationName || '未知职业' }}</text>
      </view>
      <view class="cs-era-badge">
        <text class="cs-era-text">{{ era }}</text>
      </view>
    </view>

    <view class="cs-divider" />

    <!-- 属性格 -->
    <view v-if="variant !== 'compact'" class="cs-attrs">
      <view v-for="a in ATTR_LABELS" :key="a.key" class="cs-attr-cell">
        <text class="cs-attr-val">{{ attrs[a.key] ?? 0 }}</text>
        <text class="cs-attr-label">{{ a.label }}</text>
      </view>
    </view>

    <!-- 核心数值 -->
    <view class="cs-vitals">
      <view class="cs-vital">
        <text class="cs-vital-label">SAN</text>
        <text class="cs-vital-val cs-vital-sanity">{{ derived?.san ?? 0 }}/{{ derived?.sanMax ?? 0 }}</text>
      </view>
      <view class="cs-vital">
        <text class="cs-vital-label">HP</text>
        <text class="cs-vital-val cs-vital-hp">{{ derived?.hp ?? 0 }}/{{ derived?.hpMax ?? 0 }}</text>
      </view>
      <view class="cs-vital">
        <text class="cs-vital-label">MP</text>
        <text class="cs-vital-val cs-vital-mp">{{ derived?.mp ?? 0 }}/{{ derived?.mpMax ?? 0 }}</text>
      </view>
      <view class="cs-vital">
        <text class="cs-vital-label">LUCK</text>
        <text class="cs-vital-val cs-vital-luck">{{ attrs.luck ?? 0 }}</text>
      </view>
    </view>

    <!-- 核心技能 -->
    <template v-if="variant !== 'compact'">
      <text class="cs-sec-label">核心技能</text>
      <view class="cs-skills">
        <view v-for="s in coreSkills" :key="s.name" class="cs-skill-row">
          <text class="cs-skill-name">{{ s.name }}</text>
          <text class="cs-skill-val">{{ s.value }}</text>
        </view>
      </view>

      <text class="cs-record-no">{{ recordNo }}</text>
    </template>
  </view>
</template>

<style scoped lang="scss">
.cs-card {
  width: 100%;
  max-width: 300px;
  box-sizing: border-box;
  padding: 12px;
  background: var(--c-paper-900);
  border: 1px solid var(--c-paper-700);
  border-radius: 4px;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--c-void) 20%, transparent);
}
.cs-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cs-seal {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  background: var(--c-eld-800);
  border: 1px solid var(--c-eld-300);
  border-radius: 2px;
}
.cs-seal-char {
  font-family: $font-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-eld-200);
}
.cs-id {
  min-width: 0;
  flex: 1;
}
.cs-name {
  display: block;
  font-family: $font-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-paper-100);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cs-sub {
  display: block;
  font-family: $font-body;
  font-size: 10px;
  color: var(--c-paper-500);
  letter-spacing: 0.1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cs-era-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--c-mana-900);
  border: 1px solid var(--c-mana-400);
}
.cs-era-text {
  font-family: $font-body;
  font-size: 10px;
  color: var(--c-mana-200);
}
.cs-divider {
  height: 1px;
  margin: 10px 0;
  background: var(--c-paper-700);
}
.cs-attrs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cs-attr-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: calc((100% - 12px) / 4);
  padding: 4px 0;
  background: color-mix(in srgb, var(--c-void) 50%, transparent);
  border-radius: 2px;
  box-sizing: border-box;
}
.cs-attr-val {
  font-family: $font-mono;
  font-size: 12px;
  color: var(--c-paper-200);
}
.cs-attr-label {
  font-family: $font-body;
  font-size: 8px;
  letter-spacing: 0.5px;
  color: var(--c-paper-500);
}
.cs-vitals {
  display: flex;
  gap: 8px;
  margin: 2px 0;
}
.cs-vital {
  flex: 1;
}
.cs-vital-label {
  display: block;
  font-family: $font-body;
  font-size: 10px;
  font-weight: 600;
  color: var(--c-paper-500);
}
.cs-vital-val {
  display: block;
  font-family: $font-mono;
  font-size: 15px;
}
.cs-vital-sanity { color: var(--c-sanity-300); }
.cs-vital-hp { color: var(--c-eld-300); }
.cs-vital-mp { color: var(--c-mana-300); }
.cs-vital-luck { color: var(--c-ritual-300); }
.cs-sec-label {
  display: block;
  margin: 8px 0 4px;
  font-family: $font-body;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--c-paper-500);
}
.cs-skills {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cs-skill-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  line-height: 1.5;
}
.cs-skill-name {
  font-family: $font-serif;
  color: var(--c-paper-100);
}
.cs-skill-val {
  font-family: $font-mono;
  color: var(--c-paper-200);
}
.cs-record-no {
  display: block;
  margin-top: 8px;
  font-family: $font-mono;
  font-size: 10px;
  color: var(--c-paper-600);
  text-align: right;
}
/* compact：仅头 + vitals（窄栏用） */
.cs-compact .cs-divider {
  margin: 8px 0;
}
</style>
