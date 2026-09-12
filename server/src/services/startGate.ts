/**
 * StartGate — 开局门闩 deep module（「能否开局」的唯一判定落点，架构走查候选 4）。
 *
 * 收编自 roomService 两个 REST 入口的门闩判定：startRoom（多人等待室开局）此前自带
 * 结束态/已选剧本/workflow 可用性/成员绑卡四道闩，createSoloRoom（solo 出生即 playing、
 * 不经 startRoom）另有一份 dossier 降质判定——workflow→门闩的映射（rag=已索引 /
 * dossier=已生成+未降质）没有单一落点，且 startRoom 的 dossier 分支对同一目录 readdir
 * 扫两遍（listDossiersForOwner 拿 scriptId 集合 + dossierGateNoticeForOwner 再扫一遍
 * 喂 dossierGateNotice）。本模块把判定收成一处：一次 listDossiers 磁盘扫描同时服务
 * 「已生成」与「未降质」两个判定（scriptId 集合与降质视图同源一份 DossierListItem[]）。
 *
 * 双入口差异用 gateFor 表达（不是两份 if 链复刻）：
 *  - 'lobby-start'（startRoom）：结束态终态（#54）+ 已选剧本 + workflow 可用性
 *    （dossier 已生成→未降质；rag 已索引，ADR-0005 防 KP 无原文静默空跑）+ 成员绑卡；
 *  - 'solo-create'（createSoloRoom）：一体动作自己绑卡、房间行尚未存在——无结束态/
 *    已选剧本/绑卡闩；**缺档案不拦**（维持现状，2026-09-12 #55 会话定的边界：多人
 *    startRoom 已有「未生成」门闩，#55 只收窄「生成了但质量不足」的静默放行），
 *    dossier workflow 只拦降质，rag 局零门闩（现状不变）。
 *
 * 判定形态（Mimosa 门禁放行形态，2026-09-12 验证）：质量视图只能经 dossierCore 的
 * listDossiers readdir 磁盘扫描拿全（文件名非请求输入）+ 纯函数 dossierGateNotice 判
 * 降质——REST 可达链上**不引入以请求 storyId 为键的 loadDossier/loadGaps keyed fs 读**。
 * 对知识层实现（dossierCore / ragService）保持动态 import。governanceGate 的
 * multi-only 前置（kind）留在房间域——它被全部治理动作共享，不是开局门闩。
 * 本模块无状态、无 fs/db 静态运行时依赖（类型除外）：入口只喂「行摘要 + 归属」，
 * 成功路径副作用（写库/对账/opening）不在此——门闩只判定。唯一静态运行时依赖是
 * 零依赖纯函数 codec roomStateCodec（#61 rooms.state 读点收口），不引 fs/db 重量。
 */
import type { StoryWorkflow } from './kpPromptService.js'
import type { DossierListItem } from '../rag/dossier/dossierCore.js'
import { parseRoomState } from './roomStateCodec.js'

/** 门闩入口：lobby-start = startRoom（等待室开局）；solo-create = createSoloRoom（一体动作，出生即 playing）。 */
export type StartGateFor = 'lobby-start' | 'solo-create'

/** 成员行摘要（绑卡门闩输入；lobby-start 由调用方从 room_members 行投影，solo-create 不传）。 */
export interface StartGateMemberSummary {
  characterId: string | null
  username: string
}

/** 房间行摘要（lobby-start 由调用方从 rooms 行投影；solo-create 无房间行不传）。
 *  kind 不在此判定：multi-only 前置是 governanceGate 的共享职责（房间域）。 */
export interface StartGateRoomSummary {
  /** 结束态门闩键：'ended' → 拒绝复活成 playing。 */
  phase?: string | null
  /** rooms.state JSON（workflow 分派键藏于此；列无 workflow 列）。 */
  state?: string | null
}

/** 门闩输入：判定（含 workflow 解析与分派）全在本模块，入口只喂数据。 */
export interface StartGateInput {
  gateFor: StartGateFor
  /** 剧本 id。lobby-start 允许空串（→ 已选剧本门闩）；solo-create 的必填是入口参数
   *  校验（bad-request），不是门闩。 */
  storyId: string
  /** 剧本档案/索引按房主解析（KP 回合全程跟随现任 owner，ADR-0005）。 */
  ownerId: number
  /** lobby-start：房间行摘要。solo-create 不传（一体动作，房间行尚未存在）。 */
  room?: StartGateRoomSummary | null
  /** solo-create：请求传入的 workflow 原值（出生即定；缺省/非法 → rag，见 sanitizeWorkflow）。 */
  workflow?: unknown
  /** lobby-start：成员行摘要（绑卡门闩）。solo-create 不传（一体动作在同一事务里自己绑卡）。 */
  members?: StartGateMemberSummary[]
}

/** 门闩判定结果：放行，或 409 conflict（门闩拒绝全部映射 409，reason 单一）。 */
export type StartGateResult = { ok: true } | { ok: false; reason: 'conflict'; message: string }

/** 解析 workflow 入参：仅接受 'dossier'，其余（含 undefined/非法）一律 rag（现状默认）。 */
export function sanitizeWorkflow(value: unknown): StoryWorkflow {
  return value === 'dossier' ? 'dossier' : 'rag'
}

/** 房间行内 workflow（lobby 期由 createRoom 写入 state JSON；列无 workflow 列）。
 *  rooms.state 经 codec 容错解析（#61）：空值/脏 JSON/JSON null → workflow undefined → 'rag'（原语义）。 */
function roomWorkflowFromRow(room: StartGateRoomSummary): StoryWorkflow {
  return sanitizeWorkflow(parseRoomState<{ workflow?: unknown }>(room.state)?.workflow)
}

/** dossier 门闩材料：一次 readdir 拿全——清单（scriptId 集合判「已生成」）与该剧本的
 *  降质提示（纯函数 dossierGateNotice 判「未降质」）同源一份扫描结果，消掉原
 *  listDossiersForOwner + dossierGateNoticeForOwner 对同一目录的双扫描。
 *  扫描/服务异常 → null（调用方按各入口既有容错语义处理）。 */
async function loadDossierGateMaterials(
  ownerId: number,
  storyId: string,
): Promise<{ items: DossierListItem[]; degradedNotice: string | null } | null> {
  try {
    const { listDossiers, dossierGateNotice } = await import('../rag/dossier/dossierCore.js')
    const items = await listDossiers(ownerId)
    return { items, degradedNotice: dossierGateNotice(items, storyId) }
  } catch {
    return null
  }
}

/** 房主已索引剧本 id 集（rag workflow 门闩；防 KP 无原文静默空跑，ADR-0005）。
 *  清单缺失/服务异常 → []（按未索引处理，与原 roomService 容错一致）。 */
async function loadIndexedStoryIds(ownerId: number): Promise<string[]> {
  try {
    const { listStories } = await import('./ragService.js')
    return listStories(ownerId).map((s) => s.storyId)
  } catch {
    return []
  }
}

/** 门闩拒绝（409）构造。 */
function gateConflict(message: string): StartGateResult {
  return { ok: false, reason: 'conflict', message }
}

/**
 * 开局门闩唯一判定入口：startRoom / createSoloRoom 各一行调用，409 reason/message
 * 与拆分前逐字节一致。判定次序与原两处 if 链逐一同构：
 * 结束态 → 已选剧本 → workflow 可用性（已生成/已索引 → 降质）→ 成员绑卡。
 */
export async function checkStartGate(input: StartGateInput): Promise<StartGateResult> {
  const lobby = input.gateFor === 'lobby-start'
  // 门闩 0（#54，lobby-start）：结束是终态——已结束的房间不得被 start 复活成 playing
  // （否则 updateRoomStart 会把 phase 列写回 playing，继续游戏入口重新列出该局）。
  if (lobby && input.room?.phase === 'ended') return gateConflict('对局已结束，无法重新开始')
  // 门闩 1（lobby-start）：已选剧本（storyId 必填——房间创建时允许为空，开局前必须选定）。
  if (lobby && !input.storyId) return gateConflict('请先在等待室选定剧本')
  // 门闩 2：剧本可用性按 workflow 分派（dossier=已生成+未降质；rag=已索引）。
  const workflow = input.room ? roomWorkflowFromRow(input.room) : sanitizeWorkflow(input.workflow)
  if (workflow === 'dossier') {
    const materials = await loadDossierGateMaterials(input.ownerId, input.storyId)
    if (lobby) {
      // 「未生成」409：清单拿不到（扫描异常 → 与原 listDossiersForOwner catch → [] 同向）
      // 或 scriptId 不在集合内，均按缺档案处理。
      const generated = materials?.items.some((d) => d.scriptId === input.storyId) ?? false
      if (!generated) return gateConflict('该剧本尚未生成档案，请先在「我的故事」中为剧本生成档案')
    }
    // 门闩 2b（#55，双入口共有）：低覆盖/分节失败的残档不再静默放行。文案与「未生成
    // 档案」分开——缺档案指引生成，残档指引重生成。判定走档案清单（readdir 磁盘扫描，
    // 文件名非请求输入）+ 纯函数：REST 可达链上不引入"以请求 id 为键"的 fs 读。
    // solo-create 缺档案/清单拿不到 → degradedNotice 为 null 放行（维持现状，与原
    // dossierGateNoticeForOwner 的 catch → null 语义一致）。
    if (materials?.degradedNotice) return gateConflict(materials.degradedNotice)
  } else if (lobby) {
    // rag workflow（仅 lobby-start）：solo 的 rag 局零门闩（现状不变）。
    const indexed = await loadIndexedStoryIds(input.ownerId)
    if (!indexed.includes(input.storyId)) {
      return gateConflict('该剧本尚未索引，请先在「我的故事」中完成索引')
    }
  }
  // 门闩 3（lobby-start 数据驱动）：每名成员已绑定角色卡（不等待就绪——软信号）。
  // solo-create 不传 members（一体动作在同一事务里自己绑卡）→ 空集放行。
  const unbound = (input.members ?? []).filter((m) => !m.characterId)
  if (unbound.length > 0) {
    // 到此处必有未绑成员 → 括注名单恒在（原文案的 length>0 三元为恒真分支，输出逐字节一致）。
    return gateConflict(`${unbound.length} 名成员未绑定角色卡（${unbound.map((m) => m.username).join('、')}）`)
  }
  return { ok: true }
}
