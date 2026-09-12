/**
 * 注入小节标记单源（issue #63）——server 注入端与评测脚本嗅探端之间的**显式接口**。
 *
 * 这些字符串出现在发给 LLM 的 system / tool 消息里，`scripts/eval/ab-compare.mjs`
 * 等评测脚本按它们在 wire 采样里嗅探注入块（#42 gate 报告的数据源）。改任何一个
 * 值 = 改接口：评测统计会**静默归零**，历史 wire 数据 / 基线失去可比性。因此：
 *  - 值一经发布即冻结（值稳定重构）；要改必须连评测脚本与既有基线口径一起评审；
 *  - 全 repo 只允许本文件出现这些标记字面量（spec 的钉值断言除外）；
 *  - 本模块保持**零依赖叶子**——ab-compare.mjs 直接 import 本文件
 *    （Node ≥23.6 type stripping，先例 ab-verify-runtime.mjs）。
 */

/** 查证预取小节标题（P27，注入 dossier 房 system，对玩家不可见）。 */
export const VERIFY_SECTION_HEADING = '## 原文查证（服务端已自动检索，供你对齐事实）'

/** verify_original 工具回填内容的标记前缀（wire 的 tool 消息以其开头识别查证结果；
 *  场景名以 `·` 附于其后、以 `】` 收尾）。 */
export const VERIFY_CONTENT_MARKER = '【原文查证'

/** 剧透层查证结果的标注前缀（kp_only 专用，置于 VERIFY_CONTENT_MARKER 之前）。 */
export const VERIFY_SPOILER_MARKER = '【剧透层·仅限 KP 内部裁定，禁止向玩家复述】'

/** 检索补充小节标题（M1-T8 / ADR-0007；supplementAssembly 转出以保持原 import 面）。 */
export const SUPPLEMENT_HEADING = '## 原文片段（检索补充·仅作描写素材）'
