<script setup lang="ts">
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { storeToRefs } from 'pinia'
import { useGameStore } from '../../stores/gameStore'
import {
  COC7_OCCUPATIONS,
  OCCUPATION_CATEGORIES,
  type OccupationCategory,
  type COCOccupationDef,
} from '../../data/coc7'
import AppLayout from '../../components/layout/AppLayout.vue'

const gameStore = useGameStore()
const { storyId, storyName } = storeToRefs(gameStore)

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

function selectOccupation(id: string, name: string) {
  gameStore.setOccupation(id, name)
  uni.navigateTo({ url: '/pages/character-create/index' })
}

function eraLabel(era: 'any' | 'classic' | 'modern'): string {
  if (era === 'classic') return '1920s'
  if (era === 'modern') return '现代'
  return ''
}

// 原 onMounted：无 storyId → router.replace('/')；uni-app 首页为根页面 → reLaunch
onLoad(() => {
  if (!storyId.value) {
    uni.reLaunch({ url: '/pages/home/index' })
  }
})
</script>

<template>
  <app-layout active="home" bg="/static/bg/bg_desk.png" :overlay="0.7">
    <view class="page-root">
      <!-- 进度指示 -->
      <view class="page-head">
        <view class="steps">
          <view class="step-item">
            <view class="step-circle step-active"><text>1</text></view>
            <text class="step-label step-label-on">选择职业</text>
          </view>
          <view class="step-line step-line-dim" />
          <view class="step-item">
            <view class="step-circle step-dim"><text>2</text></view>
            <text class="step-label">技能与属性</text>
          </view>
          <view class="step-line step-line-dim" />
          <view class="step-item">
            <view class="step-circle step-dim"><text>3</text></view>
            <text class="step-label">进入游戏</text>
          </view>
        </view>

        <text class="page-title">选择职业</text>
        <text class="page-desc">
          故事：<text class="story-name">{{ storyName || storyId || '—' }}</text>
        </text>
        <view class="head-divider ink-divider" />
      </view>

      <!-- 搜索 + 筛选 -->
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

        <!-- 时代筛选 -->
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

        <!-- 职业分类 -->
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

      <!-- 职业网格 -->
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
            @click="selectOccupation(occ.id, occ.name)"
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

            <!-- 信用范围 -->
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

            <!-- 选择指示 -->
            <view class="select-hint">
              <text>选择</text>
            </view>
          </view>
        </view>

        <!-- 计数摘要 -->
        <text class="count-summary">
          共 {{ filteredOccupations.length }} 个职业
          <text v-if="filteredOccupations.length !== COC7_OCCUPATIONS.length"> / 总计 {{ COC7_OCCUPATIONS.length }} 个</text>
        </text>
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

/* ── 页头 ── */
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
}
.step-active {
  background: hsla(165, 45%, 22%, 0.6);
  border: 1px solid hsl(165, 55%, 28%);
  color: hsl(165, 50%, 78%);
  box-shadow: 0 0 10px hsla(165, 60%, 35%, 0.2);
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
.step-label {
  font-size: 12px;
  color: hsl(220, 10%, 45%);
}
.step-label-on {
  font-weight: 500;
  color: hsl(38, 35%, 85%);
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
  margin-top: 8px;
  font-size: 0.875rem;
  color: hsl(220, 10%, 60%);
}
.story-name {
  color: hsl(38, 50%, 75%);
}
.head-divider {
  margin: 12px auto 0;
  max-width: 80px;
}

/* ── 筛选 ── */
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
  color: hsl(220, 10%, 50%);
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
  color: hsl(220, 10%, 30%);
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
  background: hsla(165, 45%, 22%, 0.3);
  border-color: hsla(165, 55%, 28%, 0.5);
  color: hsl(165, 50%, 78%);
}
.filter-pill-dim {
  background: hsla(220, 16%, 11%, 0.5);
  border-color: hsla(220, 14%, 16%, 0.5);
  color: hsl(220, 10%, 30%);
}
.filter-pill-dim:active {
  color: hsl(38, 25%, 55%);
  border-color: hsla(220, 12%, 22%, 0.6);
}
.count {
  margin-left: 4px;
  opacity: 0.6;
}

/* ── 职业网格 ── */
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
  color: hsl(220, 10%, 22%);
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
  box-shadow: 0 0 15px hsla(165, 60%, 35%, 0.25), inset 0 0 30px hsla(165, 60%, 35%, 0.05);
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
  color: hsl(38, 50%, 88%);
}
.occ-name-en {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  word-break: break-all;
  color: hsl(220, 10%, 30%);
}
.era-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}
.era-classic {
  background: hsla(42, 40%, 14%, 0.4);
  border: 1px solid hsla(42, 55%, 35%, 0.3);
  color: hsl(42, 60%, 70%);
}
.era-modern {
  background: hsla(210, 35%, 15%, 0.4);
  border: 1px solid hsla(210, 50%, 35%, 0.3);
  color: hsl(210, 50%, 70%);
}

.credit-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.credit-label {
  font-size: 10px;
  color: hsl(220, 10%, 25%);
}
.credit-bar {
  flex: 1;
  height: 4px;
  border-radius: 9999px;
  overflow: hidden;
  background: hsl(220, 16%, 11%);
}
.credit-fill {
  height: 100%;
  border-radius: 9999px;
  background: linear-gradient(90deg, hsl(42, 55%, 32%), hsl(42, 70%, 50%));
}
.credit-value {
  font-size: 10px;
  font-family: $font-mono;
  width: 56px;
  text-align: right;
  color: hsl(220, 10%, 25%);
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
  background: hsla(165, 35%, 10%, 0.5);
  border: 1px solid hsla(165, 45%, 22%, 0.3);
  color: hsl(165, 50%, 78%);
}
.occ-card-hover .select-hint {
  opacity: 1;
}

.count-summary {
  display: block;
  margin-top: 24px;
  text-align: center;
  font-size: 12px;
  color: hsl(220, 10%, 45%);
}
</style>
