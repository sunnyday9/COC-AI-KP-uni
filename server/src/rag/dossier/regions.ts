/**
 * 场景区域常量与文本归一化（极轻模块，**无 IO/无重依赖**）。
 *
 * 抽出理由同 `../modelGuard.ts` 与 `./sceneLookup.ts`：`coverageGaps.ts` 静态引入
 * `schema.js`（→ scriptContext → storyService → storyParsers → jsdom），而查询期的
 * 归属/装配只需要这里的两个常量和一个正则。凡是要用"场景区域"的轻模块都从这里取，
 * 别再从 coverageGaps 取（否则 jsdom/pdf-lib 会被拖进回合模块图——本仓库对冷启动敏感）。
 *
 * 单源：coverageGaps 改为 re-export 本文件，三处（覆盖度 / 归属 / 装配）不再各写一份。
 */

/** 场景原文区域：首锚点前的衔接语余量（与运行时查证工具同口径）。 */
export const SCENE_REGION_LEAD = 300
/** 场景原文区域：末锚点后的余量（覆盖"场景正文比誊抄出的锚点更长"的部分）。 */
export const SCENE_REGION_SPAN = 2_500

/** 去空白（含换行/全角空格）——誊抄匹配与重叠比对对排版不敏感。 */
export function normalizeText(s: string): string {
  return String(s ?? '').replace(/\s+/g, '')
}
