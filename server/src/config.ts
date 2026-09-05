import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

/** HTTP listen port (default 3000) */
export const PORT = Number(process.env.PORT ?? 3000)

/** JWT signing secret — MUST be overridden in production (see .env.example) */
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

/**
 * Runtime data directory (SQLite db lives here); created automatically on
 * first use. `DATA_DIR` env overrides the default (used by tests to isolate
 * their database into a temp dir).
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(fileURLToPath(new URL('../data', import.meta.url)))

/**
 * RAG persistence root (Task 4): per-user RAG data lives under
 * `RAG_DATA_DIR/<userId>/` (rag_index / graph_index / ...), mirroring the
 * original `userData/rag_index` + `userData/graph_index` layout with the
 * user dimension added (task-4-brief decision 1). `RAG_DATA_DIR` env
 * overrides the default (tests isolate per-worker into a temp dir).
 */
export const RAG_DATA_DIR = process.env.RAG_DATA_DIR
  ? path.resolve(process.env.RAG_DATA_DIR)
  : path.resolve(fileURLToPath(new URL('../data/rag', import.meta.url)))

/**
 * Local embedding model cache (task-4-brief decision 2): @huggingface/
 * transformers downloads the builtin model here on first use.
 */
export const MODELS_DIR = process.env.MODELS_DIR
  ? path.resolve(process.env.MODELS_DIR)
  : path.resolve(fileURLToPath(new URL('../data/models', import.meta.url)))

/**
 * OCR language data (task-4-brief decision 4/5): chi_sim + eng traineddata
 * copied into `server/assets/tesseract/`; pointed to by tesseract.js via
 * `langPath`. The build script copies `server/assets` into `dist/server/assets`
 * so the relative URL resolution works in dev (tsx) and prod (dist) alike.
 */
export const TESSERACT_DATA_DIR = process.env.TESSERACT_DATA_DIR
  ? path.resolve(process.env.TESSERACT_DATA_DIR)
  : path.resolve(fileURLToPath(new URL('../assets/tesseract', import.meta.url)))

/**
 * Uploaded-file root (task-5-brief decision 2): per-user story/script files
 * live under `UPLOADS_DIR/<userId>/stories|scripts/`. `UPLOADS_DIR` env
 * overrides the default (tests point it at a per-worker temp dir).
 */
export const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(fileURLToPath(new URL('../uploads', import.meta.url)))

/**
 * Max upload size in bytes (api-contract §10: stories/scripts uploads ≤ 50MB;
 * the original Electron dialog had no limit but parsePdfWithOcr defends at
 * 50MB too). Enforced by the multer `limits.fileSize` option. `MAX_UPLOAD_BYTES`
 * env overrides (tests mock this constant to exercise the limit without
 * allocating 50MB buffers).
 */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024)

/**
 * MOCK_AI mode (Task 11, Phase 10): when `MOCK_AI=1` every AI/LLM call is
 * replaced by a deterministic in-process script (see `services/mockAi.ts`) —
 * no API key, no outbound requests, no local model downloads — so the full
 * COC flow (settings → import → index → character → game → tool calls →
 * save/load) can run end-to-end without any external AI service.
 *
 * Implemented as a function (not a constant) so server unit tests can stub
 * `process.env.MOCK_AI` per case via `vi.stubEnv`. The non-mock path never
 * reads this value, so behavior is bit-identical when the env var is unset.
 */
export function isMockAiMode(): boolean {
  return process.env.MOCK_AI === '1'
}

/**
 * KP 回合 wire 采样（T1，spec #36 / ADR-0006「唯一新缝」）：默认开启——每个真实
 * KP 回合把完整 wire 消息序列（assistant tool_calls / 工具结果回填 / RAG 注入 /
 * 最终叙事）落库为 SFT 训练素材。`KP_WIRE_SAMPLING=0` 关闭（关闭时零额外写入）。
 * 实现为函数（同 isMockAiMode），测试可 vi.stubEnv 按用例切换。
 */
export function isKpWireSamplingEnabled(): boolean {
  return process.env.KP_WIRE_SAMPLING !== '0'
}
