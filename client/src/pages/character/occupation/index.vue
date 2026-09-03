<script setup lang="ts">
/**
 * T6 #20：建卡向导单页 3 步（ADR-0004 设计稿 P2→P3 合并）+ T3 #30 多人模式。
 * 原 occupation / character-create 双页合并为一页三态向导，保留本路由
 * /pages/character/occupation/index 为唯一入口：
 *   step=1 选职业（搜索 + 时代/类别 filter + 职业卡网格）
 *   step=2 技能与属性（9 职业技能 + 属性投掷 + 4 兴趣技能）
 *   step=3 兴趣补全 + 姓名 + CharacterSheet 预览 → 完成动作分模式（ADR-0002/0005）：
 *     单人（无 mode 参数）：roomCreateSolo 一体动作 → 进 solo 游戏页；
 *     多人（mode=multi&roomId）：characterCreate + roomBindCharacter → 回跳等待室。
 * step 走 URL 参数（story/occupation 上下文原样 URL 传递，无客户端会话状态，
 * 刷新/回退语义正确）；e2e 文案/类名契约（选择职业/创建角色/occ-card/
 * picker-view.flex-1/投掷属性/调查员/确认角色并进入游戏）原样保留。
 */
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  COC7_OCCUPATIONS,
  COC7_SKILLS,
  OCCUPATION_CATEGORIES,
  INTERPERSONAL_SKILL_IDS,
  getSkillName,
  type OccupationCategory,
  type COCOccupationDef,
} from '../../../../../shared/coc/coc7'
import {
  buildCharacterSheet as buildSheet,
  rollAttributes,
  getSkillBase,
} from '../../../../../shared/coc/coc7Character'
import {
  OCCUPATION_SKILL_VALUES,
  PERSONAL_INTEREST_BONUS,
  PERSONAL_INTEREST_COUNT,
  type COCAttributes,
} from '../../../../../shared/types/character'
import { getBridge } from '../../../platform'
import AppLayout from '../../../components/layout/AppLayout.vue'
import CharacterSheetCard from '../../../components/domain/CharacterSheetCard.vue'

/** 向导步进：1 选职业 → 2 技能与属性 → 3 兴趣补全+姓名+档案预览 */
const STEP_NAMES = ['选择职业', '技能与属性', '进入游戏'] as const
const step = ref(1)

/** 故事/职业上下文经 URL 参数传递（ADR-0002：确认即建 solo 房，无客户端会话状态）。 */
const storyId = ref('')
const storyName = ref('')
const selectedOccupationId = ref('')
const selectedOccupationName = ref('')
const isCreating = ref(false)
const createError = ref('')

/* ───────────── 多人模式（T3 #30：mode=multi&roomId） ─────────────
 * 成员从等待室（rooms/room）建卡入口直达本页：storyId 可空（房主剧本
 * 可能尚未选定——剧本选择是房主侧动作，与成员建卡解耦）。进入即 roomDetail
 * 预检（房间不存在 404 / 已 playing / ended → 明确错误回退，不卡死）；
 * 完成动作 = characterCreate + roomBindCharacter + 回跳等待室。 */

/** 多人模式目标房间 id（空 = 单人模式）。 */
const multiRoomId = ref('')
/** 单人模式判定：无 mode 参数（storyId 守卫与完成动作原样——h5.journey 回归基线）。 */
const isMultiMode = computed(() => multiRoomId.value !== '')
/** 多人模式展示用角色卡（已建过的卡可在向导里复用：完成时若选了既有卡则跳过建卡）。 */
const existingCharacters = ref<{ id: string; name: string; sheet: Record<string, unknown> }[]>([])
const useExistingCharId = ref('')
const pickingExisting = ref(false)

/**
 * 多人模式入场预检：房间不存在（404）或已开局/结束（playing/ended）→
 * toast + reLaunch 回首页（等待室开局后会锁房跳转 game 页，本页不可再被依赖）。
 * 房主剧本（storyId）若房间已登记 → 展示（否则「房主尚未选择剧本」）。
 */
async function preflightMultiRoom(): Promise<void> {
  try {
    const detail = await getBridge().roomDetail(multiRoomId.value)
    if (detail.phase === 'playing' || detail.phase === 'ended') {
      uni.showToast({ title: '房间已开局，无法在此建卡', icon: 'none' })
      setTimeout(() => uni.reLaunch({ url: '/pages/home/index' }), 1200)
      return
    }
    if (detail.storyId && !storyId.value) storyId.value = detail.storyId
    try {
      existingCharacters.value = await getBridge().characterList()
    } catch { existingCharacters.value = [] }
    pickingExisting.value = true
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '房间不存在或已不可加入', icon: 'none' })
    setTimeout(() => uni.reLaunch({ url: '/pages/home/index' }), 1200)
  }
}

/** 打开「复用已有角色卡」选择器（预检成功后由 onLoad 自动弹；用户可关闭回向导）。 */
function openExistingPicker() {
  pickingExisting.value = true
}

function closeExistingPicker() {
  useExistingCharId.value = ''
  pickingExisting.value = false
}

/** 复用选中卡 → 跳过建卡向导直接绑定回等待室。 */
async function confirmExistingCharacter() {
  if (!useExistingCharId.value || isCreating.value) return
  isCreating.value = true
  createError.value = ''
  try {
    await bindToRoom(useExistingCharId.value)
    finishMultiMode()
  } catch (e) {
    useExistingCharId.value = ''
    pickingExisting.value = true
    createError.value = e instanceof Error ? e.message : String(e)
  } finally {
    isCreating.value = false
  }
}

/** 多人模式完成动作：绑定当前房间 + 回跳等待室（roomStore 会续上 room_meta）。 */
async function bindToRoom(characterId: string): Promise<void> {
  await getBridge().roomBindCharacter(multiRoomId.value, characterId)
}

/** 多人模式收尾导航：redirectTo 等待室（替换本页，返回键不再回到向导）。 */
function finishMultiMode(): void {
  uni.redirectTo({ url: `/pages/game/rooms/room?roomId=${encodeURIComponent(multiRoomId.value)}` })
}

/**
 * 背景图（Task 9 分包）：H5 走主包 public 目录；MP 子包页面引用子包内 static。
 */
// #ifdef H5
const pageBg = '/static/bg/bg_desk.webp'
// #endif
// #ifndef H5
const pageBg = '/pages/character/static/bg_desk.webp'
// #endif

/* ───────────── Step 1：职业选择 ───────────── */

const searchQuery = ref('')
const selectedCategory = ref<OccupationCategory | 'all'>('all')
const selectedEra = ref<'any' | 'classic' | 'modern' | 'all'>('all')

const categoryEntries = computed(() => {
  return [
    { key: 'all' as const, label: '全部' },
    ...Object.entries(OCCUPATION_CATEGORIES).map(([key, label]) => ({
      key: key as OccupationCategory,
      label,
    })),
  ]
})

const eraOptions = [
  { key: 'all' as const, label: '全时代' },
  { key: 'any' as const, label: '通用' },
  { key: 'classic' as const, label: '1920s' },
  { key: 'modern' as const, label: '现代' },
]

function matchSearch(occ: COCOccupationDef, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    occ.name.toLowerCase().includes(q) ||
    occ.nameEn.toLowerCase().includes(q) ||
    occ.id.toLowerCase().includes(q)
  )
}

const filteredOccupations = computed(() => {
  return COC7_OCCUPATIONS.filter((occ) => {
    if (selectedCategory.value !== 'all' && occ.category !== selectedCategory.value) return false
    if (selectedEra.value !== 'all' && occ.era !== selectedEra.value) return false
    return matchSearch(occ, searchQuery.value)
  })
})

const categoryCounts = computed(() => {
  const counts: Record<string, number> = { all: 0 }
  for (const occ of COC7_OCCUPATIONS) {
    if (selectedEra.value !== 'all' && occ.era !== selectedEra.value) continue
    if (!matchSearch(occ, searchQuery.value)) continue
    counts.all = (counts.all || 0) + 1
    counts[occ.category] = (counts[occ.category] || 0) + 1
  }
  return counts
})

function eraLabel(era: 'any' | 'classic' | 'modern'): string {
  if (era === 'classic') return '1920s'
  if (era === 'modern') return '现代'
  return ''
}

const occupation = computed(() =>
  COC7_OCCUPATIONS.find((o) => o.id === selectedOccupationId.value) ?? null
)

/** 同页前进：选职业 → step2（本页状态已持有 occupation；step 仅驱动 v-if，不重载页面） */
function selectOccupation(occ: COCOccupationDef) {
  selectedOccupationId.value = occ.id
  selectedOccupationName.value = occ.name
  initOccupationSlots()
  step.value = 2
  uni.pageScrollTo({ scrollTop: 0, duration: 0 })
}

function goStep1() {
  step.value = 1
  uni.pageScrollTo({ scrollTop: 0, duration: 0 })
}

/* ───────────── Step 2+3：角色构建 ───────────── */

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

/** 职业技能已配满 9 项 */
const occupationSkillsComplete = computed(() => {
  if (!occupation.value || occupationSkillKeys.value.length !== 9) return false
  return occupationSkillKeys.value.every((k) => !!k)
})

/** step2 → step3 门闩：属性已投 + 职业技能配满 */
const canGoInterest = computed(() => !!attributes.value && occupationSkillsComplete.value)

const goToStep3 = () => {
  if (!canGoInterest.value) return
  step.value = 3
  uni.pageScrollTo({ scrollTop: 0, duration: 0 })
}

function goToStep2() {
  step.value = 2
  uni.pageScrollTo({ scrollTop: 0, duration: 0 })
}

const chosenInterestCount = computed(() => personalInterestKeys.value.filter(Boolean).length)

function canConfirm(): boolean {
  if (!occupation.value || !attributes.value || !playerName.value.trim()) return false
  if (!occupationSkillsComplete.value) return false
  if (chosenInterestCount.value < PERSONAL_INTEREST_COUNT) return false
  return true
}

const liveSheet = computed(() => {
  if (!occupation.value || !attributes.value) return null
  return buildSheet(
    occupation.value.id,
    occupation.value.name,
    playerName.value.trim() || '调查员',
    occupationSkillKeys.value,
    personalInterestKeys.value.filter(Boolean),
    attributes.value,
  )
})

async function confirm() {
  if (!canConfirm() || !occupation.value || !attributes.value || isCreating.value) return
  const sheet = buildSheet(
    occupation.value.id,
    occupation.value.name,
    playerName.value.trim(),
    occupationSkillKeys.value,
    personalInterestKeys.value.filter(Boolean),
    attributes.value,
  )
  // 模式分流：多人 = characterCreate + roomBindCharacter + 回跳等待室（ADR-0005 T3 #30）；
  // 单人 = 服务端一体动作（落角色卡 + 建 solo 房 + 绑卡 + start）→ 直接进房（ADR-0002）
  isCreating.value = true
  createError.value = ''
  try {
    if (isMultiMode.value) {
      const r = await getBridge().characterCreate(playerName.value.trim(), sheet)
      await bindToRoom(r.id)
      finishMultiMode()
    } else {
      const r = await getBridge().roomCreateSolo({ storyId: storyId.value, name: playerName.value.trim(), sheet })
      uni.redirectTo({ url: `/pages/game/index?roomId=${encodeURIComponent(r.roomId)}&storyName=${encodeURIComponent(storyName.value)}` })
    }
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e)
  } finally {
    isCreating.value = false
  }
}

// 原双页导航回归守卫：直接落地（无 story/职业）→ 回首页；否则按 URL step/职业恢复
// 多人模式（T3 #30）：storyId 可空，但必须有 roomId → 预检房间后照常进入向导
onLoad((options) => {
  const rawStep = Number(options?.step ?? 1)
  step.value = rawStep === 2 || rawStep === 3 ? rawStep : 1
  storyId.value = String(options?.storyId ?? '')
  storyName.value = decodeURIComponent(String(options?.storyName ?? ''))
  selectedOccupationId.value = String(options?.occupationId ?? '')
  selectedOccupationName.value = decodeURIComponent(String(options?.occupationName ?? ''))
  const multiRoomIdParam = String(options?.mode ?? '') === 'multi' ? String(options?.roomId ?? '') : ''
  multiRoomId.value = multiRoomIdParam
  if (multiRoomIdParam) {
    // 多人入场：房间预检（不存在/已开局 → 明确回退）；无故事时不守卫（房主剧本可选）
    void preflightMultiRoom()
  } else if (!storyId.value) {
    uni.reLaunch({ url: '/pages/home/index' })
    return
  }
  if (occupation.value) {
    initOccupationSlots()
    if (step.value === 1) step.value = 2 // 已带职业不该落在职业选择步
  } else if (step.value !== 1) {
    step.value = 1 // 无职业却请求后续步（刷新 URL 漂移）→ 回选职业
  }
})
</script>

<template>
  <app-layout active="home" :bg="pageBg" :overlay="0.7">
    <view class="page-root">
      <!-- 进度指示（步骤名同页内，标签即视觉标题） -->
      <view class="page-head">
        <view class="steps">
          <view
            v-for="(name, idx) in STEP_NAMES"
            :key="name"
            class="step-item"
          >
            <view
              class="step-circle"
              :class="step > idx + 1 ? 'step-done' : step === idx + 1 ? 'step-active' : 'step-dim'"
            >
              <text>{{ step > idx + 1 ? '✓' : idx + 1 }}</text>
            </view>
            <text class="step-label" :class="step === idx + 1 ? 'step-label-on' : 'step-label-dim'">{{ name }}</text>
            <view v-if="idx < STEP_NAMES.length - 1" class="step-line" :class="step > idx + 1 ? 'step-line-active' : 'step-line-dim'" />
          </view>
        </view>

        <text class="page-title">{{ step === 1 ? '选择职业' : step === 2 ? '创建角色' : '确认调查员' }}</text>
        <text class="page-desc">
          <template v-if="step === 1">
            故事：<text class="story-name">{{ storyName || storyId || (isMultiMode ? '房主尚未选择剧本' : '—') }}</text>
          </template>
          <template v-else>
            职业：<text class="occupation-name">{{ selectedOccupationName }}</text>
            <text v-if="step === 3" class="story-name">{{ isMultiMode ? ` · 房间建卡${storyId ? ' · 故事：' + storyName : ''}` : ` · 故事：${storyName || '—'}` }}</text>
          </template>
        </text>
        <view class="head-divider ink-divider" />
        <text v-if="createError" class="create-error create-error-head">{{ createError }}</text>
      </view>

      <!-- ══ Step 1：选职业 ══ -->
      <template v-if="step === 1">
        <view class="filters">
          <view class="search-box">
            <input
              v-model="searchQuery"
              class="gothic-input search-input"
              placeholder="搜索职业名称（中文 / 英文）…"
              placeholder-class="gothic-ph"
            />
            <text class="search-icon">🔍</text>
          </view>

          <view class="filter-row">
            <text class="filter-label">时代：</text>
            <view class="pills">
              <view
                v-for="era in eraOptions"
                :key="era.key"
                class="filter-pill"
                :class="selectedEra === era.key ? 'filter-pill-active' : 'filter-pill-dim'"
                @click="selectedEra = era.key"
              >
                {{ era.label }}
              </view>
            </view>
          </view>

          <view class="pills wrap">
            <view
              v-for="cat in categoryEntries"
              :key="cat.key"
              class="filter-pill"
              :class="selectedCategory === cat.key ? 'filter-pill-active' : 'filter-pill-dim'"
              @click="selectedCategory = cat.key"
            >
              {{ cat.label }}
              <text v-if="categoryCounts[cat.key]" class="count">{{ categoryCounts[cat.key] }}</text>
            </view>
          </view>
        </view>

        <view class="occupation-grid">
          <text v-if="filteredOccupations.length === 0" class="no-match">
            未找到匹配的职业，请尝试其他搜索关键词或筛选条件
          </text>

          <view class="grid">
            <view
              v-for="occ in filteredOccupations"
              :key="occ.id"
              class="gothic-card occ-card"
              hover-class="occ-card-hover"
              @click="selectOccupation(occ)"
            >
              <view class="occ-head">
                <view class="occ-name-wrap">
                  <text class="occ-name">{{ occ.name }}</text>
                  <text class="occ-name-en">{{ occ.nameEn }}</text>
                </view>
                <view v-if="occ.era !== 'any'" class="era-badge" :class="occ.era === 'classic' ? 'era-classic' : 'era-modern'">
                  {{ eraLabel(occ.era) }}
                </view>
              </view>

              <view class="credit-row">
                <text class="credit-label">信用</text>
                <view class="credit-bar">
                  <view
                    class="credit-fill"
                    :style="{ marginLeft: occ.creditRange[0] + '%', width: (occ.creditRange[1] - occ.creditRange[0]) + '%' }"
                  />
                </view>
                <text class="credit-value">{{ occ.creditRange[0] }}-{{ occ.creditRange[1] }}</text>
              </view>

              <view class="select-hint">
                <text>选择</text>
              </view>
            </view>
          </view>

          <text class="count-summary">
            共 {{ filteredOccupations.length }} 个职业
            <text v-if="filteredOccupations.length !== COC7_OCCUPATIONS.length"> / 总计 {{ COC7_OCCUPATIONS.length }} 个</text>
          </text>
        </view>
      </template>

      <!-- ══ Step 2：技能与属性 ══ -->
      <template v-else-if="step === 2">
        <view class="page-body">
          <!-- 职业技能 -->
          <view class="gothic-card section-card">
            <view class="section-head">
              <text class="section-title">⚔ 职业技能</text>
              <text class="section-hint">(9 项：70, 60, 60, 50, 50, 50, 40, 40, 40)</text>
            </view>
            <view class="slot-list">
              <view v-for="(key, i) in occupationSkillKeys" :key="i" class="slot-row">
                <text class="slot-value" :style="{ color: (OCCUPATION_SKILL_VALUES[i] ?? 0) >= 60 ? 'var(--c-paper-400)' : 'var(--c-ash)' }">
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

          <!-- 4 兴趣技能 picker（step2 预选；step3 校验补全） -->
          <view class="gothic-card section-card">
            <view class="section-head">
              <text class="section-title">✦ 兴趣技能</text>
              <text class="section-hint">(任选 {{ PERSONAL_INTEREST_COUNT }} 项，每项 +{{ PERSONAL_INTEREST_BONUS }}%，可与职业技能重叠叠加)</text>
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

          <!-- 操作 -->
          <view class="actions">
            <button class="gothic-btn-secondary action-btn" @click="goStep1">上一步：选择职业</button>
            <button
              class="gothic-btn action-btn step-next-btn"
              :class="{ 'is-disabled': !canGoInterest }"
              hover-class="confirm-btn-hover"
              @click="goToStep3"
            >
              {{ canGoInterest ? '下一步：确认调查员' : '先投掷属性并配满职业技能' }}
            </button>
          </view>
        </view>
      </template>

      <!-- ══ Step 3：兴趣补全 + 姓名 + 档案预览 → 进房 ══ -->
      <template v-else>
        <view class="page-body step3-body">
          <view class="step3-main">
            <!-- 兴趣技能补全 -->
            <view class="gothic-card section-card">
              <view class="section-head">
                <text class="section-title">✦ 兴趣技能</text>
                <text class="section-hint">
                  已选 {{ chosenInterestCount }}/{{ PERSONAL_INTEREST_COUNT }}
                  <text v-if="chosenInterestCount < PERSONAL_INTEREST_COUNT" class="section-warn">——还需 {{ PERSONAL_INTEREST_COUNT - chosenInterestCount }} 项</text>
                </text>
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
          </view>

          <!-- CharacterSheet 档案预览（复用 liveSheet） -->
          <view class="step3-side">
            <text class="preview-label">档案预览</text>
            <character-sheet-card v-if="liveSheet" :sheet="liveSheet" />
            <view v-else class="preview-empty">先回到上一步完成属性投掷</view>
          </view>

          <view class="actions">
            <button class="gothic-btn-secondary action-btn" @click="goToStep2">上一步</button>
            <button
              class="gothic-btn action-btn"
              :class="{ 'is-disabled': !canConfirm() || isCreating }"
              :loading="isCreating"
              hover-class="confirm-btn-hover"
              @click="confirm"
            >
              {{ canConfirm() ? '确认角色并进入游戏' : `选择 ${PERSONAL_INTEREST_COUNT} 项兴趣并填写姓名` }}
            </button>
          </view>
        </view>
      </template>
    </view>

    <!-- 复用既有角色卡弹层（多人模式入场自动弹出；有卡时也可点击进入选择） -->
    <view v-if="pickingExisting && isMultiMode" class="picker-mask" @click="closeExistingPicker">
      <view class="picker" @click.stop>
        <view class="picker-title">选择要绑定的角色卡</view>
        <scroll-view class="picker-scroll" scroll-y>
          <view
            v-for="c in existingCharacters"
            :key="c.id"
            class="char-option"
            :class="{ active: useExistingCharId === c.id }"
            @click="useExistingCharId = c.id"
          >
            <text>{{ c.name }}</text>
          </view>
          <view v-if="existingCharacters.length === 0" class="char-empty">还没有角色卡 — 关闭后在上方向导新建一张</view>
        </scroll-view>
        <view class="picker-foot">
          <button class="gothic-btn-secondary picker-btn" @click="closeExistingPicker">关闭，新建角色</button>
          <button
            class="gothic-btn picker-btn"
            :class="{ 'is-disabled': !useExistingCharId || isCreating }"
            :loading="isCreating"
            @click="confirmExistingCharacter"
          >确认绑定</button>
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

/* ── 页头（原双页步条/标题合一） ── */
.page-head {
  padding: 32px 24px 16px;
  max-width: 896px;
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
  margin-bottom: 32px;
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
  box-sizing: border-box;
}
.step-active {
  background: color-mix(in srgb, var(--c-eld-700) 60%, transparent);
  border: 1px solid var(--c-eld-600);
  color: var(--c-eld-100);
  box-shadow: 0 0 10px color-mix(in srgb, var(--c-eld-500) 20%, transparent);
}
.step-done {
  background: color-mix(in srgb, var(--c-eld-800) 50%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 50%, transparent);
  color: var(--c-eld-200);
}
.step-dim {
  background: var(--c-obsidian);
  border: 1px solid var(--c-slate);
  color: var(--c-obsidian-light);
}
.step-line {
  width: 32px;
  height: 1px;
}
.step-line-dim { background: var(--c-slate); }
.step-line-active { background: var(--c-eld-600); }
.step-label {
  font-size: 12px;
  color: var(--c-ash);
}
.step-label-on {
  font-weight: 500;
  color: var(--c-paper-100);
}
.step-label-dim {
  color: var(--c-fog);
}
.page-title {
  display: block;
  font-family: $font-display;
  font-size: 1.5rem;
  font-weight: bold;
  color: var(--c-paper-50);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
}
.page-desc {
  display: block;
  margin-top: 8px;
  font-size: 0.875rem;
  color: var(--c-fog);
}
.story-name {
  color: var(--c-paper-100);
}
.occupation-name {
  font-family: $font-display;
  color: var(--c-paper-100);
  text-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}
.head-divider {
  margin: 12px auto 0;
  max-width: 80px;
}

/* ── Step1 筛选 ── */
.filters {
  padding: 0 24px 16px;
  max-width: 896px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.search-box {
  position: relative;
}
.search-input {
  padding-left: 40px;
}
.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  color: var(--c-fog);
  pointer-events: none;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--c-ash);
}
.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pills.wrap {
  gap: 6px;
}
.filter-pill {
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.2s;
  border: 1px solid transparent;
}
.filter-pill-active {
  background: color-mix(in srgb, var(--c-eld-700) 30%, transparent);
  border-color: color-mix(in srgb, var(--c-eld-600) 50%, transparent);
  color: var(--c-eld-100);
}
.filter-pill-dim {
  background: color-mix(in srgb, var(--c-obsidian) 50%, transparent);
  border-color: color-mix(in srgb, var(--c-slate) 50%, transparent);
  color: var(--c-ash);
}
.filter-pill-dim:active {
  color: var(--c-paper-600);
  border-color: color-mix(in srgb, var(--c-slate-light) 60%, transparent);
}
.count {
  margin-left: 4px;
  opacity: 0.6;
}

/* ── Step1 职业网格 ── */
.occupation-grid {
  flex: 1;
  padding: 0 24px 48px;
  max-width: 896px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.no-match {
  display: block;
  text-align: center;
  padding: 48px 0;
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  color: var(--c-slate-light);
}
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 640px) {
  .grid { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 1024px) {
  .grid { grid-template-columns: repeat(3, 1fr); }
}
.occ-card {
  padding: 16px;
  background: rgba(0, 0, 0, 0.5);
  position: relative;
  text-align: left;
  transition: all 0.3s;
}
.occ-card-hover {
  background: rgba(0, 0, 0, 0.7);
  transform: translateY(-2px);
  box-shadow: 0 0 15px color-mix(in srgb, var(--c-eld-500) 25%, transparent), inset 0 0 30px color-mix(in srgb, var(--c-eld-500) 5%, transparent);
}
.occ-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.occ-name-wrap {
  min-width: 0;
  flex: 1;
}
.occ-name {
  display: block;
  font-family: $font-serif;
  font-weight: 600;
  word-break: break-all;
  color: var(--c-paper-100);
}
.occ-name-en {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  word-break: break-all;
  color: var(--c-ash);
}
.era-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}
.era-classic {
  background: color-mix(in srgb, var(--c-ritual-800) 40%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-ritual-500) 30%, transparent);
  color: var(--c-ritual-200);
}
.era-modern {
  background: color-mix(in srgb, var(--c-mana-800) 40%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-mana-500) 30%, transparent);
  color: var(--c-mana-200);
}

.credit-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.credit-label {
  font-size: 10px;
  color: var(--c-obsidian-light);
}
.credit-bar {
  flex: 1;
  height: 4px;
  border-radius: 9999px;
  overflow: hidden;
  background: var(--c-obsidian);
}
.credit-fill {
  height: 100%;
  border-radius: 9999px;
  background: linear-gradient(90deg, var(--c-ritual-600), var(--c-ritual-400));
}
.credit-value {
  font-size: 10px;
  font-family: $font-mono;
  width: 56px;
  text-align: right;
  color: var(--c-obsidian-light);
}

.select-hint {
  position: absolute;
  right: 12px;
  bottom: 12px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  opacity: 0;
  transition: all 0.2s;
  background: color-mix(in srgb, var(--c-eld-900) 50%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 30%, transparent);
  color: var(--c-eld-100);
}
.occ-card-hover .select-hint {
  opacity: 1;
}

.count-summary {
  display: block;
  margin-top: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--c-ash);
}

/* ── Step2/3 通用 body ── */
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
  color: var(--c-paper-100);
  letter-spacing: 0.05em;
}
.section-hint {
  font-size: 12px;
  font-weight: normal;
  color: var(--c-fog);
}
.section-warn {
  color: var(--c-ritual-300);
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
  color: var(--c-paper-300);
}
.picker-view {
  min-width: 192px;
  max-width: 320px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
  background: color-mix(in srgb, var(--c-abyss) 85%, transparent);
  color: var(--c-paper-300);
  border: 1px solid var(--c-slate);
  box-sizing: border-box;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.picker-empty {
  color: var(--c-ash);
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
  background: color-mix(in srgb, var(--c-obsidian) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-slate) 50%, transparent);
}
.attr-key {
  font-size: 12px;
  font-weight: bold;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-family: $font-mono;
  color: var(--c-ash);
}
.attr-val {
  font-family: $font-mono;
  font-weight: bold;
  color: var(--c-paper-100);
}

.interest-bonus {
  width: 40px;
  text-align: right;
  font-size: 12px;
  font-family: $font-mono;
  flex-shrink: 0;
  color: var(--c-eld-300);
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
.step-next-btn {
  min-width: 220px;
}
/* 确认主 CTA 按压态（Task 8 Minor ③：MP 端 :active 不生效 → hover-class） */
.confirm-btn-hover {
  background: color-mix(in srgb, var(--c-eld-600) 85%, transparent);
  border-color: var(--c-eld-500);
}
.create-error {
  display: block;
  font-size: 0.8125rem;
  font-family: $font-serif;
  color: var(--c-blood-200);
  padding: 8px 0 16px;
}
.create-error-head {
  padding: 0 24px 12px;
  max-width: 896px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
}

/* ── 复用角色卡弹层（多人模式，T3 #30；lobby 绑定选择器同构样式） ── */
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
}
.picker {
  width: min(480px, calc(100vw - 48px));
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--c-abyss);
  border: 1px solid var(--c-slate);
  border-radius: 12px;
  overflow: hidden;
}
.picker-title {
  padding: 16px 20px 8px;
  font-family: $font-display;
  font-weight: bold;
  color: var(--c-paper-100);
}
.picker-scroll {
  flex: 1;
  min-height: 0;
}
.char-option {
  padding: 12px 20px;
  border-bottom: 1px solid var(--c-slate);
  color: var(--c-paper-300);
  font-family: $font-serif;
  font-size: 0.9375rem;
}
.char-option.active {
  background: color-mix(in srgb, var(--c-eld-700) 25%, transparent);
  color: var(--c-eld-100);
}
.picker-foot {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--c-slate);
}
.picker-btn {
  font-size: 0.875rem;
}
.char-empty {
  padding: 32px 20px;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--c-ash);
}

/* ── Step3：预览并排布局（桌面 2 列 / 移动单列） ── */
.step3-body {
  max-width: 896px;
}
.step3-main {
  display: flex;
  flex-direction: column;
  gap: 32px;
  flex: 1;
  min-width: 0;
}
.step3-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.preview-label {
  font-size: 12px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-family: $font-mono;
  color: var(--c-ash);
}
.preview-empty {
  padding: 40px;
  font-size: 0.8125rem;
  color: var(--c-ash);
}
@media (min-width: 900px) {
  .step3-body {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 32px;
    align-items: start;
  }
  .step3-body .actions,
  .step3-body .create-error {
    grid-column: 1 / -1;
  }
}
</style>
