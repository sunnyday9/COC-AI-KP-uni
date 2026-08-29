/**
 * CharacterMutators — 角色卡变更工厂（架构评审候选 1 / D-34）。
 *
 * TurnCharacterMutators 的 15 个 sheet 变更语义（负值钳制、dailySanLoss 累加、
 * 疯狂状态写入、技能成长……）的**唯一实现**：单人路径（kp:turn 单卡）与房间
 * 路径（RoomService 多卡 + state_patch 广播）都从这里取，消灭两份逐字手写。
 * 世界级变更（场景/线索/结局）与变更通知由调用方经 deps 注入——单人路径
 * 不注入（worldDeltas 由 kpTurnService 收集，随 end 帧回传）。
 */
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import type { TurnCharacterMutators } from '../services/kpTurnService.js'

export type CharacterEnding = {
  outcome: string
  title: string
  summary: string
  epilogueOptions?: string[]
  keyFacts?: string[]
  keyTurnIds?: string[]
}

export interface CharacterMutatorDeps {
  /** 目标角色卡解析（characterId 已由 runKpTurn 归属校验解析；无卡 → 变更跳过）。 */
  resolveSheet: (characterId: string | null) => COCCharacterSheet | null
  /** 变更后通知（房间路径 emit state_patch；单人路径可省略）。 */
  onSheetMutated?: (characterId: string | null, sheet: COCCharacterSheet) => void
  /** 世界级变更（房间路径接 RoomService；单人路径可省略）。 */
  transitionToScene?: (sceneName: string) => void
  addClue?: (description: string, clueId?: string) => void
  endGame?: (ending: CharacterEnding) => void
}

/**
 * 构造按 characterId 分派的变更应用器工厂。
 * 返回值即 runKpTurn 的 `mutatorFactory`——同一工厂既服务单卡路径
 * （characterId 恒为行动者）也服务多卡路径（D5 按 args.characterId 分派）。
 */
export function createCharacterMutatorFactory(
  deps: CharacterMutatorDeps,
): (characterId: string | null) => TurnCharacterMutators {
  const { resolveSheet, onSheetMutated } = deps
  return (characterId: string | null): TurnCharacterMutators => {
    const mutate = (fn: (sheet: COCCharacterSheet) => void): void => {
      const sheet = resolveSheet(characterId)
      if (!sheet) return
      fn(sheet)
      onSheetMutated?.(characterId, sheet)
    }
    return {
      updateCharacterHP: (delta) => mutate((s) => { if (s.derived) s.derived.hp = Math.max(0, (s.derived.hp ?? 0) + delta) }),
      updateCharacterMP: (delta) => mutate((s) => { if (s.derived) s.derived.mp = Math.max(0, (s.derived.mp ?? 0) + delta) }),
      updateCharacterSAN: (delta) => mutate((s) => { if (s.derived) s.derived.san = Math.max(0, (s.derived.san ?? 0) + delta) }),
      updateCharacterLuck: (delta) => mutate((s) => { if (s.attributes) s.attributes.luck = Math.max(0, (s.attributes.luck ?? 0) + delta) }),
      addCharacterDailySanLoss: (amount) => mutate((s) => { s.dailySanLoss = (s.dailySanLoss ?? 0) + amount }),
      resetCharacterDailySanLoss: () => mutate((s) => { s.dailySanLoss = 0 }),
      updateCharacterInsanityState: (state, phobias?, manias?) =>
        mutate((s) => {
          s.insanityState = state
          if (phobias) s.phobias = phobias
          if (manias) s.manias = manias
        }),
      setCharacterMajorWound: (v) => mutate((s) => { s.hasMajorWound = v }),
      setCharacterDying: (v) => mutate((s) => { s.isDying = v }),
      growCharacterSkill: (skillId, newValue) => mutate((s) => { if (s.skills) s.skills[skillId] = newValue }),
      increaseCthulhuMythos: (gain) => mutate((s) => { s.cthulhuMythos = (s.cthulhuMythos ?? 0) + gain }),
      transitionToScene: (sceneName) => { deps.transitionToScene?.(sceneName) },
      addClue: (description, clueId) => { deps.addClue?.(description, clueId) },
      endGame: (ending) => { deps.endGame?.(ending) },
      generateId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    }
  }
}
