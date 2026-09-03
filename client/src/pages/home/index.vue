<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useSettingsStore } from '../../stores/settingsStore'
import { listIndexedStories, type IndexedStory } from '../../services/ragService'
import { getBridge } from '../../platform'
import type { SoloRoomListItem } from '../../../../../shared/types/room'
import AppLayout from '../../components/layout/AppLayout.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import Button from '../../components/ui/Button.vue'

const settingsStore = useSettingsStore()

const stories = ref<IndexedStory[]>([])
const isLoading = ref(false)
const soloRooms = ref<SoloRoomListItem[]>([])
const soloLoading = ref(false)

async function loadStories() {
  isLoading.value = true
  try {
    stories.value = await listIndexedStories()
  } catch { stories.value = [] }
  finally { isLoading.value = false }
}

async function loadSoloRooms() {
  soloLoading.value = true
  try {
    soloRooms.value = await getBridge().roomListSolo()
  } catch { soloRooms.value = [] }
  finally { soloLoading.value = false }
}

onMounted(() => { loadStories(); loadSoloRooms() })

/** T7：进行中局（storyId → room）——故事卡「继续」角标数据源。 */
const roomByStory = computed(() => {
  const map = new Map<string, SoloRoomListItem>()
  for (const r of soloRooms.value) {
    if (r.storyId && !map.has(r.storyId)) map.set(r.storyId, r)
  }
  return map
})

function storyNameOf(storyId: string | null): string {
  if (!storyId) return '未命名故事'
  return stories.value.find((s) => s.storyId === storyId)?.name ?? storyId
}

function goToSetup(story: IndexedStory) {
  uni.navigateTo({ url: `/pages/character/occupation/index?storyId=${encodeURIComponent(story.storyId)}&storyName=${encodeURIComponent(story.name)}` })
}

/** 故事卡点击：有进行中局 → 续玩；否则新建调查。 */
function openStory(story: IndexedStory) {
  const room = roomByStory.value.get(story.storyId)
  if (room) {
    uni.navigateTo({ url: `/pages/game/index?roomId=${encodeURIComponent(room.roomId)}&storyName=${encodeURIComponent(storyNameOf(room.storyId))}` })
    return
  }
  goToSetup(story)
}

function goScripts() {
  uni.navigateTo({ url: '/pages/scripts/index' })
}

function goRooms() {
  uni.navigateTo({ url: '/pages/game/rooms/index' })
}

function goSettings() {
  uni.navigateTo({ url: '/pages/settings/index' })
}
</script>

<template>
  <app-layout active="home" bg="/static/bg/bg_home.webp" :overlay="0.7">
    <view class="page-root">
      <!-- Hero（呼吸感 + 标题/副标 + 开始 CTA） -->
      <view class="hero">
        <view class="hero-vignette" />
        <view class="sigil animate-breathe">
          <view class="ring r1" /><view class="ring r2" /><view class="ring r3" />
          <view class="cross-h" /><view class="cross-v" />
          <view class="cross-d1" /><view class="cross-d2" />
        </view>

        <text class="hero-kicker">CALL OF CTHULHU · KEEPER</text>
        <text class="hero-title">AI COC Keeper</text>
        <text class="hero-sub">克苏鲁的呼唤 — 智能守密人</text>
        <view class="hero-divider ink-divider" />
      </view>

      <view class="page-body">
        <!-- 操作条：导入故事（T2 按钮级）+ 多人联机入口 -->
        <view class="action-bar">
          <Button variant="primary" extra-class="action-import" @click="goScripts">
            <app-icon name="book-open" :size="14" class="action-icon" />
            <text>导入故事</text>
          </Button>
          <Button variant="outline" extra-class="action-rooms" @click="goRooms">
            <app-icon name="users" :size="14" class="action-icon" />
            <text>多人联机</text>
          </Button>
        </view>

        <!-- 未登录引导（点击 → 设置档案卡登录） -->
        <view v-if="!settingsStore.isAuthenticated" class="login-hint" @click="goSettings">
          <app-icon name="feather" :size="13" class="login-hint-icon" />
          <text class="login-hint-text">未登录 — 点击前往「设置」创建调查员档案</text>
        </view>

        <!-- 新调查板块 -->
        <view class="stories">
          <view class="stories-head">
            <app-icon name="scroll" :size="15" class="stories-icon" />
            <text class="stories-title">新的调查</text>
          </view>

          <!-- 加载中 -->
          <view v-if="isLoading && stories.length === 0" class="gothic-card loading-card">
            <view class="sigil-spinner" />
            <text class="loading-text">加载故事中...</text>
          </view>

          <!-- 故事卡网格 -->
          <view v-else-if="stories.length" class="story-grid">
            <view
              v-for="story in stories"
              :key="story.storyId"
              class="gothic-card story-card"
              hover-class="story-card-hover"
              @click="openStory(story)"
            >
              <view class="story-badge">
                <text class="story-badge-text">{{ story.name.charAt(0) }}</text>
              </view>
              <view class="story-info">
                <text class="story-name">{{ story.name }}</text>
                <!-- 幕/场景结构仅在用户剧本带分级标题时存在（索引层不解析章节骨架）——
                     卡片元数据以信息块计数兜底，见 #27 项 3 -->
                <text class="story-meta">{{ story.chunkCount }} 个信息块</text>
              </view>
              <!-- T7：进行中角标（续玩入口，替代独立「继续游戏」块） -->
              <view v-if="roomByStory.has(story.storyId)" class="story-resume-badge">
                <text class="resume-dot" />
                <text>继续</text>
              </view>
              <view v-else class="story-cta">
                <text>开始调查</text>
              </view>
            </view>
          </view>

          <!-- 空态 -->
          <view v-else-if="!isLoading" class="gothic-card empty-card">
            <view class="empty-divider ink-divider" />
            <text class="empty-quote">"书架上空无一物..."</text>
            <text class="empty-hint">调查员，请先导入并索引故事文件</text>
            <view class="empty-divider ink-divider" />
            <button class="gothic-btn empty-btn" @click="goScripts">
              前往故事管理
              <text class="arrow">→</text>
            </button>
          </view>
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
  padding: 56px 24px 32px;
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
  background: radial-gradient(ellipse at center top, color-mix(in srgb, var(--c-eld-800) 14%, transparent) 0%, transparent 62%);
}
.sigil {
  position: absolute;
  left: 50%;
  top: 24px;
  width: 200px;
  height: 200px;
  margin-left: -100px;
  opacity: 0.035;
  color: var(--c-eld-500);
}
.ring {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  border: 1px solid currentColor;
  border-radius: 50%;
}
.r1 { width: 188px; height: 188px; }
.r2 { width: 146px; height: 146px; }
.r3 { width: 104px; height: 104px; border-width: 0.5px; }
.cross-h, .cross-v {
  position: absolute;
  left: 50%;
  top: 50%;
  background: currentColor;
}
.cross-h { width: 188px; height: 1px; transform: translate(-50%, -50%); }
.cross-v { height: 188px; width: 1px; transform: translate(-50%, -50%); }
.cross-d1, .cross-d2 {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 264px;
  height: 1px;
  background: currentColor;
  transform-origin: center;
}
.cross-d1 { transform: translate(-50%, -50%) rotate(45deg); }
.cross-d2 { transform: translate(-50%, -50%) rotate(-45deg); }

.hero-kicker {
  position: relative;
  z-index: 10;
  display: block;
  font-family: $font-mono;
  font-size: 10px;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--c-eld-600);
  margin-bottom: 10px;
}
.hero-title {
  position: relative;
  z-index: 10;
  display: block;
  font-family: $font-display;
  font-size: 2rem;
  font-weight: bold;
  color: var(--c-paper-100);
  text-shadow: 0 2px 14px color-mix(in srgb, var(--c-void) 90%, transparent);
}
.hero-sub {
  position: relative;
  z-index: 10;
  display: block;
  margin-top: 10px;
  font-size: 0.8125rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--c-slate-light);
  font-family: $font-body;
}
.hero-divider {
  position: relative;
  z-index: 10;
  margin: 18px auto 0;
  max-width: 200px;
}

/* ── 页面主体 ── */
.page-body {
  flex: 1;
  padding: 0 24px 48px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

/* ── 操作条：导入 + 多人 ── */
.action-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.action-import,
.action-rooms {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
}
.action-icon {
  color: inherit;
}

/* ── 未登录引导 ── */
.login-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 20px;
  padding: 10px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--c-ritual-900) 35%, transparent);
  border: 1px dashed color-mix(in srgb, var(--c-ritual-400) 35%, transparent);
  cursor: pointer;
}
.login-hint-icon {
  color: var(--c-ritual-300);
  flex-shrink: 0;
}
.login-hint-text {
  font-size: 12.5px;
  font-family: $font-serif;
  color: var(--c-ritual-200);
}

/* ── 新调查板块 ── */
.stories-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.stories-icon {
  color: var(--c-eld-400);
}
.stories-title {
  font-family: $font-display;
  font-size: 1.125rem;
  font-weight: bold;
  color: var(--c-paper-100);
  letter-spacing: 0.06em;
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
  color: var(--c-ash);
}

.story-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 640px) {
  .story-grid { grid-template-columns: repeat(2, 1fr); }
}
.story-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 16px;
  background: rgba(0, 0, 0, 0.6);
  border-left: 3px solid color-mix(in srgb, var(--c-eld-500) 40%, transparent);
  border-color: color-mix(in srgb, var(--c-obsidian-light) 80%, transparent);
  position: relative;
  overflow: hidden;
  transition: all 0.2s;
  text-align: left;
}
.story-card-hover {
  background: rgba(0, 0, 0, 0.75);
  transform: translateY(-1px);
  box-shadow: 0 0 18px color-mix(in srgb, var(--c-eld-500) 14%, transparent), inset 0 0 30px color-mix(in srgb, var(--c-eld-500) 3%, transparent);
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
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 60%, transparent);
  background: color-mix(in srgb, var(--c-eld-900) 70%, transparent);
  color: var(--c-eld-100);
}
.story-info {
  min-width: 0;
  flex: 1;
}
.story-name {
  display: block;
  font-family: $font-serif;
  font-weight: 600;
  font-size: 1rem;
  word-break: break-all;
  color: var(--c-paper-50);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.story-meta {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-family: $font-mono;
  color: var(--c-fog);
}
.story-cta {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--c-eld-700) 50%, transparent);
  background: color-mix(in srgb, var(--c-eld-900) 60%, transparent);
  color: var(--c-eld-100);
  opacity: 0.75;
}
/* 进行中角标（eldritch 绿脉冲点） */
.story-resume-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 9999px;
  border: 1px solid color-mix(in srgb, var(--c-eld-600) 60%, transparent);
  background: color-mix(in srgb, var(--c-eld-800) 60%, transparent);
  color: var(--c-eld-100);
}
.resume-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-eld-400);
  box-shadow: 0 0 6px var(--c-eld-400);
  animation: resume-pulse 1.6s ease-in-out infinite;
}
@keyframes resume-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
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
  color: var(--c-ash);
}
.empty-hint {
  display: block;
  font-size: 0.875rem;
  margin-bottom: 24px;
  color: var(--c-fog);
}
.empty-btn {
  background: rgba(0, 0, 0, 0.6);
}
.arrow {
  margin-left: 4px;
}
</style>
