# uni.scss → brilliant 设计令牌映射表（gothic-eldritch DS）

状态：随 UI 重设计原型（brilliant.design 项目 `COC-KP-UI`）同步。落码时以本表为准，把 `client/src/uni.scss` 旧变量替换为 CSS 变量层。

> 项目/画布位置：brilliant 项目 `Untitled Project` 下 `COC-KP-UI/01-design-system`（令牌面板 DS 00/DS 02）、`02-pages-desktop`、`03-pages-mobile`。
> DS 品牌名：`gothic-eldritch`（`Styles/gothic-eldritch.ds`）。

## 设计系统结构（DS 文件中的命名约定）

- **单点 ramp**：每个 uni.scss 色阶（50–900）用一支独立 `boldness(color(...))` ramp，命名 `<前缀>-<原档位>`（如 `paper-500`、`eld-300`、`blood-900`）；**元素行只允许引用 `.mid`**（数值档 `.50/.100/…` 属 authoring 专用，元素行禁用以保证 DS 内聚）。
- **语义 alias**：元素行唯一引用面，全部指向 `.mid`（与 uni.scss 原值**精确一致**，不受 mode 翻转影响——DS 只声明 `theme: [dark]`）。
- **字体**：`$font.family`（UI/正文默认 Fira Sans）、`$font.family.serif`（Crimson Text）、`$font.family.mono`（Fira Code）；Cinzel Decorative 作为 display 标题**按族名 inline 引用**（DS `font.family` 覆写为 Fira Sans 后，标题处用 `t(...,Cinzel Decorative,...)` 直接指定）。
- **字号刻度**：`$font.size.{xs..5xl}` = 10/12/14/16/20/24/28/32/40/48（对齐 ADR-0004 字阶：display 40/32、h1 28/24、h2 20、body 16/14、caption 12、micro 10）。
- **间距/圆角/描边**：沿用默认 DS 的 `$spacing.{xs..2xl}` 4pt 刻度、`$radius.{xs..full}` 4pt 刻度、`$stroke.width.{subtle..mid}`。

## 色板映射（全部 .mid → 精确 hex）

| uni.scss | 等效 hex | DS 令牌（.mid） | 用途 |
|---|---|---|---|
| `$c-void` | #080A0C | `ink-void` | 最底背景（页面 root fill） |
| `$c-abyss` | #0F1115 | `ink-abyss` | 面板/导航底色 `color.surface.container` |
| `$c-obsidian` | #181B21 | `ink-obsidian` | 卡片容器 `color.surface.container.high` |
| `$c-obsidian-light` | #1E2229 | `ink-obsidian-light` | hover 面 `color.surface.hover`、toast 面 |
| `$c-slate` | #23272F | `ink-slate` | 按压面 `color.surface.pressed` |
| `$c-slate-light` | #31363F | `ink-slate-light` | 描边 `color.outline.variant` |
| `$c-ash` | #454A54 | `ink-ash` | 次级描边/图标弱化 |
| `$c-fog` | #757C8A | `ink-fog` | 弱文本 `color.text.disabled` |
| `$c-parchment-50` | #F9F4EC | `paper-50` | 暗面正文最亮（elden） |
| `$c-parchment-100` | #F0E4D1 | `paper-100` | 正文主文本 `color.text.primary`/`on-surface` |
| `$c-parchment-200` | #E6D7BC | `paper-200` | 次亮文本（角色卡） |
| `$c-parchment-300` | #DDCDB0 | `paper-300` | — |
| `$c-parchment-400` | #CAB591 | `paper-400` | — |
| `$c-parchment-500` | #B8A17A | `paper-500` | 次文本 `color.text.secondary` |
| `$c-parchment-600` | #A99470 | `paper-600` | 卡内弱文本/编号 |
| `$c-parchment-700` | #837154 | `paper-700` | 羊皮纸卡描边 |
| `$c-parchment-800` | #5C513D | `paper-800` | — |
| `$c-parchment-900` | #363026 | `paper-900` | 羊皮纸卡底（档案卡/消息） |
| `$c-eldritch-50` | #D9F2EC | `eld-50` | — |
| `$c-eldritch-100` | #ABE3D5 | `eld-100` | active 文本 |
| `$c-eldritch-200` | #75D7BE | `eld-200` | 强调文本/描边 hover |
| `$c-eldritch-300` | #33CCA6 | `eld-300` | **主题主色** `color.primary`/display/glow |
| `$c-eldritch-400` | #22C39B | `eld-400` | 次级描边 |
| `$c-eldritch-500` | #248F74 | `eld-500` | — |
| `$c-eldritch-600` | #206F5B | `eld-600` | — |
| `$c-eldritch-700` | #1F5145 | `eld-700` | — |
| `$c-eldritch-800` | #17362E | `eld-800` | 印章/徽标底 |
| `$c-eldritch-900` | #11221E | `eld-900` | selected 面/深强调底 |
| `$c-blood-50..900` | 见换算 | `blood-50..900` | 危险系（300=主错误 `color.error`，200=危险文本，900=危险底） |
| `$c-sanity-50..900` | 见换算 | `sanity-50..900` | SAN/理智（300=数值色，900=底） |
| `$c-ritual-50..900` | 见换算 | `ritual-50..900` | 仪式金/线索/1920s（300=强调，400=描边，700=分隔线，900=底） |
| `$c-mana-50..900` | 见换算 | `mana-50..900` | MP/现代（300=数值色，900=底） |

> blood/sanity/ritual/mana 的 50–900 逐档 hex 由 `hsl(…)` 换算生成（#D22D2D/#8059CF/#DFB249/#478CD1 等主档见换算脚本输出），完整对照见 `docs/adr/0004` 立项时所用换算记录。

## 语义 alias 速查（元素行直接用）

```
color.surface              → ink-void.mid      （页面底）
color.surface.container    → ink-abyss.mid     （面板）
color.surface.container.high → ink-obsidian.mid（卡片）
color.surface.hover        → ink-obsidian-light.mid
color.surface.pressed      → ink-slate.mid
color.surface.selected     → eld-900.mid
color.text.primary         → paper-100.mid
color.text.secondary       → paper-500.mid
color.text.disabled        → ink-fog.mid
color.text.display         → eld-300.mid       （章节题眉）
color.text.bright          → paper-50.mid      （hero 大标题）
color.primary              → eld-300.mid       （主按钮/激活/辉光）
color.primary.container    → eld-900.mid
color.on-primary           → ink-void.mid      （绿底深字）
color.secondary            → ritual-300.mid
color.error                → blood-300.mid
color.warning              → ritual-300.mid
color.success              → eld-300.mid
color.info                 → mana-300.mid
color.outline.variant      → ink-slate-light.mid
color.shadow               → ink-void.mid
color.glow                 → eld-300.mid
```

## 阴影三档（uni.scss → 元素 shadow()）

| uni.scss | 语义 | 元素写法 |
|---|---|---|
| `$shadow-eldritch` | 常态辉光 | `shadow($eld-300.mid,o($visibility.subtle),y(0),blur(10))` |
| `$shadow-eldritch-lg` | 强调辉光 | `shadow($eld-300.mid,o($visibility.soft),y(0),blur(18))` |
| `$shadow-blood` | 危险辉光 | `shadow($blood-300.mid,o($visibility.faint),y(0),blur(18))` |
| `$shadow-ink-lg` | 抬升阴影 | `shadow($ink-void.mid,o($visibility.firm),y(16),blur(40))` |
| `$shadow-inner-glow` | 内发光 | fill 层 `(f2,glow($eld-300.mid,o($visibility.faint),blur(24)))` |

## 落码时的 CSS 变量建议

`client/src/uni.scss` 保持为单一事实源不动，新增 `:root{}`/`page{}` CSS 变量层命名对齐上表（`--c-eldritch-300` 等），组件样式逐步迁移；页面结构/布局改动以原型画布为准（桌面三栏 game、单页三步向导、底部胶囊+sheet 等，见 ADR-0004 决策 6-15）。
