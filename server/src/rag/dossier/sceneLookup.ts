/**
 * 场景查找（纯函数）——从 `storyDossierService` 抽出的轻模块。
 *
 * 抽出理由同 `../modelGuard.ts`：`storyDossierService` 静态引入 storyService
 * （→ jsdom/pdf-lib 解析链）与 aiService，凡是要做场景名/ id 归一化的查询期模块
 * （检索补充层装配、query 构造）都会被拖着进模块图。本模块只依赖类型，无 IO。
 */
import type { StoryDossier, DossierScene } from './schema.js'

/** Case-insensitive scene lookup by id/name/exact/contains (longest match wins). */
export function findScene(dossier: StoryDossier, nameOrId: string): DossierScene | null {
  const target = String(nameOrId || '').trim().toLowerCase()
  if (!target) return null
  const scenes = dossier?.scenes || []
  for (const s of scenes) {
    if (s.id.toLowerCase() === target || s.name.toLowerCase() === target) return s
  }
  let best: DossierScene | null = null
  let bestLen = 0
  for (const s of scenes) {
    const name = s.name.toLowerCase()
    if (name && target.includes(name) && name.length > bestLen) {
      best = s
      bestLen = name.length
    }
  }
  return best
}
