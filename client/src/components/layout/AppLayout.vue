<script setup lang="ts">
import ToastContainer from '../ui/ToastContainer.vue'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 通用布局组件（Task 8，迁移自 original/AppLayout.vue）。
 * 原 vue-router 父子路由结构 → uni-app 无嵌套路由：每个页面自行包裹 <app-layout>。
 * - 桌面侧边栏 / 移动端底部导航：原 Tailwind md: 断点 → CSS @media（H5 生效；
 *   小程序端无媒体查询，回落为移动端底部导航形态）。
 * - 路由跳转：router.push → uni.navigateTo；首页为根页面用 uni.reLaunch
 *   （避免页面栈堆积）；当前项高亮由各页面传入 active 判断。
 * - 背景图：原各 View 自带 bg-cover + 暗色遮罩 → 统一由 layout 渲染
 *   <image mode="aspectFill"> 背景层 + 遮罩（小程序端 background-attachment
 *   不支持，fixed 背景层等价于原 bg-fixed）。
 */

export type AppLayoutActive = 'home' | 'scripts' | 'game' | 'settings'

const props = withDefaults(defineProps<{
  active: AppLayoutActive
  bg?: string
  /** 暗色遮罩不透明度（原 bg-black/70 ~ bg-black/80） */
  overlay?: number
  /** 沉浸模式：隐藏桌面侧边栏与移动底部导航（游戏页等全屏界面用） */
  chrome?: boolean
}>(), {
  bg: '/static/bg/bg_home.webp',
  overlay: 0.7,
  chrome: true,
})

const navItems = [
  { key: 'home' as const, path: '/pages/home/index', label: '首页', icon: 'house' },
  { key: 'scripts' as const, path: '/pages/scripts/index', label: '故事', icon: 'book-open' },
  { key: 'game' as const, path: '/pages/game/index', label: '游戏', icon: 'sword' },
  { key: 'settings' as const, path: '/pages/settings/index', label: '设置', icon: 'gear' },
]

function go(item: { key: string; path: string }) {
  if (item.key === props.active) return
  if (item.key === 'home') {
    uni.reLaunch({ url: item.path })
  } else {
    uni.navigateTo({ url: item.path })
  }
}
</script>

<template>
  <view class="app-layout">
    <!-- 背景层（fixed，等价原 bg-fixed + bg-cover + 暗色遮罩） -->
    <view class="bg-layer">
      <image class="bg-img" :src="bg" mode="aspectFill" />
      <view class="bg-overlay" :style="{ backgroundColor: 'rgba(0,0,0,' + overlay + ')' }" />
    </view>

    <!-- 桌面侧边栏 -->
    <view v-if="chrome" class="sidebar">
      <view class="sidebar-logo">
        <view class="corner tl" /><view class="corner tr" />
        <view class="corner bl" /><view class="corner br" />
        <text class="logo-title animate-flicker">AI COC Keeper</text>
        <text class="logo-sub">Call of Cthulhu</text>
        <view class="mt-2 ink-divider" />
      </view>

      <view class="sidebar-nav">
        <view
          v-for="item in navItems"
          :key="item.path"
          class="nav-item"
          :class="active === item.key ? 'nav-item-active' : 'nav-item-dim'"
          @click="go(item)"
        >
          <view v-if="active === item.key" class="nav-active-bar" />
          <app-icon :name="item.icon" :size="18" class="nav-icon" />
          <text class="nav-label">{{ item.label }}</text>
        </view>
      </view>

      <view class="sidebar-footer">
        <text class="footer-quote">Ph'nglui mglw'nafh Cthulhu R'lyeh wgah'nagl fhtagn</text>
        <view class="footer-line" />
      </view>
    </view>

    <!-- 主内容区 -->
    <view class="content" :class="{ 'content-immersive': !chrome }">
      <slot />
    </view>

    <!-- 移动端底部导航（毛玻璃） -->
    <view v-if="chrome" class="bottom-nav">
      <view
        v-for="item in navItems"
        :key="item.path"
        class="bottom-nav-item"
        :class="active === item.key ? 'bottom-nav-active' : 'bottom-nav-dim'"
        @click="go(item)"
      >
        <view v-if="active === item.key" class="bottom-active-dot" />
        <app-icon :name="item.icon" :size="20" class="bottom-icon" />
        <text class="bottom-label">{{ item.label }}</text>
      </view>
    </view>

    <!-- 全局 Toast（替代原 Teleport 到 body） -->
    <toast-container />
  </view>
</template>

<style scoped lang="scss">
.app-layout {
  position: relative;
  display: flex;
  height: 100vh;
  overflow: hidden;
  background-color: $c-void;
}

/* ── 背景层 ── */
.bg-layer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 0;
}
.bg-img {
  width: 100%;
  height: 100%;
}
.bg-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
}

/* ── 桌面侧边栏（md+；小程序无媒体查询 → 默认隐藏） ── */
.sidebar {
  display: none;
}
@media (min-width: 768px) {
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 240px;
    flex-shrink: 0;
    z-index: 10;
    position: relative;
    border-right: 1px solid $c-slate;
    background: linear-gradient(to bottom, $c-abyss, $c-obsidian);
  }
}

.sidebar-logo {
  position: relative;
  padding: 20px;
  border-bottom: 1px solid $c-slate;
  overflow: hidden;
}
.corner {
  position: absolute;
  width: 32px;
  height: 32px;
  border-color: color-mix(in srgb, var(--c-eld-500) 30%, transparent);
}
.corner.tl { top: 0; left: 0; border-top: 1px solid; border-left: 1px solid; }
.corner.tr { top: 0; right: 0; border-top: 1px solid; border-right: 1px solid; }
.corner.bl { bottom: 0; left: 0; border-bottom: 1px solid; border-left: 1px solid; }
.corner.br { bottom: 0; right: 0; border-bottom: 1px solid; border-right: 1px solid; }

.logo-title {
  display: block;
  font-family: $font-display;
  font-size: 1.25rem;
  font-weight: bold;
  letter-spacing: 0.1em;
  color: var(--c-paper-100);
  text-shadow: 0 0 20px color-mix(in srgb, var(--c-eld-500) 20%, transparent);
  position: relative;
  z-index: 10;
}
.logo-sub {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--c-ash);
  position: relative;
  z-index: 10;
}
.mt-2 {
  margin-top: 8px;
}

.sidebar-nav {
  flex: 1;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.3s;
}
.nav-item-active {
  color: $c-eldritch-100;
  background: $c-eldritch-mist;
}
.nav-item-dim {
  color: $c-fog;
}
.nav-active-bar {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 9999px;
  background: $c-eldritch-400;
  box-shadow: 0 0 8px color-mix(in srgb, var(--c-eld-500) 50%, transparent);
}
.nav-icon {
  font-size: 1rem;
  width: 20px;
  text-align: center;
}
.nav-label {
  font-size: 0.875rem;
}

.sidebar-footer {
  padding: 12px 20px;
  border-top: 1px solid color-mix(in srgb, var(--c-slate) 40%, transparent);
}
.footer-quote {
  display: block;
  font-size: 9px;
  font-style: italic;
  font-family: $font-serif;
  line-height: 1.6;
  color: var(--c-obsidian-light);
}
.footer-line {
  margin-top: 8px;
  height: 16px;
  opacity: 0.1;
  background: repeating-linear-gradient(
    to bottom,
    var(--c-eld-500) 0 1px,
    transparent 1px 4px
  );
}

/* ── 主内容区 ── */
.content {
  flex: 1;
  min-width: 0;
  position: relative;
  z-index: 10;
  overflow-y: auto;
  padding-bottom: 56px; /* 移动端底部导航占位 */
}
/* 沉浸模式（chrome=false）：无底部导航 → 无占位，内容真正全高 */
.content-immersive {
  padding-bottom: 0;
}
@media (min-width: 768px) {
  .content {
    padding-bottom: 0;
  }
}

/* ── 移动端底部导航 ── */
.bottom-nav {
  display: flex;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 50;
  border-top: 1px solid color-mix(in srgb, var(--c-slate) 60%, transparent);
  background: color-mix(in srgb, var(--c-abyss) 85%, transparent);
  backdrop-filter: blur(12px);
  padding-bottom: env(safe-area-inset-bottom);
}
@media (min-width: 768px) {
  .bottom-nav {
    display: none;
  }
}
.bottom-nav-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 0 8px;
  font-size: 12px;
  position: relative;
  transition: all 0.3s;
}
.bottom-nav-active {
  color: $c-eldritch-300;
}
.bottom-nav-dim {
  color: $c-fog;
}
.bottom-active-dot {
  position: absolute;
  top: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: $c-eldritch-400;
  box-shadow: 0 0 6px color-mix(in srgb, var(--c-eld-500) 60%, transparent);
}
.bottom-icon {
  font-size: 1.125rem;
  margin-bottom: 2px;
}
.bottom-label {
  font-size: 12px;
}
</style>
