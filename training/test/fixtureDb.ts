/**
 * 金样本 fixture（票 #38 验收 4）：以 e2e demo 剧本《旧图书馆的铜钥匙》
 * （e2e/fixtures/demo-story.txt，h5.journey 的导入/索引/跑团素材）为蓝本
 * 构建的确定性对局库——固定 id / 时间戳 / 文案，导出器输出可整行快照。
 *
 * 内容覆盖导出器的全部三个来源：
 *  - room_demo_lib  在场房间（2 角色多人局）：opening + 回合1 有 wire 采样（真实注入），
 *    回合2 无采样（多人批量合并 → 确定性重建）；
 *  - room_recycled  已被 TTL 回收的房间（rooms 行已删、kp_wire_samples 仍在）：
 *    孤儿 wire 采样导出——房间短暂、采样长存，这是长期积累的主路径；
 *  - save_demo_lib  旧版单人存档（GameSaveSnapshot）：无 wire，全量重建。
 *
 * wire 行的 system 文案为手写紧凑版（真实落库行即「当刻线上 prompt 的逐字快照」，
 * 与导出器无关；导出器对 wire 来源只做逐字拷贝，fixture 不必复现全长 BASE_INSTRUCTIONS）。
 * 全部 INSERT 走 node:sqlite 参数绑定。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OPENING_USER_REQUEST } from '../../server/src/services/kpPromptService.js'

export const USER_ID = 7
export const STORY_ID = 'demo-story'
export const ROOM_ID = 'room_demo_lib'
export const ORPHAN_ROOM_ID = 'room_recycled'
export const SAVE_ID = 'save_demo_lib'

const T = 1_725_500_000_000

const ROSTER_BLOCK =
  '\n\n### 房间内调查员（多人模式）\n- 李云（id: char_li）HP 10/10 SAN 55/55 幸运 50\n- 艾琳（id: char_ai）HP 9/9 SAN 60/60 幸运 62\n' +
  '当某个调查员行动时，调用工具必须在参数中带上对应 characterId（如 "characterId": "char_li"）。若工具缺省 characterId，将作用于最后行动的调查员。'

const WIRE_SYSTEM_OPENING =
  '（BASE_INSTRUCTIONS 全文）\n## 故事: demo-story\n\n## 当前状态\n## 调查员: 李云 (法官)\n…\n## 调查员: 艾琳 (教授)\n…' +
  ROSTER_BLOCK
const WIRE_RAG_OPENING = '【场景一】旧图书馆：管理员阿洛伊斯……青瓷花瓶……破损日记……'
const WIRE_SYSTEM_TURN1 =
  '（BASE_INSTRUCTIONS 全文）\n## 故事: demo-story\n\n## 最近几轮\n- 玩家(李云): … → 守密人: …\n\n## 故事情报\n' +
  WIRE_RAG_OPENING +
  '\n\n## 当前状态\n## 调查员: 李云 (法官)\n…\n## 调查员: 艾琳 (教授)\n…' +
  ROSTER_BLOCK
const WIRE_RAG_TURN1 = '【线索】青瓷花瓶是空心的，底部有夹层。'
const WIRE_SYSTEM_ORPHAN =
  '（BASE_INSTRUCTIONS 全文）\n## 故事: demo-story\n\n## 故事情报\n【场景二】地下室：铁链锁住的门……低语……\n\n## 当前状态\n## 调查员: 钟明 (古董商)\n…'
const WIRE_RAG_ORPHAN = '【场景二】地下室：门后传来水滴落下的声音，以及若有若无的低语。'

/* ── 回合1 wire 行：李云查花瓶，一个工具轮 + 最终叙事（导出器只取初始骨架，其余保持行完整） ── */
const TURN1_BATCH = '【李云】我蹲下身，仔细检查那只青瓷花瓶的底部。'
const TURN1_SKILL_ARGS_JSON = '{"skillName":"侦查","skillValue":60,"difficulty":"regular"}'
const TURN1_TOOL_RESULT =
  '【结果摘要】roll: 33；target: 60；outcome: regular_success\n{"roll":33,"target":60,"outcome":"regular_success"}'
const TURN1_FINAL = '花瓶的底部有一圈几乎看不见的接缝……（最终叙事）'
const OPENING_FINAL = '1925 年秋，阿卡姆。信上的那行字把你引到了市立图书馆旧馆……（开场白）'
const ORPHAN_BATCH = '【钟明】我翻阅那本破损日记的残页。'
const ORPHAN_FINAL = '日记的最后一页被撕去了一半……（最终叙事）'

const OPENING_WIRE = [
  { role: 'system', content: WIRE_SYSTEM_OPENING },
  { role: 'user', content: OPENING_USER_REQUEST },
  { role: 'assistant', content: OPENING_FINAL },
]

const TURN1_WIRE = [
  { role: 'system', content: WIRE_SYSTEM_TURN1 },
  { role: 'user', content: TURN1_BATCH },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_t1', type: 'function', function: { name: 'skill_check', arguments: TURN1_SKILL_ARGS_JSON } }],
  },
  { role: 'tool', tool_call_id: 'call_t1', content: TURN1_TOOL_RESULT },
  { role: 'assistant', content: TURN1_FINAL },
]

const ORPHAN_WIRE = [
  { role: 'system', content: WIRE_SYSTEM_ORPHAN },
  { role: 'user', content: ORPHAN_BATCH },
  { role: 'assistant', content: ORPHAN_FINAL },
]

/** 回合1 的原始 tool_calls 列（wireSampleService 落库形态：flatMap 后的数组）。 */
const TURN1_TOOL_CALLS_JSON = JSON.stringify([
  { id: 'call_t1', name: 'skill_check', arguments: TURN1_SKILL_ARGS_JSON },
])

/** 房间快照（rooms.state，结构 = server RoomSnapshot）。导出供测试对拍。 */
export function roomDemoLibState(): Record<string, unknown> {
  return {
    seq: 42,
    phase: 'ended',
    storyId: STORY_ID,
    messages: [
      { id: 'kp_open', timestamp: T + 1, role: 'kp', content: OPENING_FINAL },
      { id: 'msg_p1', timestamp: T + 2, role: 'player', playerName: '李云', content: '我蹲下身，仔细检查那只青瓷花瓶的底部。' },
      { id: 'kp_1', timestamp: T + 3, role: 'kp', content: TURN1_FINAL },
      { id: 'dice_1', timestamp: T + 4, role: 'system', type: 'dice', content: '李云 侦查检定：33/60 常规成功', result: { skill: '侦查', roll: 33, target: 60, outcome: '成功' } },
      { id: 'msg_p2a', timestamp: T + 5, role: 'player', playerName: '艾琳', content: '我去翻阅借阅台上的破损日记。' },
      { id: 'msg_p2b', timestamp: T + 6, role: 'player', playerName: '李云', content: '我留意管理员的反应。' },
      { id: 'kp_2', timestamp: T + 7, role: 'kp', content: '艾琳翻开日记，一页铅笔手写体记录着（最终叙事）……' },
    ],
    characters: {
      char_li: {
        occupationId: 'judge', occupationName: '法官', playerName: '李云',
        attributes: { str: 50, con: 60, siz: 55, dex: 70, app: 50, int: 75, pow: 55, edu: 80, luck: 50 },
        skills: { 侦查: 60, 图书馆使用: 65, 话术: 50, 心理学: 40 },
        occupationSkillKeys: ['法律', '图书馆使用', '心理学', '话术', '信用评级', '侦查', '聆听', '首次遭遇枪械', '信用评级'],
        personalInterestKeys: ['侦查', '历史', '神秘学', '母语'],
        derived: { hp: 10, hpMax: 10, mp: 11, mpMax: 11, san: 55, sanMax: 55 },
        damageBonus: '0', build: 0, insanityState: 'normal',
      },
      char_ai: {
        occupationId: 'professor', occupationName: '教授', playerName: '艾琳',
        attributes: { str: 40, con: 55, siz: 50, dex: 60, app: 55, int: 85, pow: 70, edu: 90, luck: 62 },
        skills: { 图书馆使用: 80, 语言学: 70, 神秘学: 55 },
        occupationSkillKeys: ['图书馆使用', '语言学', '历史', '神秘学', '心理学', '信用评级', '母语', '侦查', '信用评级'],
        personalInterestKeys: ['考古学', '密码学', '侦查', '母语'],
        derived: { hp: 9, hpMax: 9, mp: 14, mpMax: 14, san: 60, sanMax: 60 },
        damageBonus: '0', build: 0, insanityState: 'normal',
      },
    },
    clues: [{ id: 'clue_1', description: '青瓷花瓶底部有夹层，夹层里是一把黄铜钥匙的拓片。' }],
    scene: '旧图书馆',
    ending: null,
    turnWindowMs: 5000,
    kpMemory: [
      '1925 年秋，阿卡姆，调查员们受匿名信指引来到市立图书馆旧馆。',
      '李云检查了青瓷花瓶，发现底部夹层里藏着黄铜钥匙的拓片。',
    ],
    longTermSummary: '调查员们接受「铜钥匙」委托，正在旧图书馆调查，已发现花瓶夹层的拓片。',
    updatedAt: T + 100,
  }
}

/** 旧版单人存档（saves.data，结构 = client GameSaveSnapshot）。导出供测试对拍。 */
export function saveDemoLibData(): Record<string, unknown> {
  return {
    version: 3,
    name: SAVE_ID,
    storyId: STORY_ID,
    storyName: 'demo-story',
    storyOverview: '1925 年，阿卡姆。一封没有署名的信件把你引到市立图书馆的旧馆……',
    currentScene: '旧图书馆',
    cluesObtained: [{ id: 'clue_1', description: '青瓷花瓶底部有夹层。' }],
    messages: [
      { id: 'kp_open', timestamp: T + 1, role: 'kp', content: '1925 年秋，阿卡姆。一封没有署名的信件……（开场白）' },
      { id: 'msg_s1', timestamp: T + 2, role: 'player', playerName: '钟明', content: '我向管理员打听地下室的来历。' },
      { id: 'kp_1', timestamp: T + 3, role: 'kp', content: '阿洛伊斯的眼神闪烁了一下……（最终叙事）' },
    ],
    kpMemory: ['钟明向管理员打听地下室，对方守口如瓶。'],
    longTermSummary: '',
    longTermFacts: [],
    playerTurnCount: 1,
    gamePhase: 'playing',
    characterSheet: {
      occupationId: 'antiquarian', occupationName: '古董商', playerName: '钟明',
      attributes: { str: 45, con: 60, siz: 60, dex: 50, app: 55, int: 80, pow: 65, edu: 75, luck: 48 },
      skills: { 估价: 70, 图书馆使用: 60, 侦查: 45 },
      occupationSkillKeys: ['估价', '历史', '图书馆使用', '母语', '信用评级', '侦查', '心理学', '话术', '信用评级'],
      personalInterestKeys: ['神秘学', '考古学', '聆听', '母语'],
      derived: { hp: 11, hpMax: 11, mp: 13, mpMax: 13, san: 58, sanMax: 58 },
      damageBonus: '0', build: 0, insanityState: 'normal',
    },
    playerName: '钟明',
    selectedOccupationId: 'antiquarian',
    selectedOccupationName: '古董商',
    sessionId: null,
    endingState: null,
  }
}

export interface FixtureDb {
  dbPath: string
  dispose(): void
}

/** 建临时金样本库（表结构 = server/src/db/index.ts 中导出器读取的表的列集）。 */
export function createFixtureDb(): FixtureDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-export-fixture-'))
  const dbPath = path.join(dir, 'ai-kp.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE rooms (
      room_id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, invite_code TEXT NOT NULL UNIQUE,
      story_id TEXT, kind TEXT NOT NULL DEFAULT 'multi', phase TEXT NOT NULL DEFAULT 'lobby',
      state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE stories (
      user_id INTEGER NOT NULL, story_id TEXT NOT NULL, name TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, story_id)
    );
    CREATE TABLE saves (
      user_id INTEGER NOT NULL, save_id TEXT NOT NULL, data TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, save_id)
    );
    CREATE TABLE kp_wire_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, turn_seq INTEGER NOT NULL,
      owner_id INTEGER NOT NULL, story_id TEXT, rag_context TEXT NOT NULL DEFAULT '',
      tool_calls TEXT NOT NULL DEFAULT '[]', wire_messages TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  db.prepare(`INSERT INTO stories (user_id, story_id, name, created_at) VALUES (?, ?, ?, ?)`).run(
    USER_ID, STORY_ID, 'demo-story', T,
  )
  db.prepare(
    `INSERT INTO rooms (room_id, owner_id, invite_code, story_id, kind, phase, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ROOM_ID, USER_ID, 'INV001', STORY_ID, 'multi', 'ended', JSON.stringify(roomDemoLibState()), T, T + 100)

  const insertSample = db.prepare(
    `INSERT INTO kp_wire_samples (room_id, turn_seq, owner_id, story_id, rag_context, tool_calls, wire_messages, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertSample.run(ROOM_ID, 1, USER_ID, STORY_ID, WIRE_RAG_OPENING, '[]', JSON.stringify(OPENING_WIRE), T + 1)
  insertSample.run(ROOM_ID, 2, USER_ID, STORY_ID, WIRE_RAG_TURN1, TURN1_TOOL_CALLS_JSON, JSON.stringify(TURN1_WIRE), T + 3)
  // 孤儿：房间已回收（rooms 无行），采样仍在
  insertSample.run(ORPHAN_ROOM_ID, 1, USER_ID, STORY_ID, WIRE_RAG_ORPHAN, '[]', JSON.stringify(ORPHAN_WIRE), T + 20)

  db.prepare(`INSERT INTO saves (user_id, save_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
    USER_ID, SAVE_ID, JSON.stringify(saveDemoLibData()), T + 50,
  )
  db.close()
  return { dbPath, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
