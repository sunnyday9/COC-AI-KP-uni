/**
 * roomStateCodec 直测（#61）——rooms.state JSON 文档列的单点编解码原语。
 * 纯函数测试：覆盖 parse 容错（脏 JSON → null/fallback）、JSON null 透传语义、
 * 序列化往返。各调用点的业务容错分支（'' 摘要 / 'rag' / 默认快照 / {} 透传）
 * 由 roomService/startGate/roomStorage 的既有用例覆盖，不在此重复。
 */
import { describe, it, expect } from 'vitest'
import { parseRoomState, parseRoomStateOr, serializeRoomState } from '../roomStateCodec.js'

describe('parseRoomState 容错解析', () => {
  it('合法 JSON 对象原样返回', () => {
    expect(parseRoomState('{"workflow":"dossier","turnWindowMs":0}')).toEqual({ workflow: 'dossier', turnWindowMs: 0 })
  })

  it('空串/undefined/null → null（各读点前置空判的等价收口）', () => {
    expect(parseRoomState('')).toBeNull()
    expect(parseRoomState(undefined)).toBeNull()
    expect(parseRoomState(null)).toBeNull()
  })

  it('脏 JSON（截断/语法错）→ null，不抛', () => {
    expect(parseRoomState('{"messages":')).toBeNull()
    expect(parseRoomState('not-json')).toBeNull()
  })

  it('JSON null 内容 → null（与解析失败同型，调用点处理本就相同）', () => {
    expect(parseRoomState('null')).toBeNull()
  })

  it('泛型断言只收窄类型不改运行时值（原始值原样透出）', () => {
    expect(parseRoomState<{ workflow?: unknown }>('"raw-string"')).toBe('raw-string')
    expect(parseRoomState('42')).toBe(42)
  })
})

describe('parseRoomStateOr 透传解析', () => {
  it('解析失败 → fallback', () => {
    expect(parseRoomStateOr('{broken', {})).toEqual({})
    expect(parseRoomStateOr('', null)).toBeNull()
    expect(parseRoomStateOr(undefined, [])).toEqual([])
  })

  it('解析成功为 JSON null → 原样透传 null（getRoomDetail/setRoomTurnWindow 透传语义，非 fallback）', () => {
    expect(parseRoomStateOr('null', {})).toBeNull()
  })

  it('解析成功为原始值 → 原样返回', () => {
    expect(parseRoomStateOr('"str"', {})).toBe('str')
    expect(parseRoomStateOr('[1,2]', {})).toEqual([1, 2])
  })
})

describe('serializeRoomState 序列化', () => {
  it('对象 → JSON 字符串，与 parse 往返一致', () => {
    const doc = { workflow: 'dossier', turnWindowMs: 0 }
    const json = serializeRoomState(doc)
    expect(json).toBe('{"workflow":"dossier","turnWindowMs":0}')
    expect(parseRoomState(json)).toEqual(doc)
  })

  it('空对象 → "{}"（insertRoom 初始 state 同型）', () => {
    expect(serializeRoomState({})).toBe('{}')
  })
})
