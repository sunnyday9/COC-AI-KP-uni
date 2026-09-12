/**
 * scripts/eval A/B harness 共享帮助函数单源（#64，架构扫描候选 8）。
 *
 * estTokens 此前三份（ab-compare / ab-reconstruct / ab-dossier-metrics）口径漂移
 * 会让跨报告 token 对比失效 → 收敛此单源；改公式 = 改接口，历史报告对比会静默失真。
 * 同名但有行为差异的副本（ab-compare 的 api/step/cleanup/sleep 排版、registerUser
 * 前缀等）保留在各脚本本地——不为抽取而统一行为。对照表见 issue #64。
 */
import { spawn } from 'node:child_process'

/**
 * token 估算单源（口径：CJK ≈0.9 tok/字，非 CJK ≈3.5 char/tok，四舍五入）。
 * 与被收编的三份本地副本公式逐值等价（对拍样本见 #64 验收记录）。
 */
export function estTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return Math.round(cjk * 0.9 + (s.length - cjk) / 3.5)
}

/** 从 LLM judge 输出里抠 JSON（首 `{` 到末 `}`）；解析失败返回 null。 */
export function parseJudgeJson(raw) {
  const s = String(raw ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * cleanup 依赖各脚本的模块级 children 数组 → 工厂注入。
 * 内层函数体与 ab-reconstruct / ab-dossier-metrics 的本地副本逐字节相同。
 */
export function createCleanup(children) {
  return async function cleanup() {
    for (const c of children) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
        else c.kill('SIGTERM')
      } catch { /* ignore */ }
    }
    await sleep(800)
  }
}
