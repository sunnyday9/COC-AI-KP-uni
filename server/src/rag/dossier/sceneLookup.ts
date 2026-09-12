/**
 * 场景查找（纯函数）——从 `storyDossierService` 抽出的轻模块。
 *
 * 抽出理由同 `../modelGuard.ts`：`storyDossierService` 静态引入 storyService
 * （→ jsdom/pdf-lib 解析链）与 aiService，凡是要做场景名/ id 归一化的查询期模块
 * （检索补充层装配、query 构造）都会被拖着进模块图。本模块只依赖类型，无 IO。
 */
import type { StoryDossier, DossierScene } from './schema.js'

/** Case-insensitive scene lookup: exact (id/name) → forward contains (query ⊇
 *  scene name, longest name wins) → #56 reverse contains (scene name ⊇ query,
 *  only when the normalized query is ≥2 chars and the candidate is unique). */
export function findScene(dossier: StoryDossier, nameOrId: string): DossierScene | null {
  const target = String(nameOrId || '').trim().toLowerCase()
  if (!target) return null
  const scenes = dossier?.scenes || []
  // ① 精确（id/name，大小写不敏感）——先短路：精确命中不受反向歧义牵连。
  for (const s of scenes) {
    if (s.id.toLowerCase() === target || s.name.toLowerCase() === target) return s
  }
  // ② 正向包含（query ⊇ 场景名，最长场景名赢）。
  let best: DossierScene | null = null
  let bestLen = 0
  for (const s of scenes) {
    const name = s.name.toLowerCase()
    if (name && target.includes(name) && name.length > bestLen) {
      best = s
      bestLen = name.length
    }
  }
  if (best) return best
  // ③ 反向包含（#56：场景名 ⊇ query）——房间/查询给的短名（「图书馆」）是档案
  //    场景名（「市立图书馆旧馆」）的子串时也能归一。两道闸门同时满足才认：
  //    (a) query 归一化后 ≥2 字符（单字 CJK 指称噪声太大）；
  //    (b) 候选场景**恰好 1 个**——歧义即不认，短名指向多个场景时不是好指称，
  //        宁可 miss 让上层走 renderSceneUncovered/renderSceneNotFound 纠正，
  //        好过把别的场景档案当眼前现实注入（比未覆盖更糟）。
  //    精确已在 ① 短路，故这里的候选都是场景名的严格超串；反向只对 name 做，
  //    不碰 id（id 是不透明标识，query 是某 id 的子串不算命中）。
  if (target.length >= 2) {
    const hits = scenes.filter((s) => {
      const name = s.name.toLowerCase()
      return name && name.includes(target)
    })
    if (hits.length === 1) return hits[0]!
  }
  // ④ 都不中 → null（回落语义零变化：#53「不顶别的场景」原样保留）。
  return null
}
