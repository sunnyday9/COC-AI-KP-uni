import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message } from '../types/game'
import type { GamePhase, COCCharacterSheet } from '../types/character'
import type { StoryContext } from '../types/storyContext'
import { getContext, addUserGraphEvent, syncUserGraphFromState, getUserGraphSummary } from '../services/ragService'
import {
  hasKpAgent,
  runDirectChat as runDirectChatService,
} from '../services/kpSessionService'
import {
  resolveSkillCheck as resolveSkillCheckRule,
  SUCCESS_LEVEL_RANK as SUCCESS_LEVEL_RANK_RULE,
  SKILL_CHECK_RESULT_TEXT as SKILL_CHECK_RESULT_TEXT_RULE,
} from '../../../shared/coc/coc7Rules'
import { rollD } from '../../../shared/coc/diceService'
import { getSkillName } from '../../../shared/coc/coc7'
import { useSettingsStore } from './settingsStore'
import { runKpTurn as runKpTurnService } from '../services/kpSessionService'
import { summarizeLongTerm } from '../services/memoryService'
import { extractMemoryPoints } from '../services/memoryExtractService'
import { buildOpeningPrompt, buildTurnPrompt, buildCharacterContext as buildCharacterContextPrompt, buildMemoryBlock, buildRecentTurnsBlock, MAX_MEMORY_ENTRIES, type PromptState } from '../services/kpPromptService'
import { SAVE_VERSION, writeSaveSnapshot, readSaveSnapshot, listSaveIds, readSaveMeta } from '../services/saveService'
import { traceBus } from '../services/tracing'
import type { CharacterSnapshot, TraceEventMap, TraceEventType } from '../services/tracing'
import type { EndingState, GameOutcome } from '../types/ending'

function generateId(): string {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9)
}

/** Run long-term summarization every N player turns. */
const LONG_TERM_SUMMARY_EVERY_N_TURNS = 5
/** Number of recent messages to include in long-term summarization input. */
const SUMMARIZE_RECENT_MESSAGES = 20

/**
 * Adaptive summarization interval (perf: long conversations degrade because
 * the tool-chain history re-sent each turn grows without bound). Shorten the
 * interval as the turn count grows so the long-term summary stays fresh:
 *   < 20 turns → every 5; ≥ 20 → every 3; ≥ 40 → every 2.
 */
export function dynamicSummaryInterval(playerTurnCount: number): number {
  if (playerTurnCount >= 40) return 2
  if (playerTurnCount >= 20) return 3
  return LONG_TERM_SUMMARY_EVERY_N_TURNS
}

type SummarizationTrigger = 'scene_change' | 'periodic' | 'high_impact_tool'

const HIGH_IMPACT_TOOLS = new Set(['grant_clue', 'melee_attack', 'ranged_attack', 'san_check', 'trigger_insanity'])

function sanitizeKpResponse(content: string): string {
  if (!content?.trim()) return content
  const leakedPatterns = [
    /^\[意图提示\].*$/gm,
    /^\[工具说明\].*$/gm,
    /^\[避免重复\].*$/gm,
    /^## 内部指引（仅你可见.*$/gm,
    /^【重要】回复中只输出.*$/gm,
    /^- 意图：.*$/gm,
    /^- 工具：.*$/gm,
    /^- 避免重复：.*$/gm,
  ]
  let out = content
  for (const p of leakedPatterns) {
    out = out.replace(p, '')
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export const useGameStore = defineStore('game', () => {
  const sessionId = ref<string | null>(null)
  /** ID of the indexed story in the vector store */
  const storyId = ref<string | null>(null)
  /** Display name of the story */
  const storyName = ref<string>('')
  /** Story overview fetched from RAG on game start */
  const storyOverview = ref<string>('')
  /** Current scene name (narrative tracking, not script-enforced) */
  const currentScene = ref<string>('')
  /** Clues the investigator has obtained. Structured since the script-gating
   * work: { id, description }; legacy saves restored plain strings, which
   * `toClueId`/`toClueDescription` normalize on the fly. */
  const cluesObtained = ref<{ id: string; description: string }[]>([])
  const messages = ref<Message[]>([])
  const kpMemory = ref<string[]>([])
  /** Long-term session summary (key events, scenes, clues); updated on scene change / periodically. */
  const longTermSummary = ref<string>('')
  /** Optional discrete facts (e.g. clues learned) for long-term context. */
  const longTermFacts = ref<string[]>([])
  /** Number of player messages sent this session (for periodic long-term summarization). */
  const playerTurnCount = ref(0)
  const isInGame = ref(false)
  const isSending = ref(false)
  const playerName = ref('调查员')

  const gamePhase = ref<GamePhase>('story_selected')
  const endingState = ref<EndingState | null>(null)
  const scenesVisited = ref<string[]>([])
  const narrativeStall = ref(0)
  const characterSheet = ref<COCCharacterSheet | null>(null)
  const derivedStatsVersion = ref(0)
  const selectedOccupationId = ref<string | null>(null)
  const selectedOccupationName = ref<string>('')

  function toPromptState(): PromptState {
    return {
      storyName: storyName.value,
      currentScene: currentScene.value,
      cluesObtained: cluesObtained.value,
      messages: messages.value,
      kpMemory: kpMemory.value,
      longTermSummary: longTermSummary.value,
      playerName: playerName.value,
      characterSheet: characterSheet.value,
    }
  }

  function reset() {
    sessionId.value = null
    storyId.value = null
    storyName.value = ''
    storyOverview.value = ''
    currentScene.value = ''
    cluesObtained.value = []
    messages.value = []
    kpMemory.value = []
    longTermSummary.value = ''
    longTermFacts.value = []
    playerTurnCount.value = 0
    endingState.value = null
    scenesVisited.value = []
    narrativeStall.value = 0
    isInGame.value = false
    isSending.value = false
    gamePhase.value = 'story_selected'
    characterSheet.value = null
    selectedOccupationId.value = null
    selectedOccupationName.value = ''
  }

  function setOccupation(occupationId: string, occupationName: string) {
    selectedOccupationId.value = occupationId
    selectedOccupationName.value = occupationName
    gamePhase.value = 'occupation_selected'
  }

  /** Start a game with an indexed story. */
  async function startGame(opts: { storyId: string; storyName?: string; name?: string }) {
    reset()
    storyId.value = opts.storyId
    storyName.value = opts.storyName || opts.storyId
    sessionId.value = 'sess_' + Date.now()
    if (opts.name) playerName.value = opts.name
    // Anti-spoiler: do not preload a full-story "overview" into prompts.
    // Opening context will be retrieved dynamically by RAG per scene/turn.
    storyOverview.value = ''
    gamePhase.value = 'story_selected'
  }

  function setPhase(phase: GamePhase) {
    gamePhase.value = phase
  }

  function setCharacterSheet(sheet: COCCharacterSheet | null) {
    characterSheet.value = sheet
    if (sheet) playerName.value = sheet.playerName
  }

  function confirmCharacterAndEnterGame() {
    if (!characterSheet.value) return
    gamePhase.value = 'playing'
    isInGame.value = true
  }

  function addMessage(msg: Message) {
    messages.value.push(msg)
  }

  function insertMessagesBeforeLast(msgs: Message[]) {
    if (msgs.length === 0) return
    const last = messages.value.pop()
    for (const m of msgs) messages.value.push(m)
    if (last) messages.value.push(last)
  }

  function buildCharacterSnapshotForTrace(): CharacterSnapshot | null {
    const c = characterSheet.value
    if (!c?.derived) return null
    return {
      hp: c.derived.hp, hpMax: c.derived.hpMax,
      mp: c.derived.mp, mpMax: c.derived.mpMax,
      san: c.derived.san, sanMax: c.derived.sanMax,
      luck: c.attributes?.luck ?? 0,
      insanityState: c.insanityState ?? 'normal',
      hasMajorWound: c.hasMajorWound ?? false,
      isDying: c.isDying ?? false,
      dailySanLoss: c.dailySanLoss ?? 0,
    }
  }

  function emitCharacterSnapshot(label: string) {
    const snap = buildCharacterSnapshotForTrace()
    // label 附加字段为原代码透传（TraceEventMap 类型未含 label，类型层面放宽，运行时不变）
    if (snap) traceBus.emit('state_update', 'character_snapshot', { ...snap, label } as CharacterSnapshot)
  }

  function addClue(description: string, clueId?: string) {
    const exists = cluesObtained.value.some((c) => c.description === description || (clueId && c.id === clueId))
    if (!exists) cluesObtained.value.push({ id: clueId ?? '', description })
    traceBus.emit('state_update', 'clue_added', { description, clueId })
    if (storyId.value && sessionId.value) {
      addUserGraphEvent({
        storyId: storyId.value,
        sessionId: sessionId.value,
        event: { type: 'clue', name: description },
      }).catch(() => {})
    }
  }

  function transitionToScene(sceneName: string) {
    const from = currentScene.value
    currentScene.value = sceneName
    if (sceneName && scenesVisited.value[scenesVisited.value.length - 1] !== sceneName) {
      scenesVisited.value.push(sceneName)
    }
    traceBus.emit('state_update', 'scene_changed', { from, to: sceneName })
    if (storyId.value && sessionId.value) {
      addUserGraphEvent({
        storyId: storyId.value,
        sessionId: sessionId.value,
        event: { type: 'scene', name: sceneName },
      }).catch(() => {})
    }
    runLongTermSummarization('scene_change')
  }

  function endGame(payload: {
    outcome: GameOutcome
    title: string
    summary: string
    epilogueOptions?: string[]
    keyFacts?: string[]
    keyTurnIds?: string[]
  }) {
    if (gamePhase.value === 'ended') return
    const snap = buildCharacterSnapshotForTrace()
    endingState.value = {
      outcome: payload.outcome,
      title: payload.title,
      summary: payload.summary,
      epilogueOptions: payload.epilogueOptions ?? [],
      keyFacts: payload.keyFacts ?? [],
      keyTurnIds: payload.keyTurnIds ?? [],
      endedAt: Date.now(),
      finalSnapshot: snap ? {
        hp: snap.hp, hpMax: snap.hpMax,
        san: snap.san, sanMax: snap.sanMax,
        mp: snap.mp, mpMax: snap.mpMax,
        luck: snap.luck,
        insanityState: snap.insanityState,
        dailySanLoss: snap.dailySanLoss,
      } : undefined,
      cluesObtained: [...cluesObtained.value],
      scenesVisited: [...scenesVisited.value],
      storyId: storyId.value ?? undefined,
      storyName: storyName.value || undefined,
      sessionId: sessionId.value ?? undefined,
    }
    gamePhase.value = 'ended'
    // game_ended 事件类型在原 TraceEventMap 中缺失（原代码类型错误，类型层面放宽，运行时不变）
    traceBus.emit('state_update', 'game_ended' as unknown as TraceEventType, {
      outcome: payload.outcome,
      title: payload.title,
      summaryLength: payload.summary.length,
      clues: cluesObtained.value.length,
      scenes: scenesVisited.value.length,
    } as unknown as TraceEventMap[keyof TraceEventMap])
  }

  let _summarizationGen = 0
  let _summarizationPending = false

  function runLongTermSummarization(trigger?: SummarizationTrigger) {
    if (_summarizationPending) return
    _summarizationPending = true
    const gen = ++_summarizationGen
    const settingsStore = useSettingsStore()
    const aiConfig = settingsStore.aiConfig
    if (!aiConfig?.model) { _summarizationPending = false; return }
    const recent = messages.value
      .filter((m): m is Message => m.role === 'player' || m.role === 'kp')
      .slice(-SUMMARIZE_RECENT_MESSAGES)
    const recentText = recent
      .map((m) => (m.role === 'player' ? `玩家: ${'content' in m ? m.content : ''}` : `守密人: ${'content' in m ? m.content : ''}`))
      .join('\n')
    if (!recentText.trim()) return
    const current = longTermSummary.value
    const sc = buildStoryContext()
    const storyContextText = sc
      ? [
          sc.sceneName ? `场景: ${sc.sceneName}` : '',
          sc.act ? `幕次/阶段: ${sc.act}` : '',
          sc.sanity?.currentSan != null ? `SAN: ${sc.sanity.currentSan}` : '',
          sc.sanity?.dailySanLoss != null ? `当日SAN损失: ${sc.sanity.dailySanLoss}` : '',
          cluesObtained.value.length ? `已获得线索: ${cluesObtained.value.slice(0, 12).map((c) => c.description).join('；')}` : '',
        ].filter(Boolean).join('\n')
      : ''
    const sid = storyId.value
    const sessId = sessionId.value
    const clueKeywords = cluesObtained.value.slice(0, 5).map((c) => c.description.slice(0, 15)).join(' ')
    const ragQuery = [currentScene.value, clueKeywords].filter(Boolean).join(' ') || '当前场景'
    const triggerType = trigger || (currentScene.value !== '' ? 'scene_change' : 'periodic')
    // 原 TraceEventMap 的 trigger 仅含 scene_change|periodic，high_impact_tool 属原类型缺口（运行时不变）
    traceBus.emit('long_term_summary', 'summary_triggered', { trigger: triggerType as 'scene_change' | 'periodic', playerTurnCount: playerTurnCount.value })
    Promise.all([
      sid ? getContext({ query: ragQuery, scriptId: sid, sceneId: currentScene.value || undefined, topK: 5 }) : Promise.resolve({ context: '' }),
      sid && sessId ? getUserGraphSummary(sid, sessId) : Promise.resolve(''),
    ])
      .then(([ctxRes, userGraphSummary]) => {
        const ragContextText = ctxRes?.context || ''
        traceBus.emit('long_term_summary', 'summary_input', {
          recentMessagesLength: recentText.length,
          currentSummaryLength: current.length,
          ragContextLength: ragContextText.length,
          userGraphLength: (userGraphSummary || '').length,
        })
        return summarizeLongTerm(aiConfig, {
          recentMessagesText: recentText,
          currentSummary: current,
          storyContextText,
          ragContextText,
          userGraphSummary: userGraphSummary || '',
        })
      })
      .then((next) => {
        if (next && gen === _summarizationGen) {
          if (current && next.length < Math.floor(current.length * 0.85)) return
          longTermSummary.value = next
          traceBus.emit('long_term_summary', 'summary_output', {
            newSummaryLength: next.length,
            newSummaryPreview: next.slice(0, 200),
          })
        }
      })
      .catch(() => { /* fire-and-forget */ })
      .finally(() => { _summarizationPending = false })
  }

  function updateCharacterHP(delta: number) {
    const c = characterSheet.value
    if (!c?.derived) return
    const newHp = Math.max(0, Math.min(c.derived.hpMax, c.derived.hp + delta))
    characterSheet.value = { ...c, derived: { ...c.derived, hp: newHp } }
    derivedStatsVersion.value += 1
    if (newHp <= 0) {
      endGame({
        outcome: 'defeat',
        title: '调查员死亡',
        summary: '调查员的生命在黑暗中熄灭。故事以死亡收场，所有未解之谜将继续沉入阴影。',
        keyFacts: [],
        epilogueOptions: ['开始新游戏', '回看对话与结局报告'],
      })
    }
  }

  function updateCharacterMP(delta: number) {
    const c = characterSheet.value
    if (!c?.derived) return
    const newMp = Math.max(0, Math.min(c.derived.mpMax, c.derived.mp + delta))
    characterSheet.value = { ...c, derived: { ...c.derived, mp: newMp } }
    derivedStatsVersion.value += 1
  }

  function updateCharacterSAN(delta: number) {
    const c = characterSheet.value
    if (!c?.derived) return
    const newSan = Math.max(0, Math.min(c.derived.sanMax, c.derived.san + delta))
    characterSheet.value = { ...c, derived: { ...c.derived, san: newSan } }
    derivedStatsVersion.value += 1
    if (newSan <= 0) {
      // Keep insanityState consistent before the ending snapshot is built
      // (previously only endGame ran, leaving insanityState 'normal').
      updateCharacterInsanityState('permanent')
      endGame({
        outcome: 'defeat',
        title: '永久疯狂',
        summary: '理智彻底崩塌。调查员被不可名状的真相吞噬，世界在扭曲的回声中远去。',
        keyFacts: [],
        epilogueOptions: ['开始新游戏', '回看对话与结局报告'],
      })
    }
  }

  function updateCharacterSkill(skillId: string, newValue: number) {
    const c = characterSheet.value
    if (!c?.skills) return
    const nextSkills = { ...c.skills, [skillId]: Math.max(0, Math.min(99, newValue)) }
    characterSheet.value = { ...c, skills: nextSkills }
  }

  /** 幕间成长专用：技能可超过 100%（规则书 5739-5742），仅下限 0。 */
  function growCharacterSkill(skillId: string, newValue: number) {
    const c = characterSheet.value
    if (!c?.skills) return
    const nextSkills = { ...c.skills, [skillId]: Math.max(0, newValue) }
    characterSheet.value = { ...c, skills: nextSkills }
  }

  /** 克苏鲁神话技能增长（书籍阅读/神话遭遇）；同时触发最大理智下调（99 - mythos）。 */
  function increaseCthulhuMythos(gain: number) {
    const c = characterSheet.value
    if (!c || gain <= 0) return
    const current = typeof c.cthulhuMythos === 'number' ? c.cthulhuMythos : 0
    const next = Math.min(99, current + Math.floor(gain))
    characterSheet.value = { ...c, cthulhuMythos: next }
    derivedStatsVersion.value += 1
  }

  function updateCharacterLuck(delta: number) {
    const c = characterSheet.value
    if (!c?.attributes) return
    const newLuck = Math.max(0, Math.min(99, c.attributes.luck + delta))
    characterSheet.value = { ...c, attributes: { ...c.attributes, luck: newLuck } }
    derivedStatsVersion.value += 1
  }

  /** P0 疯狂：当日累计 SAN 损失（san_check 后调用） */
  function addCharacterDailySanLoss(amount: number) {
    const c = characterSheet.value
    if (!c) return
    const prev = c.dailySanLoss ?? 0
    characterSheet.value = { ...c, dailySanLoss: prev + amount }
    derivedStatsVersion.value += 1
  }

  /** P0 疯狂：重置当日 SAN 损失（新一天时由 KP 或规则触发） */
  function resetCharacterDailySanLoss() {
    const c = characterSheet.value
    if (!c) return
    characterSheet.value = { ...c, dailySanLoss: 0 }
    derivedStatsVersion.value += 1
  }

  /** P0 疯狂：设置疯狂状态、恐惧症、躁狂症 */
  function updateCharacterInsanityState(state: 'normal' | 'temporary' | 'indefinite' | 'permanent', phobias?: string[], manias?: string[]) {
    const c = characterSheet.value
    if (!c) return
    const next: Record<string, unknown> = { ...c, insanityState: state }
    if (phobias !== undefined) next.phobias = phobias
    if (manias !== undefined) next.manias = manias
    characterSheet.value = next as typeof c
    derivedStatsVersion.value += 1
  }

  /** P0 战斗：设置重伤与濒死 */
  function setCharacterMajorWound(hasMajorWound: boolean) {
    const c = characterSheet.value
    if (!c) return
    characterSheet.value = { ...c, hasMajorWound }
    derivedStatsVersion.value += 1
  }

  function setCharacterDying(isDying: boolean) {
    const c = characterSheet.value
    if (!c) return
    characterSheet.value = { ...c, isDying }
    derivedStatsVersion.value += 1
  }

  function updateLastMessage(updater: (m: Message) => void) {
    const last = messages.value[messages.value.length - 1]
    if (last) updater(last)
  }

  function buildCharacterContext(): string {
    // 原代码局部函数遮蔽同名导入（若被调用将无限递归，且 tsc 报错）——
    // 迁移时重命名导入绑定（buildCharacterContextPrompt），运行时行为不变
    return buildCharacterContextPrompt(toPromptState())
  }

  let _turnHadHighImpactTool = false

  /**
   * Phase A2: 工具由服务端执行（rule-engine）。这里只做两件事：
   * 1) 把工具执行结果上报到玩家行动图（user graph）；
   * 2) 高影响工具标记（用于长程摘要触发）。
   * 展示消息（骰子/系统提示）已由 runKpTurn 的 onDisplayMessages 回调插入。
   */
  function recordToolExecution(toolCalls: { id: string; name: string; arguments: string }[]): void {
    if (storyId.value && sessionId.value) {
      for (const tc of toolCalls) {
        try {
          const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
          if (tc.name === 'skill_check') {
            addUserGraphEvent({
              storyId: storyId.value,
              sessionId: sessionId.value,
              event: { type: 'action', name: `技能检定: ${String(args.skillName ?? '未知')}`, description: String(args.result ?? '') },
            }).catch(() => {})
          } else if (tc.name === 'san_check') {
            addUserGraphEvent({
              storyId: storyId.value,
              sessionId: sessionId.value,
              event: { type: 'action', name: 'SAN检定', description: String(args.sanLost ?? '') },
            }).catch(() => {})
          } else if (tc.name === 'melee_attack' || tc.name === 'ranged_attack') {
            addUserGraphEvent({
              storyId: storyId.value,
              sessionId: sessionId.value,
              event: { type: 'action', name: tc.name === 'melee_attack' ? '近战攻击' : '远程攻击', description: '' },
            }).catch(() => {})
          }
        } catch { /* ignore parse errors */ }
      }
    }
    if (toolCalls.some(tc => HIGH_IMPACT_TOOLS.has(tc.name))) {
      _turnHadHighImpactTool = true
    }
  }

  /** Phase A2: 服务端回合后把世界增量（线索/场景/结局）应用到本地。 */
  function applyServerWorldDeltas(deltas: { cluesAdded?: { description: string; clueId?: string }[]; sceneChanged?: string; ending?: unknown }): void {
    for (const clue of deltas.cluesAdded ?? []) {
      if (clue?.description) addClue(clue.description, clue.clueId)
    }
    if (deltas.sceneChanged) transitionToScene(deltas.sceneChanged)
    if (deltas.ending) {
      const e = deltas.ending as Record<string, unknown>
      endGame({
        outcome: (String(e.outcome ?? 'unknown') as GameOutcome),
        title: String(e.title ?? '结局'),
        summary: String(e.summary ?? ''),
        epilogueOptions: Array.isArray(e.epilogueOptions) ? (e.epilogueOptions as unknown[]).map(String) : [],
        keyFacts: Array.isArray(e.keyFacts) ? (e.keyFacts as unknown[]).map(String) : [],
        keyTurnIds: Array.isArray(e.keyTurnIds) ? (e.keyTurnIds as unknown[]).map(String) : [],
      })
    }
  }

  /** Phase A2: 服务端回合后把更新后的角色卡快照对账到本地。 */
  function applyServerCharacterSheet(sheet: unknown): void {
    if (!sheet || typeof sheet !== 'object') return
    const s = sheet as COCCharacterSheet
    if (!s.derived || typeof s.derived !== 'object') return
    const cur = characterSheet.value
    if (!cur) {
      characterSheet.value = s
      return
    }
    // 逐字段对账（服务端权威）：只覆盖服务端回传的字段，保留本地未回传部分
    if (typeof s.derived.hp === 'number') cur.derived.hp = s.derived.hp
    if (typeof s.derived.mp === 'number') cur.derived.mp = s.derived.mp
    if (typeof s.derived.san === 'number') cur.derived.san = s.derived.san
    if (typeof s.attributes?.luck === 'number') cur.attributes.luck = s.attributes.luck
    if (typeof s.dailySanLoss === 'number') cur.dailySanLoss = s.dailySanLoss
    if (s.insanityState) cur.insanityState = s.insanityState
    if (Array.isArray(s.phobias)) cur.phobias = s.phobias
    if (Array.isArray(s.manias)) cur.manias = s.manias
    if (typeof s.hasMajorWound === 'boolean') cur.hasMajorWound = s.hasMajorWound
    if (typeof s.isDying === 'boolean') cur.isDying = s.isDying
    if (typeof s.cthulhuMythos === 'number') cur.cthulhuMythos = s.cthulhuMythos
    if (s.skills && typeof s.skills === 'object') {
      for (const [k, v] of Object.entries(s.skills)) {
        if (typeof v === 'number') cur.skills[k] = v
      }
    }
    emitCharacterSnapshot('after_server_turn')
  }

  function buildStoryContext(): StoryContext | null {
    const scene = currentScene.value?.trim()
    const ctx: StoryContext = {}
    if (scene) {
      ctx.sceneId = scene
      ctx.sceneName = scene
      ctx.sceneType = 'investigation'
    }
    if (storyId.value) {
      ctx.scriptId = storyId.value
      ctx.openClues = cluesObtained.value.map((c) => ({ id: c.id, description: c.description }))
    }
    if (characterSheet.value) {
      const c = characterSheet.value
      const san = c.derived?.san
      const dailySanLoss = c.dailySanLoss ?? 0
      ctx.sanity = {
        currentSan: typeof san === 'number' ? san : undefined,
        dailySanLoss: dailySanLoss > 0 ? dailySanLoss : undefined,
      }
    }
    if (narrativeStall.value >= 4) {
      ctx.forceTransitionScene = true
    }
    if (Object.keys(ctx).length === 0) return null
    return ctx
  }

  async function fetchRagContext(query: string): Promise<string> {
    if (!storyId.value) return ''
    try {
      const [ctxRes, userSummary] = await Promise.all([
        getContext({
          query,
          scriptId: storyId.value,
          sceneId: currentScene.value?.trim() || undefined,
          topK: 8,
        }),
        sessionId.value ? getUserGraphSummary(storyId.value, sessionId.value) : Promise.resolve(''),
      ])
      let ctx = ctxRes?.context || ''
      const trimmedUserGraph = userSummary?.trim() ?? ''
      if (trimmedUserGraph) {
        ctx += (ctx ? '\n\n' : '') + '## 调查员行动记录\n' + trimmedUserGraph
        // user_graph_appended 事件类型在原 TraceEventMap 中缺失（原代码类型错误，类型层面放宽，运行时不变）
        traceBus.emit('rag_retrieval', 'user_graph_appended' as unknown as TraceEventType, {
          userGraphLength: trimmedUserGraph.length,
        } as unknown as TraceEventMap[keyof TraceEventMap])
      }
      return ctx
    } catch { return '' }
  }

  async function saveGame(saveId: string, displayName?: string): Promise<void> {
    await writeSaveSnapshot(saveId, displayName, {
      storyId: storyId.value,
      storyName: storyName.value,
      storyOverview: storyOverview.value,
      currentScene: currentScene.value,
      cluesObtained: cluesObtained.value,
      messages: messages.value,
      kpMemory: kpMemory.value,
      longTermSummary: longTermSummary.value,
      longTermFacts: longTermFacts.value,
      playerTurnCount: playerTurnCount.value,
      gamePhase: gamePhase.value,
      characterSheet: characterSheet.value,
      playerName: playerName.value,
      selectedOccupationId: selectedOccupationId.value,
      selectedOccupationName: selectedOccupationName.value,
      sessionId: sessionId.value,
      endingState: endingState.value,
      scenesVisited: scenesVisited.value,
    })
  }

  async function loadGame(saveId: string): Promise<void> {
    const data = await readSaveSnapshot(saveId)
    const v = data.version as number | undefined
    if (v !== SAVE_VERSION) {
      longTermSummary.value = ''
      longTermFacts.value = []
      playerTurnCount.value = 0
    }
    if (typeof data.storyId === 'string') storyId.value = data.storyId
    if (typeof data.storyName === 'string') storyName.value = data.storyName
    if (typeof data.storyOverview === 'string') storyOverview.value = data.storyOverview
    if (typeof data.currentScene === 'string') currentScene.value = data.currentScene
    if (Array.isArray(data.cluesObtained)) {
      cluesObtained.value = (data.cluesObtained as unknown[]).map((c) => {
        if (typeof c === 'string') return { id: '', description: c } // legacy save
        if (typeof c === 'object' && c !== null && typeof (c as { description?: unknown }).description === 'string') {
          return { id: typeof (c as { id?: unknown }).id === 'string' ? (c as { id: string }).id : '', description: (c as { description: string }).description }
        }
        return { id: '', description: String(c) }
      })
    }
    if (Array.isArray(data.messages)) messages.value = data.messages as Message[]
    if (Array.isArray(data.kpMemory)) kpMemory.value = data.kpMemory as string[]
    if (v === SAVE_VERSION) {
      if (typeof data.longTermSummary === 'string') longTermSummary.value = data.longTermSummary
      if (Array.isArray(data.longTermFacts)) longTermFacts.value = data.longTermFacts as string[]
      if (typeof data.playerTurnCount === 'number') playerTurnCount.value = data.playerTurnCount
    }
    if (typeof data.gamePhase === 'string') gamePhase.value = data.gamePhase as GamePhase
    if (data.characterSheet != null) characterSheet.value = data.characterSheet as COCCharacterSheet | null
    if (typeof data.playerName === 'string') playerName.value = data.playerName
    if (typeof data.selectedOccupationId === 'string') selectedOccupationId.value = data.selectedOccupationId
    if (typeof data.selectedOccupationName === 'string') selectedOccupationName.value = data.selectedOccupationName
    if (typeof data.sessionId === 'string') sessionId.value = data.sessionId
    if (Array.isArray(data.scenesVisited)) scenesVisited.value = data.scenesVisited as string[]
    if (data.endingState != null) endingState.value = data.endingState as EndingState
    isInGame.value = true
    if (storyId.value && sessionId.value) {
      syncUserGraphFromState({
        storyId: storyId.value,
        sessionId: sessionId.value,
        state: { cluesObtained: cluesObtained.value, currentScene: currentScene.value },
      }).catch(() => {})
    }  }

  async function listSaves(): Promise<string[]> {
    return await listSaveIds()
  }

  async function getSaveMeta(saveId: string): Promise<{ name?: string; storyName?: string } | null> {
    return await readSaveMeta(saveId)
  }

  async function requestOpening() {
    if (gamePhase.value !== 'playing' || !characterSheet.value || !storyId.value || messages.value.length > 0 || isSending.value) return
    isSending.value = true
    const turnId = 'opening_' + Date.now()
    traceBus.startTrace(turnId)
    emitCharacterSnapshot('before_opening')
    addMessage({ id: generateId(), timestamp: Date.now(), role: 'kp', content: '', isStreaming: true })
    try {
      const settingsStore = useSettingsStore()
      const aiConfig = settingsStore.aiConfig
      if (!aiConfig?.model) throw new Error('请先在设置中刷新模型列表并选择模型')

      const ragContext = await fetchRagContext('开场 故事背景 场景描述 第一幕')
      const { chatMessages } = buildOpeningPrompt(toPromptState(), ragContext)
      traceBus.emit('prompt_assembly', 'system_prompt_built', {
        totalLength: chatMessages.reduce((n, m) => n + m.content.length, 0),
        hasLongTermSummary: !!longTermSummary.value,
        longTermSummaryLength: longTermSummary.value.length,
        memoryEntries: kpMemory.value.length,
        ragContextLength: ragContext.length,
        conversationWindowSize: 0,
      })

      const fullContent = hasKpAgent()
        ? await runKpTurnService(chatMessages, buildStoryContext(), characterSheet.value, {
            onStreamChunk: (preview) => updateLastMessage((m) => { if (m.role === 'kp') m.content = sanitizeKpResponse(preview) }),
            onDisplayMessages: (msgs) => insertMessagesBeforeLast(msgs as Message[]),
            onCharacterSheetUpdate: (sheet) => applyServerCharacterSheet(sheet),
            onWorldDeltas: (deltas) => applyServerWorldDeltas(deltas),
          }).then((r) => {
            recordToolExecution(r.toolCalls)
            return r.content
          })
        : await runDirectChatService(chatMessages as { role: 'system' | 'user' | 'assistant'; content: string }[], aiConfig, {
            onStreamChunk: (c) => updateLastMessage((m) => { if (m.role === 'kp') m.content = sanitizeKpResponse(c) }),
          })

      if (fullContent.trim()) {
        const sanitized = sanitizeKpResponse(fullContent)
        kpMemory.value = [...kpMemory.value.slice(-(MAX_MEMORY_ENTRIES - 1)), sanitized.slice(0, 80) + '…']
        extractMemoryPoints(aiConfig, sanitized).then((points) => {
          const next = [...kpMemory.value.slice(0, -1), ...points]
          kpMemory.value = next.slice(-MAX_MEMORY_ENTRIES)
          traceBus.emit('state_update', 'memory_updated', {
            kpMemoryLength: kpMemory.value.length,
            newEntryPreview: points.join(' | ').slice(0, 150),
          })
        }).catch(() => { /* fallback already in place */ })
      }
      emitCharacterSnapshot('after_opening')
      updateLastMessage((m) => { if (m.role === 'kp') m.isStreaming = false })
    } catch (e) {
      traceBus.emit('kp_agent', 'trace_error', { source: 'requestOpening', message: e instanceof Error ? e.message : String(e) })
      updateLastMessage((m) => {
        if (m.role === 'kp') {
          m.content = '[开场生成失败: ' + (e instanceof Error ? e.message : String(e)) + ']'
          m.isStreaming = false
        }
      })
    } finally {
      traceBus.endTrace()
      isSending.value = false
    }
  }

  async function sendPlayerMessage(content: string) {
    if (!content.trim() || isSending.value) return
    _turnHadHighImpactTool = false
    let _turnHadProgressTool = false
    addMessage({ id: generateId(), timestamp: Date.now(), role: 'player', playerName: playerName.value, content: content.trim() })
    playerTurnCount.value += 1
    isSending.value = true
    const turnId = 'turn_' + playerTurnCount.value + '_' + Date.now()
    traceBus.startTrace(turnId)
    emitCharacterSnapshot('before_turn')
    addMessage({ id: generateId(), timestamp: Date.now(), role: 'kp', content: '', isStreaming: true })

    try {
      const settingsStore = useSettingsStore()
      const aiConfig = settingsStore.aiConfig
      if (!aiConfig?.model) throw new Error('请先在设置中刷新模型列表并选择模型')

      const ragContext = await fetchRagContext(content)
      const { chatMessages } = buildTurnPrompt(toPromptState(), ragContext)
      traceBus.emit('prompt_assembly', 'system_prompt_built', {
        totalLength: chatMessages.reduce((n, m) => n + m.content.length, 0),
        hasLongTermSummary: !!longTermSummary.value,
        longTermSummaryLength: longTermSummary.value.length,
        memoryEntries: kpMemory.value.length,
        ragContextLength: ragContext.length,
        conversationWindowSize: chatMessages.length - 1,
      })

      const fullContent = hasKpAgent()
        ? await runKpTurnService(chatMessages, buildStoryContext(), characterSheet.value, {
            onStreamChunk: (preview) => updateLastMessage((m) => { if (m.role === 'kp') m.content = sanitizeKpResponse(preview) }),
            onDisplayMessages: (msgs) => insertMessagesBeforeLast(msgs as Message[]),
            onCharacterSheetUpdate: (sheet) => applyServerCharacterSheet(sheet),
            onWorldDeltas: (deltas) => applyServerWorldDeltas(deltas),
          }).then((r) => {
            // 服务端已执行工具；用回传的工具调用记录 graph 事件与进度/高影响标记
            if (r.toolCalls.some((c) => ['grant_clue', 'transition_scene', 'skill_check', 'san_check', 'end_game'].includes(c.name))) {
              _turnHadProgressTool = true
            }
            recordToolExecution(r.toolCalls)
            return r.content
          })
        : await runDirectChatService(chatMessages as { role: 'system' | 'user' | 'assistant'; content: string }[], aiConfig, {
            onStreamChunk: (c) => updateLastMessage((m) => { if (m.role === 'kp') m.content = sanitizeKpResponse(c) }),
          })

      if (fullContent.trim()) {
        const sanitized = sanitizeKpResponse(fullContent)
        kpMemory.value = [...kpMemory.value.slice(-(MAX_MEMORY_ENTRIES - 1)), sanitized.slice(0, 80) + '…']
        extractMemoryPoints(aiConfig, sanitized).then((points) => {
          const next = [...kpMemory.value.slice(0, -1), ...points]
          kpMemory.value = next.slice(-MAX_MEMORY_ENTRIES)
          traceBus.emit('state_update', 'memory_updated', {
            kpMemoryLength: kpMemory.value.length,
            newEntryPreview: points.join(' | ').slice(0, 150),
          })
        }).catch(() => { /* fallback already in place */ })
      }
      emitCharacterSnapshot('after_turn')
      updateLastMessage((m) => { if (m.role === 'kp') m.isStreaming = false })

      narrativeStall.value = _turnHadProgressTool ? 0 : Math.min(10, narrativeStall.value + 1)
      if (_turnHadHighImpactTool) {
        runLongTermSummarization('high_impact_tool')
      } else if (playerTurnCount.value >= dynamicSummaryInterval(playerTurnCount.value) && playerTurnCount.value % dynamicSummaryInterval(playerTurnCount.value) === 0) {
        runLongTermSummarization('periodic')
      }
    } catch (e) {
      traceBus.emit('kp_agent', 'trace_error', { source: 'sendPlayerMessage', message: e instanceof Error ? e.message : String(e) })
      updateLastMessage((m) => {
        if (m.role === 'kp') { m.content = '[错误: ' + (e instanceof Error ? e.message : String(e)) + ']'; m.isStreaming = false }
      })
    } finally {
      traceBus.endTrace()
      isSending.value = false
    }
  }

  return {
    sessionId,
    storyId,
    storyName,
    storyOverview,
    currentScene,
    cluesObtained,
    messages,
    kpMemory,
    longTermSummary,
    longTermFacts,
    isInGame,
    isSending,
    playerName,
    gamePhase,
    endingState,
    scenesVisited,
    characterSheet,
    derivedStatsVersion,
    reset,
    startGame,
    setPhase,
    setCharacterSheet,
    setOccupation,
    selectedOccupationId,
    selectedOccupationName,
    confirmCharacterAndEnterGame,
    addMessage,
    addClue,
    transitionToScene,
    updateCharacterHP,
    updateCharacterMP,
    updateCharacterSAN,
    updateCharacterSkill,
    updateCharacterLuck,
    requestOpening,
    sendPlayerMessage,
    saveGame,
    loadGame,
    listSaves,
    getSaveMeta,
  }
})
