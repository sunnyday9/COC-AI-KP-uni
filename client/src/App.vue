<script>
import { getToken } from './platform/token'

export default {
  onLaunch: function () {
    // Task 8：启动时若有本地 token，恢复登录态并预载服务端设置（settings 页可立即使用）。
    // Task 9（Task 8 Minor ②）：me() 恢复 isAuthenticated（401 静默 → settings 页显示登录表单）。
    // 动态 import 避免 pinia 实例化时序问题；失败静默（settings 页会自行处理）。
    if (getToken()) {
      import('./stores/settingsStore').then(({ useSettingsStore }) => {
        const store = useSettingsStore()
        store.me().catch(() => {})
        store.load().catch(() => {})
      })
    }
  },
  onShow: function () {
    // noop — 保留模板默认生命周期
  },
  onHide: function () {
    // noop
  },
}
</script>

<style lang="scss">
/* ══════════════════════════════════════════════════════════════════
   全局样式（Task 8，迁移自 original/ai-trpg-web/src/style.css）
   Tailwind 工具类 → 全局组件类（gothic-* / ink-divider / sigil-spinner 等）
   ══════════════════════════════════════════════════════════════════ */

/* ── 基础 ── */
page,
body {
  background-color: $c-void;
  color: hsl(38, 40%, 78%);
  font-family: $font-body;
}

/* 噪点纹理（原 style.css body 背景，Task 9 / Task 8 Minor ⑤）：
   数据 URI 为 SVG（~0.6KB，体积可忽略），但 WXSS background-image 不支持
   SVG 渲染（会静默失效）→ 仅 H5 保留；MP 端使用纯色背景。 */
// #ifdef H5
page,
body {
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
}
// #endif

/* ══════════════════════════════════════════════════════════════════
   设计令牌 CSS 变量层（T1 令牌地基，ADR-0004）
   uni.scss 为单一事实源；此处把 scss 变量编译为 :root/page 级 CSS
   变量，供所有页面/组件以 var(--*) 引用（替换散落裸 hsl 字面量）。
   命名对齐 docs/design/uni-scss-to-brilliant-token-map.md：
   --c-<ramp>-<stop> 色板 + --c-<semantic> 语义 + --font-* + --shadow-*。
   ══════════════════════════════════════════════════════════════════ */
page {
  /* 墨与纸 */
  --c-void: #{$c-void};
  --c-abyss: #{$c-abyss};
  --c-obsidian: #{$c-obsidian};
  --c-obsidian-light: #{$c-obsidian-light};
  --c-slate: #{$c-slate};
  --c-slate-light: #{$c-slate-light};
  --c-ash: #{$c-ash};
  --c-fog: #{$c-fog};
  --c-paper-50: #{$c-parchment-50};
  --c-paper-100: #{$c-parchment-100};
  --c-paper-200: #{$c-parchment-200};
  --c-paper-300: #{$c-parchment-300};
  --c-paper-400: #{$c-parchment-400};
  --c-paper-500: #{$c-parchment-500};
  --c-paper-600: #{$c-parchment-600};
  --c-paper-700: #{$c-parchment-700};
  --c-paper-800: #{$c-parchment-800};
  --c-paper-900: #{$c-parchment-900};
  /* 克苏鲁绿（主题强调） */
  --c-eld-50: #{$c-eldritch-50};
  --c-eld-100: #{$c-eldritch-100};
  --c-eld-200: #{$c-eldritch-200};
  --c-eld-300: #{$c-eldritch-300};
  --c-eld-400: #{$c-eldritch-400};
  --c-eld-500: #{$c-eldritch-500};
  --c-eld-600: #{$c-eldritch-600};
  --c-eld-700: #{$c-eldritch-700};
  --c-eld-800: #{$c-eldritch-800};
  --c-eld-900: #{$c-eldritch-900};
  /* 血 / 理智 / 仪式金 / 魔力蓝 */
  --c-blood-50: #{$c-blood-50};
  --c-blood-100: #{$c-blood-100};
  --c-blood-200: #{$c-blood-200};
  --c-blood-300: #{$c-blood-300};
  --c-blood-400: #{$c-blood-400};
  --c-blood-500: #{$c-blood-500};
  --c-blood-600: #{$c-blood-600};
  --c-blood-700: #{$c-blood-700};
  --c-blood-800: #{$c-blood-800};
  --c-blood-900: #{$c-blood-900};
  --c-sanity-50: #{$c-sanity-50};
  --c-sanity-100: #{$c-sanity-100};
  --c-sanity-200: #{$c-sanity-200};
  --c-sanity-300: #{$c-sanity-300};
  --c-sanity-400: #{$c-sanity-400};
  --c-sanity-500: #{$c-sanity-500};
  --c-sanity-600: #{$c-sanity-600};
  --c-sanity-700: #{$c-sanity-700};
  --c-sanity-800: #{$c-sanity-800};
  --c-sanity-900: #{$c-sanity-900};
  --c-ritual-50: #{$c-ritual-50};
  --c-ritual-100: #{$c-ritual-100};
  --c-ritual-200: #{$c-ritual-200};
  --c-ritual-300: #{$c-ritual-300};
  --c-ritual-400: #{$c-ritual-400};
  --c-ritual-500: #{$c-ritual-500};
  --c-ritual-600: #{$c-ritual-600};
  --c-ritual-700: #{$c-ritual-700};
  --c-ritual-800: #{$c-ritual-800};
  --c-ritual-900: #{$c-ritual-900};
  --c-mana-50: #{$c-mana-50};
  --c-mana-100: #{$c-mana-100};
  --c-mana-200: #{$c-mana-200};
  --c-mana-300: #{$c-mana-300};
  --c-mana-400: #{$c-mana-400};
  --c-mana-500: #{$c-mana-500};
  --c-mana-600: #{$c-mana-600};
  --c-mana-700: #{$c-mana-700};
  --c-mana-800: #{$c-mana-800};
  --c-mana-900: #{$c-mana-900};

  /* 语义 alias（对齐 token map 语义面，供 var(--c-primary) 等） */
  --c-bg: #{$c-void};
  --c-surface: #{$c-abyss};
  --c-card: #{$c-obsidian};
  --c-hover: #{$c-obsidian-light};
  --c-pressed: #{$c-slate};
  --c-outline: #{$c-slate-light};
  --c-outline-weak: #{$c-ash};
  --c-text-primary: #{$c-parchment-100};
  --c-text-secondary: #{$c-parchment-500};
  --c-text-disabled: #{$c-fog};
  --c-text-display: #{$c-eldritch-300};
  --c-text-bright: #{$c-parchment-50};
  --c-text-eld: #{$c-eldritch-100};
  --c-primary: #{$c-eldritch-300};
  --c-primary-dim: #{$c-eldritch-200};
  --c-primary-deep: #{$c-eldritch-400};
  --c-primary-bg: #{$c-eldritch-800};
  --c-primary-bg-deep: #{$c-eldritch-900};
  --c-danger: #{$c-blood-300};
  --c-danger-dim: #{$c-blood-200};
  --c-danger-bg: #{$c-blood-900};
  --c-on-primary: #{$c-void};
  --c-on-danger: #{$c-parchment-50};
  --c-warning: #{$c-ritual-300};
  --c-info: #{$c-mana-300};
  --c-sanity: #{$c-sanity-300};

  /* 字体族 */
  --font-display: #{$font-display};
  --font-serif: #{$font-serif};
  --font-body: #{$font-body};
  --font-mono: #{$font-mono};

  /* 阴影（对齐 token map 三档 + 既有 ink 系） */
  --shadow-eldritch: #{$shadow-eldritch};
  --shadow-eldritch-lg: #{$shadow-eldritch-lg};
  --shadow-blood: #{$shadow-blood};
  --shadow-sanity: #{$shadow-sanity};
  --shadow-ritual: #{$shadow-ritual};
  --shadow-mana: #{$shadow-mana};
  --shadow-ink: #{$shadow-ink};
  --shadow-ink-lg: #{$shadow-ink-lg};
}

/* 大气滚动条（H5；小程序使用原生滚动条） */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: hsl(220, 18%, 7%);
}
::-webkit-scrollbar-thumb {
  background: hsl(220, 14%, 16%);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: hsl(220, 10%, 30%);
}

/* 选中色（H5） */
::selection {
  background: hsla(165, 60%, 35%, 0.3);
  color: hsl(38, 50%, 88%);
}

/* 移除 uni button 默认边框（小程序 button::after）与内边距差异 */
button::after {
  border: none;
}
button {
  margin: 0;
}

/* ── 卡片：墨迹边框、微内辉光 ── */
.gothic-card {
  border-radius: 0.5rem;
  background: hsla(220, 16%, 11%, 0.88);
  border: 1px solid hsl(220, 14%, 16%);
  box-shadow:
    0 1px 3px hsla(220, 20%, 4%, 0.6),
    0 0 0 1px hsla(220, 14%, 16%, 0.3);
}

/* ── 按钮：克苏鲁辉光主按钮 ── */
.gothic-btn,
.gothic-btn-danger,
.gothic-btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  font-weight: 500;
  font-size: 0.875rem;
  line-height: 1.5;
  transition: all 0.2s;
  box-sizing: border-box;
}
.gothic-btn {
  background: hsla(165, 45%, 22%, 0.7);
  color: hsl(165, 50%, 78%);
  border: 1px solid hsla(165, 55%, 28%, 0.6);
}
.gothic-btn-danger {
  background: hsla(0, 55%, 22%, 0.7);
  color: hsl(0, 55%, 82%);
  border: 1px solid hsla(0, 60%, 28%, 0.6);
}
.gothic-btn-secondary {
  background: hsla(220, 16%, 11%, 0.75);
  color: hsl(38, 25%, 55%);
  border: 1px solid hsl(220, 14%, 16%);
}

/* hover 态（Task 9 / Task 8 Minor ⑤）：H5 保留（原 style.css hover 规则），
   MP 端无 :hover 概念，跳过（MP 用 hover-class 按压态，见各页关键按钮） */
// #ifdef H5
.gothic-card:hover {
  border-color: hsla(220, 14%, 22%, 0.8);
  background: hsla(220, 16%, 12%, 0.92);
}
.gothic-btn:hover:not(:disabled) {
  background: hsla(165, 50%, 25%, 0.85);
  border-color: hsl(165, 60%, 35%);
}
.gothic-btn-danger:hover:not(:disabled) {
  background: hsla(0, 60%, 25%, 0.85);
  border-color: hsl(0, 65%, 35%);
}
.gothic-btn-secondary:hover:not(:disabled) {
  background: hsla(220, 16%, 14%, 0.9);
  color: hsl(38, 40%, 78%);
  border-color: hsl(220, 12%, 22%);
}
// #endif

/* ──────────────────────────────────────────────────────────────────
   按钮语义变体（T2 基础基件，ADR-0004 设计稿 Btn 5 变体）
   与 .gothic-btn* 并存，页面渐进迁移到 .btn-*；均以令牌 var() 实现。
   尺寸：44 高 / 字号 14 / rd 4；hover 态 H5 专用，MP 用 hover-class。
   ────────────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 1rem;
  height: 44px;
  border-radius: 4px;
  font-family: $font-serif;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.36;
  border: 1px solid transparent;
  box-sizing: border-box;
  transition: all 0.2s;
}
/* primary — 克苏鲁绿实底（主操作） */
.btn-primary {
  background: var(--c-primary);
  color: var(--c-on-primary);
  box-shadow: 0 0 10px rgba(51, 204, 166, 0.2);
}
/* outline 绿 — 次级 */
.btn-outline {
  background: transparent;
  color: var(--c-eld-200);
  border-color: var(--c-eld-400);
}
/* outline 血 — 危险次级 */
.btn-outline-danger {
  background: transparent;
  color: var(--c-blood-200);
  border-color: var(--c-blood-300);
}
/* ghost 文字 — 低危 */
.btn-ghost {
  background: transparent;
  color: var(--c-paper-500);
}
/* 实底血 — 危险主操作 */
.btn-danger-solid {
  background: var(--c-danger);
  color: #f9f4ec;
  box-shadow: 0 0 10px rgba(210, 45, 45, 0.2);
}
/* 实底金 — 警示主操作（如清除/重置类） */
.btn-warning {
  background: var(--c-warning);
  color: var(--c-on-primary);
  box-shadow: 0 0 10px rgba(217, 163, 38, 0.2);
}
.btn:disabled,
.btn.is-disabled {
  opacity: 0.4;
  box-shadow: none;
  pointer-events: none;
}
// #ifdef H5
.btn-primary:hover:not(:disabled) {
  background: var(--c-eld-200);
  box-shadow: 0 0 16px rgba(51, 204, 166, 0.4);
}
.btn-outline:hover:not(:disabled) {
  border-color: var(--c-eld-300);
  border-width: 1.5px;
  color: var(--c-eld-100);
}
.btn-outline-danger:hover:not(:disabled) {
  border-color: var(--c-blood-200);
  border-width: 1.5px;
  color: var(--c-blood-100);
}
.btn-ghost:hover:not(:disabled) {
  color: var(--c-paper-100);
}
.btn-danger-solid:hover:not(:disabled) {
  background: var(--c-blood-200);
}
// #endif
/* 按压态（MP） */
.btn-hover-press {
  opacity: 0.75;
}

/* ── 输入框：羊皮纸聚焦 ── */
.gothic-input {
  width: 100%;
  /* uni-h5 给 uni-input 宿主默认 height/min-height: 1.4em —— border-box 下
     padding+border 会把内层原生 input 挤到 1.6px，输入文字被 overflow:clip
     裁到只剩一条缝（登录页用户名不可见的根因）。显式高度保证内容区 ≥ 行高。 */
  height: 2.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  line-height: 1.5;
  background: hsla(220, 18%, 7%, 0.85);
  color: hsl(38, 40%, 78%);
  border: 1px solid hsl(220, 14%, 16%);
  box-sizing: border-box;
}
.gothic-input::placeholder {
  color: hsl(220, 10%, 30%);
}
.gothic-input:focus {
  outline: none;
  border-color: hsla(165, 55%, 28%, 0.6);
}

/* placeholder 类（小程序 input/textarea 无 ::placeholder，用 placeholder-class） */
.gothic-ph {
  color: hsl(220, 10%, 30%);
}

/* ── 标题排版 ── */
.gothic-heading {
  font-family: $font-display;
  letter-spacing: 0.05em;
  color: hsl(38, 50%, 88%);
}
.gothic-body {
  font-family: $font-serif;
  color: hsl(38, 40%, 78%);
}

/* ── 装饰工具 ── */
.ink-divider {
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    hsl(220, 14%, 16%),
    hsla(165, 60%, 35%, 0.2),
    hsl(220, 14%, 16%),
    transparent
  );
}

.vignette-overlay {
  position: relative;
}
.vignette-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse at center,
    transparent 70%,
    hsla(220, 20%, 4%, 0.4) 100%
  );
  pointer-events: none;
  z-index: 1;
}

/* ── 徽记加载转轮 ── */
.sigil-spinner {
  display: inline-block;
  width: 1.5rem;
  height: 1.5rem;
  border: 2px solid hsla(165, 60%, 35%, 0.2);
  border-top-color: hsl(165, 60%, 35%);
  border-radius: 50%;
  animation: sigil-spin 2s linear infinite;
}

/* ── 禁用态（小程序无 :disabled 伪类，用 .is-disabled 类） ── */
.is-disabled {
  opacity: 0.4;
}

/* ── 动画 ── */
@keyframes flicker {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.82; }
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-up {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 8px hsla(165, 60%, 35%, 0.2); }
  50% { box-shadow: 0 0 20px hsla(165, 60%, 35%, 0.45); }
}
@keyframes ink-spread {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes sigil-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes breathe {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
@keyframes pulse-slow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.animate-breathe { animation: breathe 4s ease-in-out infinite; }
.animate-flicker { animation: flicker 3s ease-in-out infinite alternate; }
.animate-fade-in { animation: fade-in 0.5s ease-out; }
.animate-slide-up { animation: slide-up 0.3s ease-out; }
.animate-glow-pulse { animation: glow-pulse 2.5s ease-in-out infinite; }
.animate-ink-spread { animation: ink-spread 0.6s ease-out; }
.animate-sigil-spin { animation: sigil-spin 2s linear infinite; }
.animate-pulse-slow { animation: pulse-slow 4s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
</style>
