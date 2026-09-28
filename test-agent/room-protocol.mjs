#!/usr/bin/env node
/**
 * test-agent/room-protocol.mjs — 当前服务端权威单轨的真实 LLM 旅程。
 *
 * 只使用现行公开契约：REST 创建 solo room + WS room:join/room:action。
 * KP 工具循环在服务端完成，测试不再伪造客户端 tool_calls，也不再发送
 * 已退役的 kp:invoke / /api/kp/invoke。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import {
  ROOT,
  api,
  cleanup,
  generateDossier,
  getLlmConfig,
  printSummary,
  registerUser,
  saveAiSettings,
  startServices,
  step,
  uploadAndIndex,
} from './lib/common.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function makeSheet(name) {
  const attributes = { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 }
  return {
    occupationId: 'judge',
    occupationName: '法官',
    playerName: name,
    attributes,
    skills: { 侦查: 65, 聆听: 60, 图书馆使用: 55, 格斗: 40, 信用评级: 40 },
    occupationSkillKeys: ['侦查', '聆听', '图书馆使用', '格斗', '信用评级', '心理学', '法律', '母语', '恐吓'],
    personalInterestKeys: ['侦查', '聆听', '图书馆使用', '潜行'],
    derived: {
      hp: 10,
      hpMax: 10,
      mp: 10,
      mpMax: 10,
      san: 50,
      sanMax: 50,
    },
    damageBonus: '0',
    build: 0,
    mov: 8,
    armor: 0,
  }
}

function openWs(apiBase, token) {
  const wsUrl = `${apiBase.replace(/^http/, 'ws').replace('localhost', '127.0.0.1')}/ws?token=${encodeURIComponent(token)}`
  const socket = new WebSocket(wsUrl)
  const frames = []
  const waiters = []
  const room = { roomId: null, snapshot: null, toolMessages: [] }

  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    frames.push(frame)
    if (frame.roomId === room.roomId && frame.type === 'room:state') {
      room.snapshot = structuredClone(frame.snapshot)
    } else if (frame.roomId === room.roomId && frame.type === 'room:event') {
      if (frame.eventType === 'room_meta' && room.snapshot) {
        room.snapshot.phase = frame.payload?.phase ?? room.snapshot.phase
      }
      if (frame.eventType === 'message_appended') {
        const message = frame.payload?.message
        if (room.snapshot && message) room.snapshot.messages.push(message)
        if (message?.role === 'system' && typeof message.content === 'string') {
          room.toolMessages.push(message.content)
        }
      }
      if (frame.eventType === 'state_patch' && room.snapshot) {
        const { path: patchPath, value } = frame.payload ?? {}
        if (patchPath === 'clues') room.snapshot.clues = value
        else if (patchPath === 'scene') room.snapshot.scene = value
        else if (patchPath === 'ending') room.snapshot.ending = value
        else if (typeof patchPath === 'string' && patchPath.startsWith('characters.')) {
          const characterId = patchPath.slice('characters.'.length)
          room.snapshot.characters[characterId] = {
            ...(room.snapshot.characters[characterId] ?? {}),
            ...(value && typeof value === 'object' ? value : {}),
          }
        }
      }
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (!waiters[i].predicate(frame)) continue
      const waiter = waiters.splice(i, 1)[0]
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
    }
  })

  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', (error) => reject(error))
  })

  return {
    socket,
    frames,
    room,
    opened,
    waitFor(predicate, timeoutMs, label) {
      const existing = frames.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`WS wait timed out: ${label}; actual room state ${JSON.stringify(roomObservation({ room }))}`))
        }, timeoutMs)
        waiters.push({ predicate, resolve, reject, timer })
      })
    },
    close() {
      try { socket.close() } catch { /* already closed */ }
    },
  }
}

function maxSeq(frames, roomId) {
  return frames.reduce((max, frame) => (frame.roomId === roomId ? Math.max(max, Number(frame.seq) || 0) : max), 0)
}

function roomObservation(ws) {
  const snapshot = ws?.room.snapshot
  const characters = Object.fromEntries(
    Object.entries(snapshot?.characters ?? {}).map(([id, sheet]) => [id, {
      hp: sheet?.derived?.hp,
      san: sheet?.derived?.san,
    }]),
  )
  return {
    roomId: ws?.room.roomId ?? null,
    phase: snapshot?.phase ?? null,
    clues: snapshot?.clues ?? [],
    characters,
    ending: snapshot?.ending ?? null,
    recentToolMessages: ws?.room.toolMessages.slice(-12) ?? [],
  }
}

function assertRoomState(ws, scenario, expected, actual, condition) {
  if (!condition) {
    throw new Error(`[${scenario}] expected room state ${JSON.stringify(expected)}; actual room state ${JSON.stringify(actual)}`)
  }
}

async function sendRoomAction(ws, roomId, content, scenario) {
  const before = maxSeq(ws.frames, roomId)
  ws.socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content } } }))
  const player = await ws.waitFor(
    (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.seq > before &&
      frame.eventType === 'message_appended' && frame.payload?.message?.role === 'player' &&
      frame.payload.message.content === content,
    30_000,
    `${scenario} player message`,
  )
  assertRoomState(ws, scenario, { playerMessage: content }, roomObservation(ws), !!player.payload.author?.userId)
}

async function main() {
  const mockAi = process.env.MOCK_AI === '1'
  const llm = mockAi ? null : getLlmConfig()
  console.log(mockAi ? '[room-protocol] AI: MOCK_AI=1' : `[room-protocol] LLM: ${llm.model} @ ${llm.baseUrl}`)
  const { apiBase, tmpRoot } = await startServices(3111, 5186, { web: false })
  let ws

  try {
    const token = await registerUser(apiBase, `room_agent_${Date.now() % 100000}`, 'testpass123')
    if (llm) await saveAiSettings(apiBase, llm, token)

    let scriptId
    await step('上传并索引剧本（当前 RAG REST）', async () => {
      const fixture = path.join(ROOT, 'test-agent', 'fixtures', 'black-campus.txt')
      assert(fs.existsSync(fixture), `missing fixture: ${fixture}`)
      const result = await uploadAndIndex(apiBase, fixture, token)
      scriptId = result.upload?.scriptId ?? result.upload?.id
      assert(typeof scriptId === 'string' && scriptId.length > 0, `missing scriptId: ${JSON.stringify(result.upload)}`)
    })

    await step('生成 truth revealScene 与 gaps 锚点（rag 开局门闩）', async () => {
      await generateDossier(apiBase, scriptId, token)
    })

    let roomId
    let characterId
    await step('创建 solo 房并通过 artifact 开局门闩', async () => {
      const created = await api(apiBase, 'POST', '/api/rooms/solo', {
        storyId: scriptId,
        name: '协议测试员',
        sheet: makeSheet('协议测试员'),
      }, token)
      assert(created.status === 200, `solo room create failed: ${created.status} ${created.text}`)
      roomId = created.json?.roomId
      characterId = created.json?.characterId
      assert(typeof roomId === 'string' && roomId.length > 0, `missing roomId: ${created.text}`)
      assert(typeof characterId === 'string' && characterId.length > 0, `missing characterId: ${created.text}`)

      const detail = await api(apiBase, 'GET', `/api/rooms/${encodeURIComponent(roomId)}`, undefined, token)
      assert(detail.status === 200 && detail.json?.phase === 'playing', `room is not playing: ${detail.text}`)
    })

    ws = openWs(apiBase, token)
    await ws.opened
    ws.room.roomId = roomId
    ws.socket.send(JSON.stringify({ type: 'room:join', roomId }))

    await step('room:join 返回成员快照', async () => {
      const state = await ws.waitFor(
        (frame) => frame.type === 'room:state' && frame.roomId === roomId,
        15_000,
        'room:state',
      )
      assertRoomState(ws, 'room join', { phase: 'playing', storyId: scriptId }, roomObservation(ws),
        state.snapshot?.phase === 'playing' && state.snapshot?.storyId === scriptId)
    })

    await step('服务端 opening 经 room:event 到达', async () => {
      const opening = await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'message_appended' && frame.payload?.message?.role === 'kp',
        240_000,
        'opening KP message',
      )
      assertRoomState(ws, 'opening', { kpMessage: 'non-empty' }, roomObservation(ws),
        typeof opening.payload.message.content === 'string' && opening.payload.message.content.length > 0)
    }, 250_000)

    await step('investigation: skill check grants and persists a clue', async () => {
      const content = '我仔细侦查校长办公室，搜索书架和办公桌。'
      const beforeClues = ws.room.snapshot?.clues?.length ?? 0
      await sendRoomAction(ws, roomId, content, 'investigation')
      await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'message_appended' &&
          frame.payload?.message?.role === 'system' && /侦查检定/.test(frame.payload.message.content),
        30_000,
        'investigation skill_check tool result',
      )
      await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'state_patch' &&
          frame.payload?.path === 'clues' && Array.isArray(frame.payload.value) && frame.payload.value.length > beforeClues,
        30_000,
        'investigation clue state_patch',
      )
      await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'message_appended' &&
          frame.payload?.message?.role === 'system' && /获得线索/.test(frame.payload.message.content),
        30_000,
        'investigation grant_clue tool result',
      )
      const state = roomObservation(ws)
      assertRoomState(ws, 'investigation', {
        phase: 'playing',
        clueContains: '铜钥匙',
        toolMessages: ['侦查检定', '获得线索'],
      }, state, state.phase === 'playing' && state.clues.length > beforeClues &&
        state.clues.some((clue) => clue.description.includes('铜钥匙')) &&
        state.recentToolMessages.some((message) => message.includes('侦查检定')) &&
        state.recentToolMessages.some((message) => message.includes('获得线索')))
      console.log(`    线索: ${state.clues.at(-1)?.description}`)
    }, 90_000)

    await step('combat: tool chain reduces HP and keeps the room playing', async () => {
      const beforeHp = ws.room.snapshot?.characters?.[characterId]?.derived?.hp
      await sendRoomAction(ws, roomId, '我发动攻击！', 'combat')
      for (const expectedText of ['格斗检定', '投骰 d6:', 'HP -2']) {
        await ws.waitFor(
          (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'message_appended' &&
            frame.payload?.message?.role === 'system' && frame.payload.message.content.includes(expectedText),
          30_000,
          `combat tool result ${expectedText}`,
        )
      }
      const state = roomObservation(ws)
      const afterHp = state.characters[characterId]?.hp
      assertRoomState(ws, 'combat', { phase: 'playing', hp: beforeHp - 2, toolMessages: ['格斗检定', '投骰 d6:', 'HP -2'] },
        state, state.phase === 'playing' && Number.isFinite(beforeHp) && afterHp === beforeHp - 2)
    }, 90_000)

    await step('SAN: horror check emits dice result and lowers SAN', async () => {
      const beforeSan = ws.room.snapshot?.characters?.[characterId]?.derived?.san
      await sendRoomAction(ws, roomId, '我看见不可名状的恐怖，理智受到冲击，开始尖叫。', 'SAN')
      await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'message_appended' &&
          frame.payload?.message?.role === 'system' && frame.payload.message.content.includes('SAN检定 d100:'),
        30_000,
        'SAN san_check tool result',
      )
      const state = roomObservation(ws)
      const afterSan = state.characters[characterId]?.san
      assertRoomState(ws, 'SAN', { phase: 'playing', sanLessThan: beforeSan, toolMessage: 'SAN检定 d100:' }, state,
        state.phase === 'playing' && Number.isFinite(beforeSan) && Number.isFinite(afterSan) && afterSan < beforeSan &&
        state.recentToolMessages.some((message) => message.includes('SAN检定 d100:')))
    }, 90_000)

    await step('active solo room remains in the resume list', async () => {
      const listed = await api(apiBase, 'GET', '/api/rooms/solo', undefined, token)
      assertRoomState(ws, 'resume list', { containsRoomId: roomId },
        { status: listed.status, roomIds: listed.json?.map((room) => room.roomId) ?? [] },
        listed.status === 200 && listed.json?.some((room) => room.roomId === roomId))
    })

    await step('ending: end_game marks the room ended and persists the ending', async () => {
      await sendRoomAction(ws, roomId, '真相大白，我已找到所有答案，请结束调查并记录结局。', 'ending')
      await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'message_appended' &&
          frame.payload?.message?.role === 'system' && frame.payload.message.content.includes('游戏结束: 真相大白'),
        30_000,
        'ending end_game tool result',
      )
      await ws.waitFor(
        (frame) => frame.type === 'room:event' && frame.roomId === roomId && frame.eventType === 'room_meta' &&
          frame.payload?.phase === 'ended',
        30_000,
        'ending room_meta phase',
      )
      const detail = await api(apiBase, 'GET', `/api/rooms/${encodeURIComponent(roomId)}`, undefined, token)
      const soloList = await api(apiBase, 'GET', '/api/rooms/solo', undefined, token)
      const persistedEnding = detail.json?.state?.ending
      const actual = {
        room: roomObservation(ws),
        persisted: { status: detail.status, phase: detail.json?.phase, ending: persistedEnding },
        listedAsContinuable: soloList.json?.some((room) => room.roomId === roomId),
      }
      assertRoomState(ws, 'ending', {
        event: '游戏结束: 真相大白',
        phase: 'ended',
        persistedEndingTitle: '真相大白',
        listedAsContinuable: false,
      }, actual, actual.room.phase === 'ended' && detail.status === 200 && detail.json?.phase === 'ended' &&
        persistedEnding?.title === '真相大白' && actual.listedAsContinuable === false &&
        actual.room.recentToolMessages.some((message) => message.includes('游戏结束: 真相大白')))
    }, 90_000)
  } finally {
    ws?.close()
    printSummary('room-protocol')
    cleanup()
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
main().catch((error) => {
  console.error('[room-protocol] FATAL', error)
  cleanup()
  process.exitCode = 1
})
}
