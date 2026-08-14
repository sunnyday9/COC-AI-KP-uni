/** COC / D&D 骰子服务 */

export type RuleSystem = 'coc' | 'dnd'

export function rollD100(): number {
  return Math.floor(Math.random() * 100) + 1
}

export function rollD20(): number {
  return Math.floor(Math.random() * 20) + 1
}

export function rollD(sides: number): number {
  return Math.floor(Math.random() * sides) + 1
}

/** COC d100 判定结果 */
export function cocResult(roll: number, target: number): 'critical' | 'success' | 'fail' | 'fumble' {
  if (roll <= 1) return 'critical'
  if (roll >= 96) return 'fumble'
  if (roll <= target) return 'success'
  return 'fail'
}

/** COC 结果文本 */
export function cocResultText(outcome: 'critical' | 'success' | 'fail' | 'fumble'): string {
  const map: Record<string, string> = {
    critical: '大成功',
    success: '成功',
    fail: '失败',
    fumble: '大失败',
  }
  return map[outcome] ?? outcome
}

/** D&D d20 判定（简单 DC 对比） */
export function dndResult(roll: number, dc: number, _advantage?: boolean): boolean {
  return roll >= dc
}
