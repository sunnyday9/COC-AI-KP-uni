<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useGameStore } from '../../stores/gameStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { listIndexedStories, type IndexedStory } from '../../services/ragService'
import AppLayout from '../../components/layout/AppLayout.vue'

const gameStore = useGameStore()
const settingsStore = useSettingsStore()

const stories = ref<IndexedStory[]>([])
const isLoading = ref(false)

async function loadStories() {
  isLoading.value = true
  try {
    stories.value = await listIndexedStories()
  } catch { stories.value = [] }
  finally { isLoading.value = false }
}

onMounted(() => { loadStories() })

async function goToSetup(story: IndexedStory) {
  await gameStore.startGame({ storyId: story.storyId, storyName: story.name })
  uni.navigateTo({ url: '/pages/occupation/index' })
}

function goScripts() {
  uni.navigateTo({ url: '/pages/scripts/index' })
}
</script>

<template>
  <app-layout active="home" bg="/static/bg/bg_home.png" :overlay="0.7">
    <view class="page-root">
      <!-- Hero 区（带径向晕影） -->
      <view class="hero">
        <view class="hero-vignette" />
        <!-- 装饰徽记（原内联 SVG → CSS 同心环 + 十字线） -->
        <view class="sigil animate-breathe">
          <view class="ring r1" /><view class="ring r2" /><view class="ring r3" />
          <view class="cross-h" /><view class="cross-v" />
          <view class="cross-d1" /><view class="cross-d2" />
        </view>

        <text class="hero-title">AI COC Keeper</text>
        <text class="hero-sub">克苏鲁的呼唤 — 智能守密人</text>
        <view class="hero-divider ink-divider" />
      </view>

      <!-- 故事列表区 -->
      <view class="stories">
        <view class="stories-head">
          <text class="moon">☽</text>
          <text class="stories-title">选择故事</text>
        </view>

        <!-- 未登录提示（新增：原项目无认证体系） -->
        <view v-if="!settingsStore.isAuthenticated && !isLoading && stories.length === 0" class="gothic-card auth-hint">
          <text class="auth-hint-text">提示：请先到「设置」页登录/注册后使用故事功能</text>
        </view>

        <!-- 加载中 -->
        <view v-if="isLoading && stories.length === 0" class="gothic-card loading-card">
          <view class="sigil-spinner" />
          <text class="loading-text">加载故事中...</text>
        </view>

        <!-- 故事卡片 -->
        <view v-else-if="stories.length" class="story-list">
          <view
            v-for="story in stories"
            :key="story.storyId"
            class="gothic-card story-card"
            hover-class="story-card-hover"
            @click="goToSetup(story)"
          >
            <view class="story-inner">
              <view class="story-badge">
                <text class="story-badge-text">{{ story.name.charAt(0) }}</text>
              </view>
              <view class="story-info">
                <text class="story-name">{{ story.name }}</text>
                <text class="story-meta">{{ story.chunkCount }} 个信息块</text>
              </view>
            </view>
            <view class="story-cta">
              <text>开始游戏</text>
            </view>
          </view>
        </view>

        <!-- 空态 -->
        <view v-else class="gothic-card empty-card">
          <view class="empty-divider ink-divider" />
          <text class="empty-quote">"书架上空无一物..."</text>
          <text class="empty-hint">调查员，请先到「故事管理」导入并索引故事文件</text>
          <view class="empty-divider ink-divider" />
          <button class="gothic-btn empty-btn" @click="goScripts">
            前往故事管理
            <text class="arrow">→</text>
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

/* ── Hero ── */
.hero {
  position: relative;
  padding: 64px 24px 40px;
  text-align: center;
  overflow: hidden;
}
.hero-vignette {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at center top, hsla(165, 40%, 15%, 0.12) 0%, transparent 60%);
}
.sigil {
  position: absolute;
  left: 50%;
  top: 32px;
  width: 192px;
  height: 192px;
  margin-left: -96px;
  opacity: 0.03;
  color: hsl(165, 60%, 35%);
}
.ring {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  border: 1px solid currentColor;
  border-radius: 50%;
}
.r1 { width: 180px; height: 180px; }
.r2 { width: 140px; height: 140px; }
.r3 { width: 100px; height: 100px; border-width: 0.5px; }
.cross-h, .cross-v {
  position: absolute;
  left: 50%;
  top: 50%;
  background: currentColor;
}
.cross-h { width: 180px; height: 1px; transform: translate(-50%, -50%); }
.cross-v { height: 180px; width: 1px; transform: translate(-50%, -50%); }
.cross-d1, .cross-d2 {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 254px;
  height: 1px;
  background: currentColor;
  transform-origin: center;
}
.cross-d1 { transform: translate(-50%, -50%) rotate(45deg); }
.cross-d2 { transform: translate(-50%, -50%) rotate(-45deg); }

.hero-title {
  position: relative;
  z-index: 10;
  display: block;
  font-family: $font-display;
  font-size: 1.875rem;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
  text-shadow: 0 2px 10px hsla(220, 20%, 4%, 0.8);
}
.hero-sub {
  position: relative;
  z-index: 10;
  display: block;
  margin-top: 12px;
  font-size: 0.875rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: hsl(220, 10%, 30%);
  font-family: $font-body;
}
.hero-divider {
  position: relative;
  z-index: 10;
  margin: 16px auto 0;
  max-width: 200px;
}

/* ── 故事区 ── */
.stories {
  flex: 1;
  padding: 0 24px 48px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.stories-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}
.moon {
  color: hsl(165, 60%, 35%);
  font-size: 1rem;
}
.stories-title {
  font-family: $font-display;
  font-size: 1.125rem;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
  letter-spacing: 0.05em;
}

.auth-hint {
  padding: 24px;
  text-align: center;
}
.auth-hint-text {
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  color: hsl(38, 25%, 55%);
}

.loading-card {
  padding: 32px;
  text-align: center;
  background: rgba(0, 0, 0, 0.4);
}
.loading-text {
  display: block;
  margin-top: 16px;
  font-size: 0.875rem;
  font-family: $font-serif;
  font-style: italic;
  color: hsl(220, 10%, 40%);
}

.story-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.story-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px;
  background: rgba(0, 0, 0, 0.6);
  border-left: 3px solid hsla(165, 60%, 35%, 0.4);
  border-color: hsla(220, 15%, 15%, 0.8);
  position: relative;
  overflow: hidden;
  transition: all 0.2s;
}
.story-card-hover {
  background: rgba(0, 0, 0, 0.75);
}
.story-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
.story-badge {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: $font-display;
  font-size: 1.125rem;
  border: 1px solid hsla(165, 45%, 22%, 0.6);
  background: hsla(165, 35%, 10%, 0.7);
  color: hsl(165, 50%, 78%);
}
.story-info {
  min-width: 0;
}
.story-name {
  display: block;
  font-family: $font-serif;
  font-weight: 600;
  font-size: 1rem;
  word-break: break-all;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.story-meta {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-family: $font-mono;
  color: hsl(220, 10%, 45%);
}
.story-cta {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 0.5rem;
  border: 1px solid hsla(165, 45%, 22%, 0.5);
  background: hsla(165, 35%, 10%, 0.6);
  color: hsl(165, 50%, 78%);
  opacity: 0.7;
}

.empty-card {
  padding: 48px;
  text-align: center;
  background: rgba(0, 0, 0, 0.45);
}
.empty-divider {
  margin: 0 auto 16px;
  width: 64px;
}
.empty-quote {
  display: block;
  font-size: 1.25rem;
  font-family: $font-serif;
  font-style: italic;
  margin-bottom: 12px;
  color: hsl(220, 10%, 40%);
}
.empty-hint {
  display: block;
  font-size: 0.875rem;
  margin-bottom: 24px;
  color: hsl(220, 10%, 45%);
}
.empty-btn {
  background: rgba(0, 0, 0, 0.6);
}
.arrow {
  margin-left: 4px;
}
</style>
