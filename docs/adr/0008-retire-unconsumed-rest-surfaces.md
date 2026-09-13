# ADR-0008：退役无消费方 REST 面——/api/saves* ×4、/api/rag/story-overview、bridge 死包装 ×4 全链下线

- 状态：已接受（2026-09-13）
- 关联：ADR-0002（服务端上下文收口）；决策票 #91；执行票 #92（A 桶 `/api/saves*`）、#93（B 桶 `/api/rag/story-overview`）、#94（C 桶 bridge 死包装 ×4）；前置 #59（saveMigration 删除）、#60（客户端存读档链删除）、#85（客户端 ragStoryOverview 删除）

## 背景

ADR-0002 把回合上下文注入收口到服务端并删除 gameStore 后，一批 REST 面的**客户端消费链断裂**：客户端死面虽已分票清除（#59/#60 删存读档链、#85 删 ragStoryOverview，架构走查 R8 修正库存），但**服务端 REST 端点与其后端链全部保留至今**——生产零调用方，唯一消费者是路由自测 / bridge 测试的自引用。是否退役属对外 API 契约变更，#91 统一拍板避免散票二次断代。

## 决策

2026-09-13 用户拍板**三桶全链退役**（#91 选项 1），执行票已全部落地 main：

1. **A 桶 `/api/saves*` ×4**（#92，efd4053）：GET /api/saves、GET /api/saves/:id、PUT /api/saves/:id、DELETE /api/saves/:id 四端点 + saveService + `saves` 建表语句 + training save 导出源与 distill 死读 + 契约 §7（15 文件 +33/−715）。
2. **B 桶 `/api/rag/story-overview`**（#93，826359e）：路由 + ragService.storyOverview + vectorStore.getStoryOverview 全链 + 契约 §8（5 文件 +4/−45）。
3. **C 桶 bridge 死包装 ×4**（#94，056bc0d）：客户端 listScripts/importScript/characterDetail/characterDelete 四方法 + 服务端对应端点（DELETE 与 GET /api/characters/:id、GET /api/scripts 列表、POST /api/scripts/upload）+ scriptService 孤儿链（listScripts/importScript/importLegacyFile）+ scripts 上传的 multer 接线 + 契约 §6/§9/§10（10 文件 +46/−300）。

## 证据（零消费方核验）

三桶共用同一核验方法——**deletion test**：删除符号后全量测试套件跑绿即证零真实消费方（对齐 #88/#89/#90 先例）。

- **A 桶**：客户端写入链断于 #59/#60（gameStore 删除后无写入方，`saves` 表恒空）；服务端唯一消费者是 saves.routes.test.ts 自引用（随端点同删）。
- **B 桶**：五层链唯一消费者是路由自测组合用例（#85 已删客户端 bridge 方法 ragStoryOverview；组合用例摘段后 stories/getIndex 断言保留）。
- **C 桶**：bridge 四方法零页面调用方（仅 bridge.test.ts 自引用）；四个服务端端点全仓零直接消费方。**e2e uploadScript 甄别**：dossier.journey.mjs 与 multiroom.journey.mjs 的 `uploadScript` 帮助函数名带 script，实际请求打 `POST /api/stories/upload`（契约 §5），与 `POST /api/scripts/upload` 无关——删除不影响 e2e，journeys 零改动。

## 被否决的替代

- **(a) 保留现状 + 契约标注**（#91 选项 2）：零调用方的端点保留 = 路由自测续命 + 契约假面继续扩大，每轮架构走查都要重复甄别；scripts 上传面保留还意味着 multer 双接线常驻。
- **(b) 部分退役**（#91 选项 3）：三桶证据同质（全是零消费方 + 自引用续命），逐桶拍板只增加断代次数，无技术收益。

## 后果

- **契约**：`docs/api-contract.md` §6/§7/§8/§9/§10 已随三票加退役标注；**编号保留不重排**（§8 被 server 路由注释引用）。
- **saves 表**：fresh 安装不再创建（db/index.ts 建表清单回到 9 张）；存量库的 `saves` 是恒空死表——写入链断于 #59/#60，无数据损失风险，**不做迁移/DROP**（幂等 CREATE IF NOT EXISTS 机制下死表无害）。
- **multer 依赖保留**：stories 上传（POST /api/stories/upload）仍是 multer 接线，scripts 上传面退役只拆 scripts 侧接线。
- **测试基线**：server 820+1skip → 816+1skip、client 113 → 112（#94 记录）；training 49。三票合计 30 个文件次、+83/−1060。
- **文档**：叙述性文档 sweep（README / ONBOARDING-GUIDE / PROJECT-ANALYSIS）随本 ADR 同票落地；DEVELOPMENT-LOG / MIGRATION-PLAN / ADR 0001-0007 史实段落不改写，仅在直接引用退役面处补退役指针（#66/#68 先例）。

## 追加（2026-09-13，#97）

全量盘点（bridge 46 方法 + 契约现存全部 REST 端点逐个 grep 消费面）后按同一标准退役 **D 桶 scripts `:id` 链与桥接死包装**（#97）：GET/PUT/DELETE /api/scripts/:id 三端点 + scriptService（服务整体删除）+ `scripts` 建表语句与 file_path 迁移块（9→8 张表，存量死表不迁移）+ bridge 七方法（readScript / saveScript / saveScriptToLibrary / deleteScript / readStory / readStoryForRag / setImportFilePath——全零页面调用方、仅 bridge.test 自引用）+ unwrapContent 孤儿助手。GET /api/stories/:id/rag 端点保留（e2e dossier 直接消费）；GET /api/stories/:id 与 PUT /api/rooms/:id/settings（roomSetTurnWindow）虽零非自测消费方，但属拍板参考中的「stories/rooms 全家」活面，列 #97 存疑留档待拍板。测试基线：server 816+1skip → 811+1skip（77→76 文件）、client 112 → 106、training 49。

## 追加（2026-09-13，#98）

**E 桶 `rag_index` 死表退役**（#98）：全库零 SQL 读写（from/into/update/join 全 0）的早期遗留表——RAG 索引实际落盘 `RAG_DATA_DIR/<userId>/rag_index/` 文件目录，SQL 表与 #67 user_graphs、#92 saves、#97 scripts 同型；fresh 安装不再建表（8→7 张表），存量死表不迁移，同一取舍（文件目录与 client `ragIndex` bridge 等撞名活面不动）。
