# 依赖漏洞联网复核报告（2026-09-04）

> 背景：Mimosa 离线 advisory 报告「11 包 17 条」需联网复核；本机有网 → 用 npm 官方源
> （registry.npmjs.org）对当前 lockfile 跑权威 audit 实锤。结论与 Mimosa 离线口径
> 不同（npm 实时库更全：69 条），本文档为可追溯证据。

## 结论速览

| 分类 | 数量 | 处置 |
|---|---|---|
| server 生产运行时受影响 | **1 包**（@huggingface/transformers→sharp 0.34.5, high, 无修复） | 攻击面极低（本地嵌入图像），可暂缓 |
| server 生产运行时**真实可利用** | **1 条**（epub2→adm-zip 0.5.16, high, 无修复） | epub 导入功能路径，**建议 overrides 强升 adm-zip 0.6.0** |
| 根 dev/构建工具链（jest/@dcloudio uni-*/vite/rollup/tsx 等） | 68 条（34 low/18 mod/16 high） | **不碰生产运行时**（构建期/测试期），uni-app 锁版本，无可修 |
| server 运行时已安全 | express 4.22.2 / ws 8.21.3 / cookie 0.7.2 / path-to-regexp 0.1.13 / qs 6.15.3 / jsdom 28.1.0 | 无需处理 |

## 关键证据（版本实锤）

- **server 直接依赖实际解析实例**（workspace 提升到根或 server/node_modules）：
  express 4.22.2 / ws 8.21.3 / jsdom 28.1.0（server）/ epub2 3.0.2 / @huggingface/transformers 3.5.0（server）。
- **express 4.22.2** 自身依赖 path-to-regexp ~0.1.12 / qs ~6.15.1 / body-parser ~1.20.5 —— audit 报
  path-to-regexp <=0.1.12、qs <=6.15.3、body-parser <=2.0.2 仍中招且 fixAvailable=None → **express 4 线已到顶，
  修复只在 express 5.x**（router 2.x / body-parser 2.x / qs 新版）。npm audit 中 express 的 nodes
  含 `node_modules/@dcloudio/vite-plugin-uni/node_modules/express`（4.20.0，构建期）与
  `node_modules/express`（4.22.2）两实例；4.22.2 仍报是因为其依赖的 qs/path-to-regexp 版本在
  漏洞 range 内（npm 对 4.22.2 也标 vulnerable，但无 4.x 修复版）。
- **jsdom**：根 16.7.0（jest dev 链）中招；server 运行时 28.1.0（server/node_modules）安全。
- **http-proxy-agent**：根 4.0.1（jest 链）中招；server 7.0.2 安全。
- **adm-zip 0.5.16**（epub2 ^0.5.10 锁）→ high「Crafted ZIP file triggers 4GB memory allocation」；
  修复版 0.6.0 已发布，epub2 声明 `^0.5.10` 会拦 0.6.0 → 需 **root overrides**。
- **sharp 0.34.5**（transformers ^0.34.5 锁）→ high「libvips CVE-2026-33327/33328/35590/35591」；
  修复版 0.35.4 已发布，同样需 overrides。
- 版本可用性已验证：`adm-zip@0.6.0`、`sharp@0.35.4` 均可从 registry 安装。

## 建议处置（待决策，非本次已执行）

1. **adm-zip 强升 0.6.0**（overrides）：封掉 epub 导入的 DoS 面。需跑 server 全量测试 +
   epub 导入路径回归（e2e 未覆盖 epub，需手动/脚本验一次）。
2. **sharp 强升 0.35.4**（overrides）：封本地嵌入图像 CVE。攻击面极低（需本地模型+恶意图像），
   可随下次依赖升级一起。
3. **express 4→5**：唯一能清 express 线漏洞的方式，但破坏性升级（路由/中间件语义），
   建议单独立项评估（代码面干净：无 `*` 通配/无 `app.del`，成本可控）。
4. **68 条 dev/构建链**：uni-app 锁版本生态（@dcloudio 全家），npm audit fix --force 会引入
   breaking change（uni-mp-weixin@0.0.973 等），**不建议动**；jest/tsx 等 dev 工具不在生产暴露面。
5. `npm audit fix`（安全版）干跑 69 条不变 → 无安全版可修，全部需 --force 或 overrides。

## 与 Mimosa 离线口径的差异说明

Mimosa「11 包 17 条」来自其离线 advisory 库（OSV 子集）；npm 实时库更全（69 条）。
本报告以 npm 官方实时数据为准（2026-09-04）。

## 处置进展：express 4 → 5 升级完成（2026-09-04，issue #34）

- server/package.json：express `^4.21.2` → `^5.2.1`、@types/express `^4` → `^5`。
- **零代码破坏**：server 457/457 + client 113/113 + 三 journey 14×3 + server tsc 全绿（代码面干净：
  无 `*` 通配路由/无 app.del/req.query 仅读字符串，v5 破坏点全不命中；`express.json()` 内置
  body-parser 2.x 的 entity.parse.failed 错误契约未变）。
- **audit 复跑**：express 5.2.1（根）已移出漏洞 range（`3.0.0-alpha1 - 5.0.1`）→ **server 运行时
  express 线漏洞全清**。剩余 express/body-parser/path-to-regexp/qs 报的全为
  `@dcloudio/vite-plugin-uni/node_modules/*`（构建期 dev 链，不碰生产）+ 顶层 qs 6.15.3
  （express 5 锁 `^6.14.0` 能装的最新，qs 上游 6.x 无修复版 → 生态残余，非本次可消除）。
- 遗留建议：adm-zip/sharp overrides 强升（另一张票）。
