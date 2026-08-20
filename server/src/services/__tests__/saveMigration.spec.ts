/**
 * 存档迁移工具测试（Phase C3/A5）— migrateSaveSnapshot / roomSnapshotToSave / saveToRoomSnapshot。
 */
import { describe, expect, it } from 'vitest'
import { migrateSaveSnapshot, roomSnapshotToSave, saveToRoomSnapshot, SAVE_VERSION } from '../saveMigration.js'

describe('migrateSaveSnapshot (C3/A5)', () => {
  it('legacy 快照（clues 为字符串数组）→ 归一化为结构化', () => {
    const migrated = migrateSaveSnapshot({
      storyId: 'story_x',
      currentScene: '旧图书馆',
      cluesObtained: ['铜钥匙', '日记残页'],
      messages: [{ id: 'm1', timestamp: 1, role: 'kp', content: '你好' }],
      playerTurnCount: 3,
    })
    expect(migrated).not.toBeNull()
    expect(migrated!.version).toBe(SAVE_VERSION)
    expect(migrated!.cluesObtained).toEqual([
      { id: '', description: '铜钥匙' },
      { id: '', description: '日记残页' },
    ])
    expect(migrated!.currentScene).toBe('旧图书馆')
    expect(migrated!.playerTurnCount).toBe(3)
    expect(migrated!.gamePhase).toBe('playing') // 缺省补全
    expect(migrated!.kpMemory).toEqual([])
  })

  it('结构化 clues 原样保留（含 id）', () => {
    const migrated = migrateSaveSnapshot({
      cluesObtained: [{ id: 'c1', description: '铜钥匙' }],
    })
    expect(migrated!.cluesObtained).toEqual([{ id: 'c1', description: '铜钥匙' }])
  })

  it('非对象 → null', () => {
    expect(migrateSaveSnapshot(null)).toBeNull()
    expect(migrateSaveSnapshot('x')).toBeNull()
    expect(migrateSaveSnapshot(42)).toBeNull()
  })

  it('messages 过滤非法条目（缺 role/content 丢弃）', () => {
    const migrated = migrateSaveSnapshot({
      messages: [
        { id: 'a', role: 'kp', content: 'ok' },
        { id: 'b', role: 'player' }, // 缺 content
        'bad',
      ],
    })
    expect(migrated!.messages).toHaveLength(1)
    expect(migrated!.messages[0]!.content).toBe('ok')
  })
})

describe('roomSnapshotToSave / saveToRoomSnapshot (C3)', () => {
  const roomSnap = {
    seq: 12,
    phase: 'playing',
    storyId: 'story_x',
    messages: [
      { id: 'm1', timestamp: 1, role: 'player' as const, playerName: '艾琳', content: '我搜索书架。' },
      { id: 'm2', timestamp: 2, role: 'kp' as const, content: '你找到了铜钥匙。' },
    ],
    characters: { char_a: { id: 'char_a', playerName: '艾琳', occupationId: 'occ1', occupationName: '侦探', derived: { hp: 9, hpMax: 12 } } },
    clues: [{ id: 'c1', description: '铜钥匙' }],
    scene: '旧图书馆',
    ending: null,
  }

  it('房间快照 → 存档（角色/线索/消息/场景保留）', () => {
    const save = roomSnapshotToSave(roomSnap)
    expect(save.version).toBe(SAVE_VERSION)
    expect(save.storyId).toBe('story_x')
    expect(save.currentScene).toBe('旧图书馆')
    expect(save.cluesObtained).toEqual([{ id: 'c1', description: '铜钥匙' }])
    expect(save.messages).toHaveLength(2)
    expect(save.playerTurnCount).toBe(1) // 1 条 player 消息
    expect(save.characterSheet).not.toBeNull()
    expect((save.characterSheet as { playerName?: string }).playerName).toBe('艾琳')
    expect(save.gamePhase).toBe('playing')
  })

  it('ended 房间 → 存档 gamePhase=ended，结局保留', () => {
    const save = roomSnapshotToSave({ ...roomSnap, phase: 'ended', ending: { outcome: 'survival', title: '真相' } })
    expect(save.gamePhase).toBe('ended')
    expect((save.endingState as { outcome?: string }).outcome).toBe('survival')
  })

  it('存档 → 房间快照（往返不丢核心状态）', () => {
    const save = roomSnapshotToSave(roomSnap)
    const back = saveToRoomSnapshot(save)
    expect(back.storyId).toBe('story_x')
    expect(back.scene).toBe('旧图书馆')
    expect(back.clues).toEqual([{ id: 'c1', description: '铜钥匙' }])
    expect(back.messages).toHaveLength(2)
    expect(back.characters).toHaveProperty('char_import')
    expect(back.phase).toBe('playing')
  })
})
