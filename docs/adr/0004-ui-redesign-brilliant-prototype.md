# ADR-0004：全界面 UI/UX 重设计——brilliant.design 高保真原型（保留哥特风专业化升级）

- 状态：已接受（2026-09-02）
- 关联：client/src/uni.scss（设计令牌源）、client/src/pages/*（现状 8 页）、ADR-0003（AI 协议，设置页已含协议卡片）
- 工具：~~Figma MCP~~ → **brilliant.design**（本地 loopback MCP，`@brilliant-hq/mcp`；Figma 路线因插件未装载/无 team 权限废弃，见会话记录）

## 背景

客户端为 uni-app（H5 + 小程序双端，无 tabBar，自定义 AppLayout 导航），8 页面（home / occupation / character-create / game / game-end / rooms / room / scripts / settings / rag-inspector），已有完整设计令牌（墨黑系 void/abyss/obsidian… + 羊皮纸 + 克苏鲁绿 eldritch + 血/理智紫/仪式金/魔力蓝 9 阶 + Cinzel Decorative/Crimson Text/Fira Sans 字体栈）。现状问题：①信息架构缺陷（游戏 tab 空壳、首页聚合「新故事+继续游戏+多人」职责混乱、建卡向导拆两页）；②视觉「自建感」（emoji 当图标、圆角/间距/阴影无系统刻度、卡片均匀堆叠无主次）；③UX 缺口（删除无确认、房间空态缺失、发送无反馈 toast）。全仓无设计稿痕迹，UI 无设计稿。

## 决策（grilling 21 题，三轮全按推荐）

1. **产出**：brilliant.design 高保真原型（先设计不落码，审阅后挑页落 Vue）。
2. **风格**：保留克苏鲁哥特·暗色档案识别度（墨黑+羊皮纸+eldritch 辉光），专业化升级 = 系统化层级/组件/布局。
3. **断点**：每页 Desktop 1440×900 + Mobile 390×844（Auto Layout 组件两断点复用）。
4. **文件结构**：单项目分区画布：`COC-KP-UI/01-design-system`（令牌面板 + 组件库 master）→ `02-pages-desktop`（P1–P10，跨画布 `inst()` 引用 master）→ `03-pages-mobile`（M1–M6）。brilliant 组件即项目内 master/instance，无需 library publish。
5. **令牌落地**：author 品牌 DS `gothic-eldritch`：色板逐档对齐 uni.scss（命名 `ink-*`/`paper-*`/`eld-*`/`blood-*`/`sanity-*`/`ritual-*`/`mana-*` + `.mid` 单点，元素行只用语义 alias），字体同款（Cinzel Decorative/Crimson Text/Fira Sans + Fira Code），字号系统化阶（display 40/32、h1 28/24、h2 20、body 16/14、caption 12、micro 10）；间距/圆角沿用 4pt 刻度。映射表见 `docs/design/uni-scss-to-brilliant-token-map.md`。
6. **信息架构**：
   - 导航 4 tab 重组：首页(调查局)/故事(档案室)/游戏(调查)/设置；「游戏」页收编「进行中的调查」列表（solo 续玩 + 多人房统一入口），首页回归纯「新调查启动台」（删继续游戏区块）。
   - 登录/注册保持嵌设置页首屏「档案卡」（不拆独立登录页）。
   - 建卡向导合并单页 3 步（Step1 选职业 / Step2 技能属性 / Step3 兴趣姓名 + 角色卡预览）。
   - 首页 Hero 大背景呼吸感 + 故事卡列表 + 多人入口 + 未登录引导。
7. **game 主界面**：桌面三栏（左场景线索 / 中对话流 / 右调查员档案），移动单栏 + 底部状态胶囊 + 线索/档案 bottom sheet。
8. **消息类型体系**：KP（左羊皮纸卡+徽记+流式光标）/ 玩家（右 eldritch 描边气泡）/ 系统叙事（居中暗金斜体，场景切换分隔卡）/ 骰子结果卡（大 d100 视觉焦点 + 成功/失败辉光）/ 线索获得（金描边 pill）/ 战斗伤害（血色调）。统一 icon 集（Phosphor 线性）替换 emoji。
9. **角色卡组件**：羊皮纸档案卡（仿 1920 空白角色卡，数字化）——桌面右栏完整档案 / 建卡 Step3 预览 / game-end 最终状态，三处复用同一组件。
10. **沉浸分层**：沉浸层（home/game/game-end 大背景图+暗角）/ 专注层（向导/房间 中背景）/ 工具层（scripts/settings/大厅 近纯色）。
11. **UX 缺口全补**：删除确认（Modal）、空态（大厅无房/线索空/技能空）、操作反馈（toast：发送/保存/测试）、危险操作分级（血/金/绿/灰）。设计稿画状态帧。
12. **prototype**：~~点击连线~~ → brilliant 无 prototype 连线，降级为「页序 + 触发」标注块（P1→P2→P3→P4→P5；侧链 P6·P7→P10；移动端同构）+ Presentation 全屏走查；组件一致性由 master/instance 保证。
13. **组件库范围**：基础（Btn 5 变体×态/Field/Badge 5/Avatar 2/NavItemSide/NavItemBottom slot 化）+ 复合（StoryCard/OccupationCard/Step 5/StatsBar/SkillRow/CharacterSheet + 消息 7 变体/Toast 2/Modal/EmptyState），约 30 组件 × 双断点复用。
14. **页面覆盖**：主流程 6 页高保真（home/向导合并页/game/game-end/settings），多人 2 页 + scripts 中保真，rag-inspector 占位。
15. **图标**：线性 icon 集（Phosphor），常态 parchment / active eldritch 双色。

## 被否决的替代

- 推翻色板换新风格 / 现代简洁 / 换强风格（保留题材识别度，系统化即可，Q4）。
- 独立登录页首启强制登录（应用可 MOCK 单机玩，不该强制，Q8）。
- game 保持单栏 / 线索仍侧滑（桌面三栏是「桌面 RPG 桌面感」核心，移动 sheet 更顺手，Q9）。
- 建卡保持两页（合并单页向导心智连续，Q12）。
- 首页叙事化落地页（对每日续玩场景是障碍，Q13）。
- emoji 保留（自建感最大来源，Q16）。
- 8 页全高保真（低价值页中保真/占位，Q2）。

## 后果

- 本 ADR 交付 = brilliant.design 项目画布（`Untitled Project` 下 `COC-KP-UI/`），不直接改代码；审阅后挑页落 Vue（design tokens → CSS 变量对照 uni.scss 落地）。
- uni.scss 令牌 → brilliant token 全量映射表（`docs/design/uni-scss-to-brilliant-token-map.md`）是落码时改 CSS 的基准。
- 页面 DOM 结构会随新布局变化（如 game 三栏、向导合并），落码时以画布 + 组件库为准。
- e2e 选择器依赖现状 DOM，落码后需同步更新（后续票）。
- brilliant 能力边界：无 Figma 式 prototype 连线 / Color Variables（以 DS token 系统替代）/ 团队库（master 同项目引用替代）；导出用 `export` 渲染 png/svg/html。
- rag-inspector 占位、dev 工具不进重设计范围。
