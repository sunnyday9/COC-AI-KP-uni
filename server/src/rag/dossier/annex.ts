/**
 * dossier map annex（P18，实验分支 feature/kp-dossier-workflow）— 图载信息
 * （地图/线索卡）并入档案的保守通道。
 *
 * 背景（docs/experiments/dossier-vision-images-2026-09-09.md）：storyParsers 只
 * OCR PDF 前 8 张图，图载信息（标注地图/线索卡/信件）绝大多数进不了档案；Vision
 * 原型（scripts/eval/ab-vision-map.mjs）验证 mimo-v2.5 按页抽图→结构化可行，
 * 且能补文本抽取的洞（巫 缺「山崖」场景、露营营地/露营区域命名漂移）。
 *
 * 本模块把原型能力收进 server：
 *  - 抽图候选：pdf-lib 逐页枚举 XObject（JPEG/PNG），每页≤2 张最大、跨页字节
 *    去重、≥600×600 或（长边≥1000 且短边≥400）、排除高宽比>3.2 横幅条；
 *  - 每候选一次视觉调用（mimo-v2.5；-pro 无 image input 上游 404 → 模型守卫）；
 *  - 铁律 2 信息筛选：封面/插画/其他、无地点无连接的无标签地图、过短转录
 *    （<12 字符）不入 dossier（kept=false + dropReason 留档）；
 *  - 与档案合并（保守——不自动新建场景/真相/结局）：places 精确命中场景 → 记
 *    alias；漂移/未匹配 → pending 清单；connections 两端都精确解析 → 并入
 *    transitions（tr_map_*，condition='地图标注'，与现有边去重）；kept 的线索
 *    文字图转录 → 追加 clues（clue_map_*，location='附图 第N页'）。
 *
 * 落盘 DOSSIER_DATA_DIR/<uid>/<sanitizeScriptId>.annex.json（明细审计）；档案
 * JSON 只带计数摘要（schema.DossierAnnexSummary，非剧透）。
 *
 * 安全：视觉走 chatForRag（继承协议分发 + assertSafeOutboundUrl + MOCK_AI），
 * annex 文件路径沿用白名单 sanitize + resolveFileInDir 双保险（与 dossier 文件
 * 同模式）。凭据只从 settings/环境变量读，不落源码。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFObject, decodePDFRawStream } from 'pdf-lib'
import { DOSSIER_DATA_DIR } from '../../config.js'
import { chatForRag } from '../../services/aiService.js'
import { getAiConfig } from '../../services/settingsService.js'
import { readStoryFileBytes } from '../../services/storyService.js'
import { resolveFileInDir } from '../../utils/pathSafety.js'
import { BadRequestError } from '../../utils/errors.js'
import type { ChatMessage } from '../../services/llm/types.js'
import {
  sanitizeScriptId,
  type StoryDossier,
  type DossierScene,
  type DossierAnnexSummary,
} from './schema.js'

/** 每剧本 vision 调用预算（候选图上限；原型建议 4-6 张）。 */
export const MAX_ANNEX_IMAGES = 6
/** 图至少 2KB（装饰小图跳过）。 */
const MIN_IMAGE_BYTES = 2 * 1024
/** 单图 base64 体积上限（data URI 不宜过大）。 */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024
/** 解析 PDF 上限（防超大文件拖垮进程）。 */
const PDF_SIZE_LIMIT = 60 * 1024 * 1024
/** 线索卡转录并入 clue description 的长度上限（防 scene 块爆涨）。 */
const MAX_TRANSCRIPT_CHARS = 4000
/** vision JSON 输出预算（推理模型 reasoning 会吃 output budget）。 */
const VISION_MAX_TOKENS = 4000

export interface PdfImageCandidate {
  page: number
  w: number
  h: number
  mime: string
  bytes: Buffer
}

export interface VisionParsed {
  kind?: string
  places?: { name: string; note?: string }[]
  connections?: { from: string; to: string; via?: string }[]
  transcript?: string
}

export interface AnnexImageRecord {
  page: number
  kind: string
  places: { name: string; note?: string }[]
  connections: { from: string; to: string; via?: string }[]
  transcript?: string
  kept: boolean
  dropReason?: string
}

export interface AnnexPendingItem {
  type: 'unmatched-place' | 'name-drift'
  name: string
  note: string
}

export interface AnnexMergedItem {
  type: 'transition' | 'alias' | 'card'
  detail: string
}

/** .annex.json 落盘形状：逐图明细 + pending/merged 审计。 */
export interface AnnexFile {
  scriptId: string
  storyName: string
  generatedAt: number
  visionModel?: string
  images: AnnexImageRecord[]
  failed: { page: number; error: string }[]
  pending: AnnexPendingItem[]
  merged: AnnexMergedItem[]
  /** 非阻断说明（非 PDF/无候选/PDF 过大…）。 */
  note?: string
}

export interface RunAnnexResult {
  annex: AnnexFile
  dossier: StoryDossier
  summary: DossierAnnexSummary
}

/* ═══════════════════ 铁律守卫 ═══════════════════ */

/**
 * 视觉模型守卫（铁律 1）：mimo-v2.5-pro 不支持 image input（上游 404）——
 * annex 视觉调用只允许 mimo-v2.5。缺省时取默认值（mock/测试路径无模型配置
 * 也能通过；真实路径由 chatForRag 的 model override 生效）。
 */
export function assertVisionModel(model?: string): string {
  const m = String(model ?? '').trim() || 'mimo-v2.5'
  if (!/^mimo-v2\.5$/i.test(m)) {
    throw new BadRequestError(`annex 视觉调用仅支持 mimo-v2.5（-pro 无 image input，上游 404）——当前 model=${m}`)
  }
  return m
}

/* ═══════════════════ 视觉调用 ═══════════════════ */

const VISION_SYSTEM_TEXT =
  '你是跑团模组（COC）图像解析器。下面是一张出自剧本的图。请判断它的 kind 并结构化输出，只输出一个 JSON：\n' +
  '{ "kind": "地图" | "线索文字图" | "插画" | "其他",\n' +
  '  "places": [{ "name": "图中标注的地点/区域名（原文，无标注则省略该数组）", "note": "在图中的位置/特征（可省略）" }],\n' +
  '  "connections": [{ "from": "地点名", "to": "地点名", "via": "连接方式/路径标注，如道路/山路/门（可省略）" }],\n' +
  '  "transcript": "若图含文字（信件/便条/标题/说明文字），完整转录；无文字省略"\n' +
  '}\n' +
  '规则：地点名保留图上原文（日文地名写日文并括注中文译名）；connections 只写图上可见的连线/箭头/路径关系，不要推断图上没有的连接。'

/** 从 LLM 输出里抽出 JSON（容忍围栏/前后缀散文）。 */
export function parseVisionJson(raw: string): VisionParsed | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
    const kind = typeof parsed.kind === 'string' ? parsed.kind : ''
    const places: VisionParsed['places'] = []
    if (Array.isArray(parsed.places)) {
      for (const p of parsed.places) {
        if (typeof p !== 'object' || p === null) continue
        const o = p as Record<string, unknown>
        if (typeof o.name !== 'string' || !o.name) continue
        places.push({ name: o.name, note: typeof o.note === 'string' ? o.note : undefined })
      }
    }
    const connections: VisionParsed['connections'] = []
    if (Array.isArray(parsed.connections)) {
      for (const c of parsed.connections) {
        if (typeof c !== 'object' || c === null) continue
        const o = c as Record<string, unknown>
        if (typeof o.from !== 'string' || !o.from || typeof o.to !== 'string' || !o.to) continue
        connections.push({ from: o.from, to: o.to, via: typeof o.via === 'string' ? o.via : undefined })
      }
    }
    return { kind, places, connections, transcript: typeof parsed.transcript === 'string' ? parsed.transcript : undefined }
  } catch {
    return null
  }
}

/**
 * 信息筛选（铁律 2）：封面/插画/其他、无地点无连接的无标签地图、过短转录
 * （<12 字符）→ 不入 dossier；判定结果随图留档供复核。
 */
export function classifyAnnexImage(parsed: VisionParsed): { kept: boolean; dropReason?: string } {
  const kind = String(parsed.kind ?? '其他')
  const places = Array.isArray(parsed.places) ? parsed.places : []
  const connections = Array.isArray(parsed.connections) ? parsed.connections : []
  const transcript = String(parsed.transcript ?? '').trim()
  if (kind === '插画' || kind === '其他') {
    return { kept: false, dropReason: `kind=${kind}（封面/美术/无关图不入 dossier）` }
  }
  if (kind === '地图' && places.length === 0 && connections.length === 0) {
    return { kept: false, dropReason: '无标签地图（places/connections 均空，不硬编）' }
  }
  if (transcript && transcript.length < 12) {
    return { kept: false, dropReason: '转录过短' }
  }
  return { kept: true }
}

async function callVisionOnce(userId: number, c: PdfImageCandidate, model: string): Promise<VisionParsed> {
  // 视觉消息：content 数组（text + image_url data URI）；ChatMessage 类型只声明
  // string content——openaiChat 适配器把 messages 透传给 OpenAI SDK（其原生支持
  // content 数组），此处按适配器实际形状构造。
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: VISION_SYSTEM_TEXT },
        { type: 'image_url', image_url: { url: `data:${c.mime};base64,${c.bytes.toString('base64')}` } },
      ],
    },
  ] as unknown as ChatMessage[]
  const res = await chatForRag(userId, {
    messages,
    temperature: 0,
    maxTokens: VISION_MAX_TOKENS,
    model,
  })
  const content = String(res?.content ?? '').trim()
  if (!content) throw new Error('vision empty content (reasoning consumed budget)')
  const parsed = parseVisionJson(content)
  if (!parsed) throw new Error(`vision 输出无 JSON: ${content.slice(0, 120)}`)
  return parsed
}

/** 单图视觉调用 + 重试（≥3 次、指数退避 3s 起；空内容按失败处理）。 */
async function callVisionWithRetry(userId: number, c: PdfImageCandidate, model: string): Promise<{ parsed: VisionParsed } | { error: string }> {
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { parsed: await callVisionOnce(userId, c, model) }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
    }
  }
  return { error: `after 3 attempts: ${lastErr}` }
}

/* ═══════════════════ 抽图（port of ab-vision-map.mjs） ═══════════════════ */

/** JPEG/PNG 尺寸（从文件头解析，供地图候选过滤）。 */
export function imgDims(b: Buffer): { w: number; h: number } | null {
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
      }
      i += 2 + b.readUInt16BE(i + 2)
    }
    return null
  }
  if (b[0] === 0x89 && b[1] === 0x50) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  }
  return null
}

/**
 * 逐页抽图：每页至多 2 张最大、跨页字节去重、过滤小图/横幅条（地图候选）。
 * 与 scripts/eval/ab-vision-map.mjs 的 extractPageImages 同规则。
 */
export async function extractPdfImageCandidates(pdfBytes: Uint8Array): Promise<PdfImageCandidate[]> {
  const doc = await PDFDocument.load(pdfBytes)
  const seen = new Set<string>() // 相同字节内容跨页去重
  const hits: PdfImageCandidate[] = []
  const pages = doc.getPages()
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi]
    const res = page.node.get(PDFName.of('Resources'))
    const resources = res ? doc.context.lookup(res) : undefined
    if (!(resources instanceof PDFDict)) continue
    const xoRef = resources.get(PDFName.of('XObject'))
    const xo = xoRef ? doc.context.lookup(xoRef) : undefined
    if (!(xo instanceof PDFDict)) continue
    const pageImgs: PdfImageCandidate[] = []
    for (const ref of xo.values()) {
      const obj = doc.context.lookup(ref)
      if (!(obj instanceof PDFRawStream)) continue
      const subtype = doc.context.lookup(obj.dict.get(PDFName.of('Subtype')))
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Image') continue
      const hasSig = (b: Buffer): { isJ: boolean; isP: boolean } => {
        const isJ = b[0] === 0xff && b[1] === 0xd8
        const isP = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
        return { isJ, isP }
      }
      // pdf-lib 1.17 解析 FlateDecode 流时通常已解码（getContents 即解压后字节，
      // 直接带 PNG/JPEG 签名）；未预解码的输入（zlib 开头）在此补一次解码。
      // 只在字节还不是图像签名时解码——避免对已解码字节二次 inflate 报错丢图。
      let bytes = Buffer.from(obj.getContents())
      const filterRef = obj.dict.get(PDFName.of('Filter'))
      let sig = hasSig(bytes)
      if (!sig.isJ && !sig.isP && filterRef) {
        const filter = doc.context.lookup(filterRef)
        const isDCT = filter instanceof PDFName && filter.decodeText() === 'DCTDecode'
        if (!isDCT) {
          try {
            const out = decodePDFRawStream(obj) // 运行时解构 {dict, contents}
            bytes = Buffer.from(out.decode())
            sig = hasSig(bytes)
          } catch {
            continue // 解码失败（非图内容流）
          }
        }
      }
      if (bytes.length < MIN_IMAGE_BYTES) continue // 装饰小图
      if (!sig.isJ && !sig.isP) continue
      const dedupeSig = `${bytes.length}:${bytes.subarray(0, 64).toString('hex')}`
      if (seen.has(dedupeSig)) continue // 同一图被多页复用
      seen.add(dedupeSig)
      const dims = imgDims(bytes) ?? { w: 0, h: 0 }
      pageImgs.push({ bytes, mime: sig.isJ ? 'image/jpeg' : 'image/png', page: pi + 1, w: dims.w, h: dims.h })
    }
    pageImgs.sort((a, b) => b.bytes.length - a.bytes.length)
    hits.push(...pageImgs.slice(0, 2))
  }
  // 地图候选过滤：≥600×600 或 (最长边≥1000 且短边≥400)；排除高宽比>3.2 的横幅条
  return hits
    .filter((h) => h.w > 0 && h.h > 0)
    .filter((h) => (h.w >= 600 && h.h >= 600) || (Math.max(h.w, h.h) >= 1000 && Math.min(h.w, h.h) >= 400))
    .filter((h) => Math.max(h.w, h.h) / Math.min(h.w, h.h) <= 3.2)
    .sort((a, b) => b.w * b.h - a.w * a.h)
}

/* ═══════════════════ 地点匹配 + 保守合并 ═══════════════════ */

/** 通用空间词：命名漂移判定前先剥除（区域/地带… 不构成区分信息）。 */
const GENERIC_SPACE_WORDS = ['区域', '地带', '附近', '周边', '内部', '中央', '中心', '一侧', '部分', '入口', '出口', '大门', '门口']

export type PlaceMatch =
  | { hit: 'exact'; scene: DossierScene }
  | { hit: 'drift'; note: string }
  | { hit: 'unmatched'; note: string }

/**
 * 图载地点名 ↔ 档案场景名匹配（保守）：
 *  - 精确（trim + 忽略大小写）→ exact（唯一会触发自动合并的命中）；
 *  - 包含关系（一方 ⊂ 另一方，≥2 字）、剥通用空间词后同名、共享 ≥2 字词根
 *    → drift（只进 pending，绝不自动合并）；
 *  - 其余 → unmatched（不新建场景）。
 */
export function matchAnnexPlace(scenes: DossierScene[], rawName: string): PlaceMatch {
  const name = String(rawName ?? '').trim()
  if (!name) return { hit: 'unmatched', note: '图中地点名为空' }
  const norm = (s: string) => String(s ?? '').trim().toLowerCase()
  for (const sc of scenes) {
    if (norm(sc.name) === norm(name)) return { hit: 'exact', scene: sc }
  }
  for (const sc of scenes) {
    const sn = norm(sc.name)
    const pn = norm(name)
    if (sn.length >= 2 && pn.length >= 2) {
      const short = sn.length <= pn.length ? sn : pn
      const long = sn.length <= pn.length ? pn : sn
      if (long.includes(short)) {
        return { hit: 'drift', note: `图名「${name}」与场景「${sc.name}」互相包含——同一地点不同叫法，待人工裁决` }
      }
    }
    const strip = (s: string) => {
      let r = s
      for (const g of GENERIC_SPACE_WORDS) r = r.split(g).join('')
      return r
    }
    const sSn = strip(sn)
    const sPn = strip(pn)
    if (sSn.length >= 2 && sSn === sPn) {
      return { hit: 'drift', note: `图名「${name}」剥通用词后与场景「${sc.name}」同名——命名漂移，待人工裁决` }
    }
    if (sSn.length >= 2 && sPn.length >= 2 && hasSharedCjkBigram(sSn, sPn)) {
      return { hit: 'drift', note: `图名「${name}」与场景「${sc.name}」有公共词根——可能为同一地点，待人工裁决` }
    }
  }
  return { hit: 'unmatched', note: `图载地点「${name}」在档案 scenes 中无对应（文本抽取遗漏或图上独有）` }
}

/** 两个 CJK 串是否有公共 ≥2 字子串（共享词根）。 */
function hasSharedCjkBigram(a: string, b: string): boolean {
  const cjk = (s: string) => s.replace(/[^\u4e00-\u9fff]/g, '')
  const x = cjk(a)
  const y = cjk(b)
  const grams = new Set<string>()
  for (let i = 0; i + 1 < x.length; i++) grams.add(x.slice(i, i + 2))
  for (let i = 0; i + 1 < y.length; i++) if (grams.has(y.slice(i, i + 2))) return true
  return false
}

/** 生成不撞现有 id 的编号 id（tr_map_ / clue_map_ 前缀，按同前缀计数递增）。 */
function nextPrefixedId(prefix: string, existing: Set<string>): string {
  let n = 1
  for (const id of existing) if (id.startsWith(prefix)) n++
  let candidate = `${prefix}${n}`
  while (existing.has(candidate)) {
    n++
    candidate = `${prefix}${n}`
  }
  existing.add(candidate)
  return candidate
}

export interface MergeAnnexResult {
  dossier: StoryDossier
  pending: AnnexPendingItem[]
  merged: AnnexMergedItem[]
}

/**
 * 把 kept 图并入档案副本（纯函数，不落盘、不建场景/真相/结局）：
 *  - 地点精确命中 → merged alias；漂移/未匹配 → pending（不进任何自动合并）；
 *  - connections 两端都精确命中 → transitions（tr_map_*，condition='地图标注'），
 *    与现有边及本次新增边按 (from,to) 去重；任一端 pending → 不并入；
 *  - 线索文字图转录（≥12 字，kept 判定已保证）→ clues 追加（clue_map_*）。
 */
export function mergeAnnexIntoDossier(dossier: StoryDossier, images: AnnexImageRecord[]): MergeAnnexResult {
  const kept = images.filter((i) => i.kept)
  const pending: AnnexPendingItem[] = []
  const merged: AnnexMergedItem[] = []
  const seenPending = new Set<string>()
  const placeResolved = new Map<string, DossierScene>()
  const pushPending = (type: AnnexPendingItem['type'], name: string, note: string) => {
    const key = `${type}:${name}`
    if (seenPending.has(key)) return
    seenPending.add(key)
    pending.push({ type, name, note })
  }
  for (const img of kept) {
    for (const p of img.places ?? []) {
      if (!p?.name || placeResolved.has(p.name)) continue
      const m = matchAnnexPlace(dossier.scenes, p.name)
      if (m.hit === 'exact') {
        placeResolved.set(p.name, m.scene)
        merged.push({ type: 'alias', detail: `第${img.page}页「${p.name}」命中场景「${m.scene.name}」` })
      } else {
        pushPending(m.hit === 'drift' ? 'name-drift' : 'unmatched-place', p.name, m.note)
      }
    }
  }

  const transitions = [...(dossier.transitions ?? [])]
  const existingIds = new Set(transitions.map((t) => t.id).filter((x): x is string => !!x))
  const seenEdges = new Set<string>()
  for (const t of transitions) seenEdges.add(edgeKey(t.from, t.to))
  for (const img of kept) {
    for (const c of img.connections ?? []) {
      if (!c?.from || !c?.to) continue
      const fs = placeResolved.get(c.from)
      const ts = placeResolved.get(c.to)
      if (!fs || !ts) continue // 任一端在 pending（漂移/未匹配）裁决前不并入
      const key = edgeKey(fs.id, ts.id)
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      const id = nextPrefixedId('tr_map_', existingIds)
      transitions.push({ id, from: fs.id, to: ts.id, condition: '地图标注' })
      merged.push({ type: 'transition', detail: `第${img.page}页地图边：${fs.name} → ${ts.name}` })
    }
  }

  const clues = [...dossier.clues]
  const existingClueIds = new Set(clues.map((c) => c.id).filter((x): x is string => !!x))
  const seenDescriptions = new Set(clues.map((c) => c.description.trim()))
  for (const img of kept) {
    const transcript = String(img.transcript ?? '').trim()
    if (img.kind !== '线索文字图' || !transcript) continue
    const description = `【线索卡·第${img.page}页】${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`
    if (seenDescriptions.has(description)) continue
    seenDescriptions.add(description)
    const id = nextPrefixedId('clue_map_', existingClueIds)
    clues.push({ id, description, location: `附图 第${img.page}页` })
    merged.push({ type: 'card', detail: `第${img.page}页线索卡转录 ${transcript.length} 字 → ${id}` })
  }

  const out: StoryDossier = {
    ...dossier,
    clues,
    transitions: transitions.length ? transitions : undefined,
  }
  return { dossier: out, pending, merged }
}

function edgeKey(from: string, to: string): string {
  return `${String(from ?? '').trim().toLowerCase()}→${String(to ?? '').trim().toLowerCase()}`
}

/* ═══════════════════ 落盘 / 读取 ═══════════════════ */

/** annex 文件路径：白名单 sanitize + resolve 边界双保险（同 dossier 文件）。 */
function annexFile(userId: number, scriptId: string): string {
  const safe = sanitizeScriptId(scriptId)
  return resolveFileInDir(path.join(DOSSIER_DATA_DIR, String(userId)), `${safe}.annex.json`, 'annex file')
}

export async function persistAnnex(userId: number, annex: AnnexFile): Promise<void> {
  await fs.mkdir(path.join(DOSSIER_DATA_DIR, String(userId)), { recursive: true })
  await fs.writeFile(annexFile(userId, annex.scriptId), JSON.stringify(annex, null, 2), 'utf-8')
}

export async function loadAnnex(userId: number, scriptId: string): Promise<AnnexFile | null> {
  try {
    const raw = await fs.readFile(annexFile(userId, scriptId), 'utf-8')
    const parsed = JSON.parse(raw) as AnnexFile
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export async function deleteAnnex(userId: number, scriptId: string): Promise<boolean> {
  try {
    await fs.unlink(annexFile(userId, scriptId))
    return true
  } catch {
    return false
  }
}

/* ═══════════════════ 编排（annex 生成） ═══════════════════ */

/**
 * 生成 annex 并把可并内容合入档案副本：
 *  - 非 PDF（txt/md/…）→ 空 annex（不调视觉，流程不崩）；
 *  - PDF → 抽候选（≤ maxImages）→ 逐图视觉 → 铁律 2 筛选 → 保守合并。
 * 调用方（generateDossier）负责把返回的 dossier 落盘并 persistAnnex。
 */
export async function runAnnex(
  userId: number,
  params: { scriptId: string; storyName: string; dossier: StoryDossier; model?: string; maxImages?: number },
): Promise<RunAnnexResult> {
  const visionModel = assertVisionModel(params.model)
  const ai = getAiConfig(userId)
  if (ai.protocol !== 'openai_chat') {
    throw new BadRequestError(`annex 视觉需要 openai_chat 协议（当前 ${ai.protocol}）——其余协议未验证 content-array 图像消息`)
  }
  const annex: AnnexFile = {
    scriptId: params.scriptId,
    storyName: params.storyName,
    generatedAt: Date.now(),
    visionModel,
    images: [],
    failed: [],
    pending: [],
    merged: [],
  }

  let src: { name: string; ext: string; buffer: Buffer }
  try {
    src = await readStoryFileBytes(userId, params.scriptId)
  } catch {
    annex.note = 'story 文件读取失败——annex 空'
    return { annex, dossier: withSummary(params.dossier, annex), summary: summaryOf(annex) }
  }
  if (src.ext !== '.pdf') {
    annex.note = `非 PDF（${src.ext}）无内嵌图——annex 空`
  } else if (src.buffer.length > PDF_SIZE_LIMIT) {
    annex.note = 'PDF 超 60MB 跳过抽图——annex 空'
  } else {
    try {
      const candidates = await extractPdfImageCandidates(src.buffer)
      const picked = candidates.slice(0, params.maxImages ?? MAX_ANNEX_IMAGES)
      if (candidates.length > picked.length) {
        annex.note = `候选 ${candidates.length} 张，本次取前 ${picked.length} 张（其余未处理）`
      } else if (candidates.length === 0) {
        annex.note = '无符合尺寸/宽高比的图片候选——annex 空'
      }
      for (const c of picked) {
        if (c.bytes.length > MAX_IMAGE_BYTES) continue // 超限跳过（单图 base64 过大）
        const res = await callVisionWithRetry(userId, c, visionModel)
        if ('error' in res) {
          annex.failed.push({ page: c.page, error: res.error })
          continue
        }
        const parsed = res.parsed
        const { kept, dropReason } = classifyAnnexImage(parsed)
        annex.images.push({
          page: c.page,
          kind: String(parsed.kind ?? '其他'),
          places: Array.isArray(parsed.places) ? parsed.places : [],
          connections: Array.isArray(parsed.connections) ? parsed.connections : [],
          transcript: parsed.transcript,
          kept,
          dropReason,
        })
      }
    } catch (e) {
      annex.note = `PDF 解析/抽图失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  const mergedResult = mergeAnnexIntoDossier(params.dossier, annex.images)
  annex.pending = mergedResult.pending
  annex.merged = mergedResult.merged
  return { annex, dossier: withSummary(mergedResult.dossier, annex), summary: summaryOf(annex) }
}

function summaryOf(annex: AnnexFile): DossierAnnexSummary {
  const images = annex.images.filter((i) => i.kept).length
  const drops = annex.images.filter((i) => !i.kept).length
  const transitions = annex.merged.filter((m) => m.type === 'transition').length
  const clues = annex.merged.filter((m) => m.type === 'card').length
  return {
    images,
    drops,
    failed: annex.failed.length,
    pending: annex.pending.length,
    transitions,
    clues,
    visionModel: annex.visionModel,
    at: annex.generatedAt,
  }
}

function withSummary(dossier: StoryDossier, annex: AnnexFile): StoryDossier {
  return { ...dossier, annex: summaryOf(annex) }
}
