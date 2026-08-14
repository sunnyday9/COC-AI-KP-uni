<script setup lang="ts">
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { storeToRefs } from 'pinia'
import { useGameStore } from '../../../stores/gameStore'
import { OCCUPATION_SKILL_VALUES, PERSONAL_INTEREST_BONUS, PERSONAL_INTEREST_COUNT } from '../../../types/character'
import {
  COC7_OCCUPATIONS,
  COC7_SKILLS,
  INTERPERSONAL_SKILL_IDS,
  getSkillName,
} from '../../../data/coc7'
import {
  buildCharacterSheet as buildSheet,
  rollAttributes,
  getSkillBase,
} from '../../../logic/coc7Character'
import type { COCAttributes } from '../../../types/character'
import AppLayout from '../../../components/layout/AppLayout.vue'

const gameStore = useGameStore()
const { selectedOccupationId, selectedOccupationName } = storeToRefs(gameStore)

/**
 * 背景图（Task 9 分包）：H5 走主包 public 目录；MP 子包页面引用子包内 static。
 */
// #ifdef H5
const pageBg = '/static/bg/bg_desk.webp'
// #endif
// #ifndef H5
const pageBg = '/pages/character/static/bg_desk.webp'
// #endif

const occupation = computed(() =>
  COC7_OCCUPATIONS.find((o) => o.id === selectedOccupationId.value) ?? null
)

const occupationSkillKeys = ref<string[]>([])
const slotTypes = ref<('fixed' | 'interpersonal' | 'any')[]>([])
const attributes = ref<COCAttributes | null>(null)
const personalInterestKeys = ref<string[]>(['', '', '', ''])
const playerName = ref('调查员')
const attrAnimating = ref(false)

function availableForAnySlot(slotIndex: number): string[] {
  const keys = occupationSkillKeys.value
  const used = new Set<string>()
  keys.forEach((k, idx) => {
    if (k && idx !== slotIndex) used.add(k)
  })
  return COC7_SKILLS.filter((s) => s.id !== 'Cthulhu Mythos' && (!used.has(s.id) || keys[slotIndex] === s.id)).map((s) => s.id)
}

function availableForInterpersonalSlot(slotIndex: number): string[] {
  const occKeys = occupationSkillKeys.value
  const used = new Set<string>()
  occKeys.forEach((k, idx) => {
    if (k && idx !== slotIndex) used.add(k)
  })
  return INTERPERSONAL_SKILL_IDS.filter((id) => !used.has(id) || occKeys[slotIndex] === id)
}

function interestSkillLabel(skillId: string): string {
  const occIdx = occupationSkillKeys.value.indexOf(skillId)
  const base = getSkillBase(skillId)
  if (occIdx >= 0 && OCCUPATION_SKILL_VALUES[occIdx] != null) {
    const occVal = OCCUPATION_SKILL_VALUES[occIdx]
    return `${getSkillName(skillId)} (职业${occVal}% → ${Math.min(99, occVal + PERSONAL_INTEREST_BONUS)}%)`
  }
  return `${getSkillName(skillId)} (基础${base}% → ${Math.min(99, base + PERSONAL_INTEREST_BONUS)}%)`
}

function availableForInterestSlot(slotIndex: number): string[] {
  const interestKeys = personalInterestKeys.value
  const used = new Set<string>()
  interestKeys.forEach((k, idx) => {
    if (k && idx !== slotIndex) used.add(k)
  })
  return COC7_SKILLS.filter(
    (s) => s.id !== 'Cthulhu Mythos' && (!used.has(s.id) || interestKeys[slotIndex] === s.id)
  ).map((s) => s.id)
}

function initOccupationSlots() {
  if (!occupation.value) return
  const template = occupation.value.skillTemplate
  const keys: string[] = []
  const types: ('fixed' | 'interpersonal' | 'any')[] = []
  for (let i = 0; i < 8; i++) {
    const t = template[i]
    if (t === 'interpersonal') {
      keys.push(INTERPERSONAL_SKILL_IDS[0])
      types.push('interpersonal')
    } else if (t === 'any') {
      keys.push('')
      types.push('any')
    } else {
      keys.push(t ?? '')
      types.push('fixed')
    }
  }
  keys.push('Credit Rating')
  types.push('fixed')
  occupationSkillKeys.value = keys
  slotTypes.value = types
}

function setSlotSkill(index: number, skillId: string) {
  const next = [...occupationSkillKeys.value]
  next[index] = skillId
  occupationSkillKeys.value = next
}

function setPersonalInterest(index: number, skillId: string) {
  const next = [...personalInterestKeys.value]
  next[index] = skillId
  personalInterestKeys.value = next
}

/** picker 选项（含占位项） */
interface PickerOpt { id: string; label: string }

function slotPickerOptions(slotIndex: number): PickerOpt[] {
  const t = slotTypes.value[slotIndex]
  const ids = t === 'interpersonal'
    ? availableForInterpersonalSlot(slotIndex)
    : availableForAnySlot(slotIndex)
  return [{ id: '', label: '— 选择技能 —' }, ...ids.map((id) => ({ id, label: getSkillName(id) }))]
}

function slotPickerIndex(slotIndex: number, opts: PickerOpt[]): number {
  const cur = occupationSkillKeys.value[slotIndex]
  const idx = opts.findIndex((o) => o.id === cur)
  return idx >= 0 ? idx : 0
}

function onSlotChange(slotIndex: number, opts: PickerOpt[], e: { detail: { value: string | number } }) {
  const opt = opts[Number(e.detail.value)]
  setSlotSkill(slotIndex, opt ? opt.id : '')
}

function interestPickerOptions(slotIndex: number): PickerOpt[] {
  const ids = availableForInterestSlot(slotIndex)
  return [{ id: '', label: '— 选择 —' }, ...ids.map((id) => ({ id, label: interestSkillLabel(id) }))]
}

function interestPickerIndex(slotIndex: number, opts: PickerOpt[]): number {
  const cur = personalInterestKeys.value[slotIndex]
  const idx = opts.findIndex((o) => o.id === cur)
  return idx >= 0 ? idx : 0
}

function onInterestChange(slotIndex: number, opts: PickerOpt[], e: { detail: { value: string | number } }) {
  const opt = opts[Number(e.detail.value)]
  setPersonalInterest(slotIndex, opt ? opt.id : '')
}

function rollAttrs() {
  attrAnimating.value = true
  attributes.value = rollAttributes()
  setTimeout(() => { attrAnimating.value = false }, 600)
}

function canConfirm(): boolean {
  if (!occupation.value || !attributes.value || !playerName.value.trim()) return false
  const occ = occupationSkillKeys.value
  if (occ.length !== 9 || occ.some((k) => !k)) return false
  const pers = personalInterestKeys.value.filter(Boolean)
  if (pers.length < PERSONAL_INTEREST_COUNT) return false
  return true
}

function confirm() {
  if (!canConfirm() || !occupation.value || !attributes.value) return
  const sheet = buildSheet(
    occupation.value.id,
    occupation.value.name,
    playerName.value.trim(),
    occupationSkillKeys.value,
    personalInterestKeys.value.filter(Boolean),
    attributes.value
  )
  gameStore.setCharacterSheet(sheet)
  gameStore.confirmCharacterAndEnterGame()
  uni.redirectTo({ url: '/pages/game/index' })
}

function goBackOccupation() {
  uni.navigateBack({
    fail: () => uni.redirectTo({ url: '/pages/character/occupation/index' }),
  })
}

// 原 onMounted：无已选职业 → router.replace('/occupation')；uni 返回上一页等价
onLoad(() => {
  if (!selectedOccupationId.value) {
    uni.redirectTo({ url: '/pages/character/occupation/index' })
    return
  }
  initOccupationSlots()
})
</script>

<template>
  <app-layout active="home" :bg="pageBg" :overlay="0.7">
    <view class="page-root">
      <!-- 进度指示 -->
      <view class="page-head">
        <view class="steps">
          <view class="step-item">
            <view class="step-circle step-done"><text>✓</text></view>
            <text class="step-label step-label-dim">选择职业</text>
          </view>
          <view class="step-line step-line-active" />
          <view class="step-item">
            <view class="step-circle step-active"><text>2</text></view>
            <text class="step-label step-label-on">技能与属性</text>
          </view>
          <view class="step-line step-line-dim" />
          <view class="step-item">
            <view class="step-circle step-dim"><text>3</text></view>
            <text class="step-label">进入游戏</text>
          </view>
        </view>

        <text class="page-title">创建角色</text>
        <text class="page-desc">
          职业：<text class="occupation-name">{{ selectedOccupationName }}</text>
        </text>
        <view class="head-divider ink-divider" />
      </view>

      <!-- 内容 -->
      <view class="page-body">
        <!-- 职业技能 -->
        <view class="gothic-card section-card">
          <view class="section-head">
            <text class="section-title">⚔ 职业技能</text>
            <text class="section-hint">(9 项：70, 60, 60, 50, 50, 50, 40, 40, 40)</text>
          </view>
          <view class="slot-list">
            <view v-for="(key, i) in occupationSkillKeys" :key="i" class="slot-row">
              <text class="slot-value" :style="{ color: (OCCUPATION_SKILL_VALUES[i] ?? 0) >= 60 ? 'hsl(38, 35%, 68%)' : 'hsl(220, 10%, 30%)' }">
                {{ OCCUPATION_SKILL_VALUES[i] ?? 0 }}%
              </text>

              <!-- 固定技能 -->
              <text v-if="slotTypes[i] === 'fixed'" class="fixed-skill">{{ getSkillName(key) }}</text>

              <!-- 可选技能（picker 替代原生 select） -->
              <picker
                v-else
                :range="slotPickerOptions(i)"
                range-key="label"
                :value="slotPickerIndex(i, slotPickerOptions(i))"
                @change="onSlotChange(i, slotPickerOptions(i), $event)"
              >
                <view class="picker-view" :class="{ 'picker-empty': !occupationSkillKeys[i] }">
                  {{ occupationSkillKeys[i] ? getSkillName(occupationSkillKeys[i]) : '— 选择技能 —' }}
                </view>
              </picker>
            </view>
          </view>
        </view>

        <!-- 属性投掷 -->
        <view class="gothic-card section-card">
          <view class="section-head">
            <text class="section-title">🎲 属性投掷</text>
            <text class="section-hint">(3d6×5)</text>
          </view>
          <button class="gothic-btn roll-btn" @click="rollAttrs">
            {{ attributes ? '重新投掷' : '投掷属性' }}
          </button>
          <view v-if="attributes" class="attr-grid" :class="{ 'animate-fade-in': attrAnimating }">
            <view v-for="(v, k) in attributes" :key="k" class="attr-cell">
              <text class="attr-key">{{ k }}</text>
              <text class="attr-val">{{ v }}</text>
            </view>
          </view>
        </view>

        <!-- 兴趣技能 -->
        <view class="gothic-card section-card">
          <view class="section-head">
            <text class="section-title">✦ 兴趣技能</text>
            <text class="section-hint">(任选 4 项，每项 +20%，可与职业技能重叠叠加)</text>
          </view>
          <view class="slot-list">
            <view v-for="(pk, idx) in personalInterestKeys" :key="idx" class="slot-row">
              <text class="interest-bonus">+{{ PERSONAL_INTEREST_BONUS }}%</text>
              <picker
                :range="interestPickerOptions(idx)"
                range-key="label"
                :value="interestPickerIndex(idx, interestPickerOptions(idx))"
                @change="onInterestChange(idx, interestPickerOptions(idx), $event)"
              >
                <view class="picker-view flex-1" :class="{ 'picker-empty': !personalInterestKeys[idx] }">
                  {{ personalInterestKeys[idx] ? interestSkillLabel(personalInterestKeys[idx]) : '— 选择 —' }}
                </view>
              </picker>
            </view>
          </view>
        </view>

        <!-- 调查员姓名 -->
        <view class="gothic-card section-card">
          <view class="section-head">
            <text class="section-title">✎ 调查员姓名</text>
          </view>
          <input
            v-model="playerName"
            class="gothic-input name-input"
            placeholder="调查员"
            placeholder-class="gothic-ph"
          />
        </view>

        <!-- 操作按钮 -->
        <view class="actions">
          <button class="gothic-btn-secondary action-btn" @click="goBackOccupation">返回选职业</button>
          <button
            class="gothic-btn action-btn"
            :class="{ 'is-disabled': !canConfirm() }"
            hover-class="confirm-btn-hover"
            @click="confirm"
          >
            确认角色并进入游戏
          </button>
        </view>
      </view>
    </view>
  </app-layout>
</template>

<style scoped lang="scss">
.page-root {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  width: 100%;
}

.page-head {
  padding: 32px 24px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
}
.steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 24px;
}
.step-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.step-circle {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  font-family: $font-display;
}
.step-active {
  background: hsla(165, 45%, 22%, 0.6);
  border: 1px solid hsl(165, 55%, 28%);
  color: hsl(165, 50%, 78%);
  box-shadow: 0 0 10px hsla(165, 60%, 35%, 0.2);
}
.step-done {
  background: hsla(165, 40%, 15%, 0.5);
  border: 1px solid hsla(165, 45%, 22%, 0.5);
  color: hsl(165, 50%, 60%);
}
.step-dim {
  background: hsl(220, 16%, 11%);
  border: 1px solid hsl(220, 14%, 16%);
  color: hsl(220, 10%, 25%);
}
.step-line {
  width: 32px;
  height: 1px;
}
.step-line-dim { background: hsl(220, 14%, 16%); }
.step-line-active { background: hsl(165, 55%, 28%); }
.step-label {
  font-size: 12px;
  color: hsl(220, 10%, 45%);
}
.step-label-on {
  font-weight: 500;
  color: hsl(38, 35%, 85%);
}
.step-label-dim {
  color: hsl(220, 10%, 60%);
}
.page-title {
  display: block;
  font-family: $font-display;
  font-size: 1.5rem;
  font-weight: bold;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
}
.page-desc {
  display: block;
  margin-top: 4px;
  font-size: 0.875rem;
  color: hsl(220, 10%, 60%);
}
.occupation-name {
  font-family: $font-display;
  color: hsl(38, 50%, 75%);
  text-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}
.head-divider {
  margin: 12px auto 0;
  max-width: 80px;
}

.page-body {
  flex: 1;
  padding: 0 24px 48px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.section-card {
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
}
.section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.section-title {
  font-family: $font-display;
  font-size: 1rem;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
  letter-spacing: 0.05em;
}
.section-hint {
  font-size: 12px;
  font-weight: normal;
  color: hsl(220, 10%, 60%);
}

.slot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.slot-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.slot-value {
  width: 40px;
  text-align: right;
  font-size: 12px;
  font-family: $font-mono;
  font-weight: bold;
  flex-shrink: 0;
}
.fixed-skill {
  font-size: 0.875rem;
  font-family: $font-serif;
  font-weight: 500;
  color: hsl(38, 40%, 78%);
}
.picker-view {
  min-width: 192px;
  max-width: 320px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
  background: hsla(220, 18%, 7%, 0.85);
  color: hsl(38, 40%, 78%);
  border: 1px solid hsl(220, 14%, 16%);
  box-sizing: border-box;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.picker-empty {
  color: hsl(220, 10%, 30%);
}
.flex-1 {
  flex: 1;
}

.roll-btn {
  padding: 4px 20px;
  font-size: 0.875rem;
}
.attr-grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.attr-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  background: hsla(220, 16%, 11%, 0.6);
  border: 1px solid hsla(220, 14%, 16%, 0.5);
}
.attr-key {
  font-size: 12px;
  font-weight: bold;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-family: $font-mono;
  color: hsl(220, 10%, 30%);
}
.attr-val {
  font-family: $font-mono;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
}

.interest-bonus {
  width: 40px;
  text-align: right;
  font-size: 12px;
  font-family: $font-mono;
  flex-shrink: 0;
  color: hsl(165, 50%, 50%);
}

.name-input {
  max-width: 320px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0 16px;
  flex-wrap: wrap;
}
.action-btn {
  font-size: 0.875rem;
}
/* 确认主 CTA 按压态（Task 9 / Task 8 Minor ③：MP 端 :active 不生效 → hover-class） */
.confirm-btn-hover {
  background: hsla(165, 50%, 25%, 0.85);
  border-color: hsl(165, 60%, 35%);
}
</style>
