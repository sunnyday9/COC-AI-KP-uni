<script setup lang="ts">
/**
 * AppIcon —— 线性图标（T2 基础基件，ADR-0004 设计稿线性 icon 集）。
 * 跨端策略：H5/App 渲染 inline SVG（细线 1.5px，对齐设计稿 Feather 风格）；
 * MP-WEIXIN 等无 SVG 能力端回退到字符符号（保持现状不倒退，小程序非本轮设计重点）。
 * 尺寸默认 18，颜色继承 currentColor。
 */
import { computed } from 'vue'
// 条件编译双根（H5 svg / MP text）→ 关自动继承，class 等 attrs 手工落根
defineOptions({ inheritAttrs: false })
const MP_FALLBACK: Record<string, string> = {
  house: '⌂',
  'book-open': '📖',
  sword: '⚔',
  gear: '⚙',
  dice: '🎲',
  scroll: '📜',
  search: '🔍',
  users: '👥',
  close: '✕',
  play: '▶',
  trash: '🗑',
  sparkle: '✦',
  feather: '🪶',
  x: '✕',
}

// 设计稿 1.5px 线性 stroke 图标（24 网格，stroke=currentColor）
const PATHS: Record<string, string> = {
  house:
    '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  'book-open':
    '<path d="M12 6.5C10 4.5 7 4 3 4.5V19c4-.5 7 0 9 2 2-2 5-2.5 9-2V4.5c-4-.5-7 0-9 2"/><path d="M12 6.5V21"/>',
  sword:
    '<path d="M14.5 4.5 19.5 9.5 21 3 14.5 4.5Z"/><path d="m14.5 4.5-4 4M19.5 9.5l-4.2 4.2M21 3l-5.5 1.5"/><path d="m10.5 8.5-6.5 6.5L2 22l7-2 6.5-6.5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>',
  dice:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="8.2" cy="8.2" r="0.6" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="0.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none"/><circle cx="8.2" cy="15.8" r="0.6" fill="currentColor" stroke="none"/><circle cx="15.8" cy="15.8" r="0.6" fill="currentColor" stroke="none"/>',
  scroll:
    '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v13.5H6.5A1.5 1.5 0 0 1 5 15V4.5Z"/><path d="M5 15a1.5 1.5 0 0 0 0 3h12.5v1.5A1.5 1.5 0 0 1 16 21H6.5a2.5 2.5 0 0 1 0-5Z"/><path d="M8.5 7h7M8.5 10h5"/>',
  search:
    '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.6-4.6"/>',
  users:
    '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17" cy="9.5" r="2.8"/><path d="M16.5 15.2c2.2.3 4 1.7 4.7 4.3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  play: '<path d="M7 4.5v15l13-7.5L7 4.5Z"/>',
  trash:
    '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>',
  feather:
    '<path d="M20 4c-6 0-11 4-13 10l-3 7 7-3c6-2 10-7 10-13Z"/><path d="M4 21C8 14 14 8 20 4"/>',
}

/** 把紧凑 path 串解析为可渲染子节点（uni-app H5 对 v-html 注入 SVG 支持不稳）。 */
interface IconPart {
  kind: 'path' | 'circle' | 'rect'
  d?: string
  cx?: number
  cy?: number
  r?: number
  x?: number
  y?: number
  width?: number
  height?: number
  rx?: number
  fill?: string
  stroke?: string
}

function parseParts(raw: string): IconPart[] {
  const parts: IconPart[] = []
  const tagRe = /<(path|circle|rect)\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(raw)) !== null) {
    const kind = m[1] as IconPart['kind']
    const attrs = m[2] || ''
    const get = (name: string): string | undefined => {
      const am = new RegExp(name + '="([^"]*)"').exec(attrs)
      return am ? am[1] : undefined
    }
    if (kind === 'path') {
      parts.push({ kind, d: get('d') })
    } else if (kind === 'circle') {
      parts.push({
        kind,
        cx: Number(get('cx') ?? 0),
        cy: Number(get('cy') ?? 0),
        r: Number(get('r') ?? 0),
        fill: get('fill'),
        stroke: get('stroke'),
      })
    } else if (kind === 'rect') {
      parts.push({
        kind,
        x: Number(get('x') ?? 0),
        y: Number(get('y') ?? 0),
        width: Number(get('width') ?? 0),
        height: Number(get('height') ?? 0),
        rx: get('rx') ? Number(get('rx')) : undefined,
      })
    }
  }
  return parts
}

const props = withDefaults(
  defineProps<{
    /** 图标名：house/book-open/sword/gear/dice/scroll/search/users/close/play/trash 等 */
    name: string
    size?: number
  }>(),
  { size: 18 },
)

const parts = computed<IconPart[]>(() => {
  const raw = PATHS[props.name] || ''
  return parseParts(raw)
})

</script>

<template>
  <!-- #ifndef MP-WEIXIN -->
  <svg
    v-bind="$attrs"
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- PATHS 由 vite/uni 编译期展开为真实 <path>/<circle>/<rect> 子节点 -->
    <template v-for="(d, idx) in parts" :key="idx">
      <path v-if="d.kind === 'path'" :d="d.d" />
      <circle v-else-if="d.kind === 'circle'" :cx="d.cx" :cy="d.cy" :r="d.r" :fill="d.fill || 'none'" :stroke="d.stroke || 'currentColor'" />
      <rect v-else-if="d.kind === 'rect'" :x="d.x" :y="d.y" :width="d.width" :height="d.height" :rx="d.rx" />
    </template>
  </svg>
  <!-- #endif -->
  <!-- #ifdef MP-WEIXIN -->
  <!-- 小程序 text 不支持 $attrs 动态展开（v-bind="" 编译错）——class 已静态落根 -->
  <text class="app-icon-fallback" :style="{ fontSize: size + 'px' }">{{ MP_FALLBACK[name] || '' }}</text>
  <!-- #endif -->
</template>

<style scoped lang="scss">
.app-icon {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
.app-icon-fallback {
  display: inline-block;
  line-height: 1;
  vertical-align: middle;
}
</style>
