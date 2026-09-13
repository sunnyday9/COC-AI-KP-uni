/** 通用骰子原语：rollD(sides) —— rule-engine 唯一依赖的随机源（COC 判定真源在 coc7Rules.ts） */

export function rollD(sides: number): number {
  return Math.floor(Math.random() * sides) + 1
}
