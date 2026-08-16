# COC AI KP — uni-app 多端重构 (monorepo)

COC 7th 规则 AI 跑团助手，由原 Electron 单机应用重构为 **H5 + 微信小程序 + App** 三端架构：
Express + TypeScript 后端承载原主进程逻辑，uni-app (Vue 3) 前端，SQLite (node:sqlite) 持久化。

## 目录结构

```
AI-COC-KP/
├── server/      # Node.js/Express + TypeScript 后端（JWT 认证、SQLite、WebSocket）
├── client/      # uni-app (Vue 3 + Pinia) 前端（H5 / 微信小程序 / App）
├── shared/      # 共享 TypeScript 源码包（类型定义、COC 工具定义），无构建步骤，两端相对路径引用
├── e2e/         # H5 端到端测试（Playwright-core + MOCK_AI 后端，无需真实 LLM）
├── docs/        # MIGRATION-PLAN.md（整体计划）、api-contract.md（前后端 API 契约）
└── original/    # 原 Electron 项目（只读参考，禁止修改）
```

- 整体计划：`docs/MIGRATION-PLAN.md`
- API 契约（前后端唯一接口基准）：`docs/api-contract.md`

## 环境要求

- Node.js >= 24（依赖内置 `node:sqlite`，零原生依赖）
- H5 端到端测试需要本机安装 Microsoft Edge 或 Google Chrome（`playwright-core` 不下载浏览器）

## 安装

```bash
npm install    # 安装全部 workspace 依赖（client 为 uni-app，体积较大属正常）
```

## 三端运行

### 1. 后端（默认 http://localhost:3000）

```bash
npm run dev:server        # 或 cd server && npm run dev（tsx watch）
```

服务端环境变量（`server/.env` 或命令行注入，全部可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `JWT_SECRET` | `dev-secret-change-me` | JWT 签名密钥，**生产环境必须覆盖** |
| `MOCK_AI` | 未设置 | `1` = 所有 AI/LLM 调用替换为确定性内置脚本（无需 API Key、无外发请求、不下载模型），用于测试与演示 |
| `DATA_DIR` | `server/data` | SQLite 数据目录 |
| `RAG_DATA_DIR` | `server/data/rag` | RAG 向量/图谱数据目录 |
| `UPLOADS_DIR` | `server/uploads` | 上传的故事/剧本文件目录 |
| `MODELS_DIR` | `server/data/models` | 内置嵌入模型缓存目录 |
| `MAX_UPLOAD_BYTES` | `52428800` | 上传大小上限（50MB） |

### 2. H5 前端（开发模式，http://localhost:5175）

```bash
npm run dev:h5
```

- H5 dev 默认**同源直连后端**：vite 代理 `/api → http://localhost:3000`、`/ws → ws://localhost:3000`（见 `client/vite.config.js`），无需额外配置。
- 如后端不在 3000 端口，用 `VITE_API_BASE` 覆盖：`VITE_API_BASE=http://localhost:3001 npm run dev:h5`。
- 小程序/App 端必须显式设置 `VITE_API_BASE` 为绝对 URL（如 `https://your-server.com`），无合理相对默认值。

### 3. 微信小程序（mp-weixin）

```bash
cd client
npm run build:mp-weixin    # 产物输出到 client/dist/build/mp-weixin
```

然后：

1. 打开微信开发者工具 → 导入项目，目录选择 `client/dist/build/mp-weixin`。
2. AppID 选择测试号（或填入自己的小程序 AppID）。
3. 开发者工具中点击「编译」。真机预览需：小程序后台把服务器域名加入 request/uploadFile/socket 合法域名（https/wss），或开发者工具中勾选「不校验合法域名」。
4. 构建时传入后端地址：`VITE_API_BASE=https://your-server.com npm run build:mp-weixin`。

### 4. App（5+ App / iOS / Android）

```bash
cd client
npx uni build -p app        # App 产物输出到 client/dist/build/app
```

或使用 HBuilderX 云打包（无需本地原生环境）：

1. 用 HBuilderX 打开 `client/` 目录（HBuilderX 直接识别 uni-app 工程）。
2. 菜单 发行 → 原生App-云打包 → 选择 Android/iOS 证书（测试可用公共测试证书）→ 打包。
3. 后端必须为公网可访问的 https/wss 地址，构建时设置 `VITE_API_BASE=https://your-server.com`。
4. 打好的 apk/ipa 安装到真机即可；iOS 需签名/上架流程。

## 测试

```bash
npm run test:server    # 后端 vitest（含 MOCK_AI 分支用例）
npm run test:client    # 前端纯逻辑测试（vitest）
npm run test:all       # server + client 全部单测
npx tsc --noEmit       # client 类型检查（零错误基线）
```

### H5 端到端测试（无需真实 LLM）

```bash
npm run test:e2e:h5    # 等价于 node e2e/h5.journey.mjs
```

脚本自动：

- 以 `MOCK_AI=1 PORT=3100` 启动后端、以 `VITE_API_BASE=http://localhost:3100` 启动 H5 dev（端口 5175），测试完自动清理；
- 用本机 Edge/Chrome（playwright-core，不下载浏览器）走完整旅程：注册登录 → 设置保存 → 导入 `e2e/fixtures/demo-story.txt` → RAG 索引 → 首页选故事 → 选职业（法官）→ 创建角色（投骰 + 兴趣技能 + 姓名）→ 游戏开场 → 侦查消息（skill_check → grant_clue 工具闭环，线索+1）→ 战斗消息（skill_check → roll_dice → adjust_hp 闭环，HP -2）→ 存档 → 读档 → 恢复断言 → 截图（`e2e/screenshots/`）。

环境变量覆盖（用于复用外部服务或换浏览器）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `E2E_API_BASE` | `http://localhost:3100` | 后端地址；设置后脚本不再自启后端 |
| `E2E_WEB_BASE` | `http://localhost:5175` | H5 地址；设置后脚本不再自启前端 |
| `E2E_BROWSER` | 自动探测 msedge→chrome→已知路径 | 也可填浏览器可执行文件路径 |

失败时输出每步 PASS/FAIL 与耗时，并在 `e2e/screenshots/` 保存失败截图 + 页面 HTML dump。

### 微信小程序自动化测试（开发者工具真实运行时）

在微信开发者工具（游客/测试号登录）中验证小程序真实运行时，而非仅构建产物：

```bash
cd tools/mp-test
npm i miniprogram-automator     # 首次
node patch-automator.mjs        # 兼容新版 IDE（Tool.getInfo 返回结构变化，幂等）
node mp-test.mjs                # 连接 ws://localhost:9420 跑冒烟断言
```

前置条件（缺一不可）：

1. 微信开发者工具**以管理员身份启动**（自动化端口 9420 才会绑定）；
2. 设置 → 安全设置 → **服务端口** 开启；
3. 导入本项目构建产物 `client/dist/build/mp-weixin`（AppID 选测试号；构建命令见上文）。

覆盖断言（实测 **7/7 通过**，2026-08-16，DevTools 2.02.2608031 游客模式）：连接自动化 → 首页渲染（关键文案"AI COC Keeper / 克苏鲁的呼唤 — 智能守密人"等）→ 首页按钮 → 设置页（登录/配置输入框与文案）→ 返回首页。

踩坑记录（详见 `tools/mp-test/` 与设备端测试文档）：

- 自动化端口需管理员启动开发者工具；官方 `cli.bat` 存在 setlocal 递归 bug，可用 electron bootstrap 方式调用 CLI（`cli open-other` 可绕过游客 appid 校验）；
- 新版 IDE 的 `Tool.getInfo` 返回 `version` 字段，旧版 miniprogram-automator 的 `checkVersion` 会崩溃 → `patch-automator.mjs` 修补；
- 小程序端 API 调用需在开发者工具勾选「不校验合法域名」或在小程序后台配置 request/uploadFile/socket 合法域名。

### Android 模拟器验证（App 端）

用 Android SDK 模拟器（Pixel 5 / Android 14，WHPX 加速）加载 H5 构建验证 App 端逻辑（原生壳打包见上文 App 章节）：

```bash
# 构建指向宿主机的 H5（10.0.2.2 = 模拟器访问宿主机回环）
VITE_API_BASE=http://10.0.2.2:3000 npm --prefix client run build:h5
# 模拟器内 Chrome 打开 http://10.0.2.2:8080（静态服务 8080 + 后端 3000 MOCK_AI）
```

实测：首页完整渲染（无报错/白屏）；`nc 10.0.2.2 3000` 返回 401 + CORS 头（后端可达）。注意：重启 WinNAT 服务会破坏模拟器 Netsim 网络栈导致崩溃，启动时加 `-feature -Netsim`。

## 构建

```bash
cd server && npm run build      # tsc 编译到 server/dist（先清理旧产物），node dist/server/src/app.js 运行
cd client && npm run build:h5   # H5 产物 client/dist/build/h5（先清理旧产物）
cd client && npm run build:mp-weixin
```

## 说明

- `MOCK_AI=1` 仅影响 AI 调用路径（`server/src/services/mockAi.ts`），非 mock 路径行为完全不变（有单测证明）；KP Agent 的 LangGraph 状态机在 mock 模式下真实运行，仅 LLM 调用被确定性脚本替换（含 侦查→skill_check→grant_clue、战斗→skill_check→roll_dice→adjust_hp 等工具链）。
- `shared/` 为纯 TS 源码包（无构建步骤），server 与 client 通过相对路径直接引用。
- 服务端发起任何外部 URL 请求前必须通过 `server/src/utils/outboundUrl.ts` 校验（拒绝 localhost/私有/保留地址）。
