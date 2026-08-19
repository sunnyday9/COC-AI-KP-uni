/**
 * Placeholder for环境伤害与坠落/火焰/溺水/毒素等规则。
 *
 * TODO:
 * - 根据规则书 Table III 等实现环境伤害计算：
 *   - 坠落：不同地面类型与高度对应 1D3 / 1D6 / 1D10 等。
 *   - 火焰：按轮数造成 1D6 / 1D10 等持续伤害。
 *   - 溺水/窒息：每轮 CON 检定失败造成 1D6 伤害。
 *   - 毒素：按毒性等级造成 1D10 / 2D10 / 4D10 等。
 *
 * 当前仅作为未来实现的集中入口，便于 TDD 与 handler 复用。
 */

export type EnvironmentDamageKind = 'fall' | 'fire' | 'drowning' | 'poison'

export interface EnvironmentDamageInput {
  kind: EnvironmentDamageKind
  /** 例如坠落高度（ft）或暴露轮数、毒性等级等，具体语义由 kind 决定。 */
  severity: number
}

export interface EnvironmentDamageResult {
  damageExpr: string
}

export function computeEnvironmentDamage(_input: EnvironmentDamageInput): EnvironmentDamageResult {
  // Not implemented yet – see COC-KP-GAP-ANALYSIS.md 中环境伤害部分。
  return { damageExpr: '0' }
}
