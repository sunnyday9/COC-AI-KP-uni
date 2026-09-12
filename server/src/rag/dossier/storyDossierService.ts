/**
 * Story dossier service — compatibility facade over the split dossier modules.
 *
 * 架构走查候选 2 拆分后的纯 re-export 门面，本文件不再持有实现：
 *  - `./dossierCore.js`：轻查询核——持久化（persist/load/peek/delete/list）、
 *    #55 质量门判定（dossierGateNotice）、场景块渲染与纯函数 lookups
 *    （buildSceneBlock / lexicalSearch / findScene / render* 文案）。
 *  - `./dossierGenerate.js`：重生成器——generateDossier / splitStorySections /
 *    stripCodeFence（静态引入 storyService/aiService/annex/prompts 重依赖链）。
 *
 * 既有消费方的导入路径在此保持不变（零破坏）。注意：静态 import 本门面 =
 * 连带生成器的重依赖链（jsdom/pdf-lib）；查询期轻消费方请直接（动态）import
 * `./dossierCore.js`，不要走门面。
 */
export {
  persist,
  deleteDossier,
  loadDossier,
  peekDossier,
  listDossiers,
  dossierGateNotice,
  listScenes,
  VERIFY_ORIGINAL_HINT,
  coverageHintLine,
  buildSceneBlock,
  renderSceneNotFound,
  renderLexicalMiss,
  renderSceneUncovered,
  findScene,
  lexicalSearch,
  type DossierListItem,
} from './dossierCore.js'
export {
  generateDossier,
  splitStorySections,
  stripCodeFence,
  type GenerateResult,
} from './dossierGenerate.js'
