# COC AI KP — uni-app 多端重构 (monorepo)

COC 7th 规则 AI 跑团助手，由原 Electron 单机应用重构为 **H5 + 微信小程序 + App** 三端架构：
Express + TypeScript 后端承载原主进程逻辑，uni-app (Vue 3) 前端，SQLite (node:sqlite) 持久化。

## 目录结构

```
AI-COC-KP/
├── server/      # Node.js/Express + TypeScript 后端（JWT 认证、SQLite、WebSocket）
├── client/      # uni-app (Vue 3 + Pinia) 前端（H5 / 微信小程序 / App）
├── shared/      # 共享 TypeScript 源码包（类型定义、COC 工具定义），无构建步骤，两端相对路径引用
├── docs/        # MIGRATION-PLAN.md（整体计划）、api-contract.md（前后端 API 契约）
└── original/    # 原 Electron 项目（只读参考，禁止修改）
```

- 整体计划：`docs/MIGRATION-PLAN.md`
- API 契约（前后端唯一接口基准）：`docs/api-contract.md`

## 环境要求

- Node.js >= 24（依赖内置 `node:sqlite`，零原生依赖）

## 启动方式

```bash
npm install          # 安装全部 workspace 依赖（client 为 uni-app，体积较大属正常）

# 后端（默认 http://localhost:3000）
npm run dev:server

# 前端 H5
npm run dev:h5

# H5 构建产物
npm run build:h5

# 后端测试
npm test
```

各包亦可独立运行：

```bash
cd server && npm run dev        # 后端开发模式（tsx watch）
cd server && npm test           # vitest
cd server && npm run build      # tsc 编译到 dist
cd client && npm run dev:h5     # 前端 H5 开发模式
cd client && npx vitest run     # 前端复用的纯逻辑测试
```

## 说明

- 当前为 Phase 0 脚手架：后端所有业务路由返回 `501 { error: 'not implemented' }`，前端为占位页面；
  业务逻辑按 `docs/MIGRATION-PLAN.md` 分阶段实施。
- `shared/` 为纯 TS 源码包（无构建步骤），server 与 client 通过相对路径直接引用。
- 复制自原项目的纯逻辑模块（`client/src/logic/`、`diceService`、`tracing`、`toolCalling/handlers`、
  `data/coc7.ts`）保持零逻辑改动，其测试在 `client` 中原样通过。
- 服务端发起任何外部 URL 请求前必须通过 `server/src/utils/outboundUrl.ts` 校验（拒绝 localhost/私有/保留地址）。
