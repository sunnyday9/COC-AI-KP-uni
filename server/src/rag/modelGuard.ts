/**
 * LLM 模型守卫（铁律 1）——独立成极轻模块，**不引入任何重依赖**。
 *
 * 为什么单独一份而不放在 `dossier/originalLookup.ts`：那个模块静态引入
 * storyService（→ jsdom/pdf-lib 解析链）与 storyDossierService，凡是要用守卫的
 * 查询期模块都会被拖着一起进模块图。本仓库对回合/索引路径的冷启动敏感
 * （roomService 走动态 import、ragService.index 动态 import indexOrchestration——
 * 曾实测 +1.1s），守卫只该是一行正则 + 一个错误类型。
 *
 * 唯一实现处：改动只在此文件（此前 originalLookup 与 annex 各写一份，措辞漂移）。
 */
import { BadRequestError } from '../utils/errors.js'

/** -pro 变体（mimo-v2.5-pro）：无视觉输入、上游 404，一律拒绝。 */
const PRO_MODEL_RX = /-pro\b|-pro$/i

/**
 * 校验模型名可用性并原样返回（缺省/空 = 走 settings，返回 undefined）。
 * 不接受 -pro 变体时抛 BadRequestError，调用方据此降级或直接失败。
 */
export function assertNonProModel(model: string | undefined, context = 'LLM 调用'): string | undefined {
  const m = String(model ?? '').trim()
  if (!m) return undefined
  if (PRO_MODEL_RX.test(m)) {
    throw new BadRequestError(`${context}不接受 -pro 模型（mimo-v2.5-pro 无视觉/上游 404）——当前 model=${m}`)
  }
  return m
}
