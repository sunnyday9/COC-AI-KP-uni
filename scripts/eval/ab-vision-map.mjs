/**
 * Vision 图集解析原型（mimo-v2.5 视觉）——COC 模组 PDF 内嵌图 → 结构化信息。
 *
 * 背景：storyParsers 只 OCR PDF 前 8 张图（对象序、无页面锚定），图载信息
 * （地图/线索卡/信件）绝大多数进不了 rag/dossier 档案。本脚本验证方向 2：
 * 按页抽大图 → Vision LLM 读出 places/connections/transcript。
 *
 * 流程：
 *  1) pdf-lib 逐页枚举 Resources/XObject 图片（按页序、可按页码锚定）；
 *  2) 过滤：≥2KB、解码得 JPEG/PNG，每页取最大一张，全局再取 top N（默认 4）；
 *  3) 每张图调 mimo chat/completions（image_url data URI）→ JSON：
 *     { kind: 地图|线索文字图|插画|其他, places: [{name, note?}],
 *       connections: [{from, to, via?}], transcript? };
 *  4) 结果与图落盘 training/eval/vision/<story>/，供人工/程序对照。
 *
 * env：AB_AI_BASE_URL/AB_AI_API_KEY/AB_AI_MODEL(默认 mimo-v2.5)/OPENCODE_SESSION。
 * 用法：node scripts/eval/ab-vision-map.mjs --files="猫是我_20250723.pdf,巫_20220928_nocom.pdf"
 *   [--max-images=4] [--stories-dir="AI-COC-KP Story Document/stories"]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } from 'pdf-lib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const REAL = {
  baseUrl: process.env.AB_AI_BASE_URL ?? '',
  apiKey: process.env.AB_AI_API_KEY ?? '',
  model: process.env.AB_AI_MODEL ?? 'mimo-v2.5',
}
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const OUT_DIR = path.join(ROOT, 'training', 'eval', 'vision')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function callVision(imageB64, mime, pageNo, storyName, maxTokens = 2000) {
  const body = {
    model: REAL.model,
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            '你是跑团模组（COC）图像解析器。下面是一张出自剧本的图。请判断它的 kind 并结构化输出，只输出一个 JSON：\n' +
            '{ "kind": "地图" | "线索文字图" | "插画" | "其他",\n' +
            '  "places": [{ "name": "图中标注的地点/区域名（原文，无标注则省略该数组）", "note": "在图中的位置/特征（可省略）" }],\n' +
            '  "connections": [{ "from": "地点名", "to": "地点名", "via": "连接方式/路径标注，如道路/山路/门（可省略）" }],\n' +
            '  "transcript": "若图含文字（信件/便条/标题/说明文字），完整转录；无文字省略"\n' +
            '}\n' +
            '规则：地点名保留图上原文（日文地名写日文并括注中文译名）；connections 只写图上可见的连线/箭头/路径关系，不要推断图上没有的连接。',
        },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } },
      ],
    }],
  }
  const res = await fetch(`${REAL.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${REAL.apiKey}`,
      ...(process.env.OPENCODE_SESSION ? { 'x-opencode-session': process.env.OPENCODE_SESSION } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const content = (await res.json()).choices?.[0]?.message?.content ?? ''
  if (!content?.trim()) throw new Error('vision empty content (reasoning consumed budget)')
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`no JSON in vision output: ${content.slice(0, 200)}`)
  try { return JSON.parse(content.slice(start, end + 1)) } catch { throw new Error(`bad JSON: ${content.slice(0, 200)}`) }
}

/** JPEG/PNG 尺寸（从文件头解析，供地图候选过滤）。 */
function imgDims(b) {
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

/** 逐页抽图：每页至多 2 张最大、跨页去重、过滤小图/横幅条（地图候选）。 */
async function extractPageImages(pdfPath) {
  const buf = fs.readFileSync(pdfPath)
  if (buf.length > 60 * 1024 * 1024) return []
  const doc = await PDFDocument.load(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  const seen = new Set() // 相同字节内容跨页去重
  const hits = []
  const pages = doc.getPages()
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi]
    let res = page.node.get(PDFName.of('Resources'))
    res = res ? doc.context.lookup(res) : null
    if (!res) continue
    const xoRef = res.get(PDFName.of('XObject'))
    const xo = xoRef ? doc.context.lookup(xoRef) : null
    if (!xo || typeof xo.entries !== 'function') continue
    const pageImgs = []
    for (const [, ref] of xo.entries()) {
      const obj = doc.context.lookup(ref)
      if (!(obj instanceof PDFRawStream)) continue
      const subtype = doc.context.lookup(obj.dict.get(PDFName.of('Subtype')))
      if (!subtype || (subtype).encodedName !== '/Image') continue
      let bytes = Buffer.from(obj.getContents())
      const filterRef = obj.dict.get(PDFName.of('Filter'))
      if (filterRef) {
        const filter = doc.context.lookup(filterRef)
        const isDCT = filter && filter.encodedName === '/DCTDecode'
        if (!isDCT) {
          try {
            const decoded = decodePDFRawStream({ dict: obj.dict, contents: bytes })
            bytes = Buffer.from(decoded.getBytes())
          } catch { continue }
        }
      }
      if (bytes.length < 2 * 1024) continue // 装饰小图
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      if (!isJpeg && !isPng) continue
      const sig = `${bytes.length}:${bytes.subarray(0, 64).toString('hex')}`
      if (seen.has(sig)) continue // 同一图被多页复用
      seen.add(sig)
      const dims = imgDims(bytes) ?? { w: 0, h: 0 }
      pageImgs.push({ bytes, mime: isJpeg ? 'image/jpeg' : 'image/png', page: pi + 1, w: dims.w, h: dims.h })
    }
    pageImgs.sort((a, b) => b.bytes.length - a.bytes.length)
    hits.push(...pageImgs.slice(0, 2))
  }
  // 地图候选过滤：≥600×600 或 (最长边≥1000 且短边≥400)；排除高宽比>3.2 的横幅条
  const candidates = hits
    .filter((h) => h.w > 0 && h.h > 0)
    .filter((h) => (h.w >= 600 && h.h >= 600) || (Math.max(h.w, h.h) >= 1000 && Math.min(h.w, h.h) >= 400))
    .filter((h) => Math.max(h.w, h.h) / Math.min(h.w, h.h) <= 3.2)
    .sort((a, b) => b.w * b.h - a.w * a.h)
  return candidates
}

async function main() {
  const files = (arg('files', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const maxImages = Number(arg('max-images', '4'))
  if (!files.length) { console.error('--files=a.pdf,b.pdf required'); process.exit(1) }
  // 铁律：视觉只用 mimo-v2.5（-pro 不支持 image input，上游 404）
  if (!/^mimo-v2\.5$/.test(REAL.model)) {
    console.error(`model 必须是 mimo-v2.5（当前 ${REAL.model}）——mimo-v2.5-pro 不支持视觉，禁用`); process.exit(1)
  }
  if (arg('dry', '0') !== '1' && (!REAL.baseUrl || !REAL.apiKey)) { console.error('need AB_AI_BASE_URL + AB_AI_API_KEY'); process.exit(1) }
  const storiesDir = arg('stories-dir', path.join(ROOT, 'AI-COC-KP Story Document', 'stories'))
  const out = { model: REAL.model, startedAt: Date.now(), stories: {} }
  for (const f of files) {
    const pdfPath = path.join(storiesDir, f)
    if (!fs.existsSync(pdfPath)) { console.log(`[skip] ${f} not found`); continue }
    const key = f.replace(/\.pdf$/i, '')
    const storyOut = { file: f, images: [], vision: [] }
    out.stories[key] = storyOut
    const dir = path.join(OUT_DIR, key)
    fs.mkdirSync(dir, { recursive: true })
    // --pick：跳过抽取，直接 vision 已落盘图（dry-run 后人工选定地图用）
    const picks = (arg('pick', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
    let picked = []
    if (picks.length) {
      for (const p of picks) {
        const pth = path.join(dir, p)
        if (fs.existsSync(pth)) {
          const b = fs.readFileSync(pth)
          picked.push({ file: p, bytes: b, mime: p.endsWith('.png') ? 'image/png' : 'image/jpeg', page: Number((p.match(/p(\d+)/)?.[1] ?? '0')), w: 0, h: 0 })
        } else { console.log(`[warn] ${p} not in ${dir}`) }
      }
      if (!picked.length) continue
    } else {
      const hits = await extractPageImages(pdfPath)
      picked = hits.slice(0, maxImages).map((h, i) => ({ ...h, file: `p${String(h.page).padStart(3, '0')}_${i + 1}.${h.mime === 'image/jpeg' ? 'jpg' : 'png'}` }))
      console.log(`\n=== ${key} === 地图候选 ${hits.length}（过滤后），取 top ${picked.length}`)
      for (const h of hits.slice(0, Math.max(6, maxImages))) {
        console.log(`  [cand] p${h.page} ${h.w}×${h.h} ${Math.round(h.bytes.length / 1024)}KB`)
      }
      if (arg('dry', '0') === '1') {
        for (const h of picked) fs.writeFileSync(path.join(dir, h.file), h.bytes)
        console.log(`[dry] 候选图已存 ${dir}（未调 vision）`)
        continue
      }
    }
    for (const img of picked) {
      if (img.bytes.length > 3.5 * 1024 * 1024) { console.log(`  [skip] ${img.file} 图 ${(img.bytes.length / 1e6).toFixed(1)}MB 超限`); continue }
      if (!img.bytes.length) continue
      const fname = img.file
      if (!fs.existsSync(path.join(dir, fname))) fs.writeFileSync(path.join(dir, fname), img.bytes)
      storyOut.images.push({ file: fname, page: img.page, kb: Math.round(img.bytes.length / 1024) })
      let parsed = null
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        try {
          parsed = await callVision(img.bytes.toString('base64'), img.mime, img.page, key)
        } catch (e) {
          console.log(`  [retry] p${img.page} ${e.message?.slice(0, 120)}`)
          await sleep(4000)
        }
      }
      if (!parsed) { console.log(`  [fail] p${img.page} 两次调用失败`); storyOut.vision.push({ file: fname, error: 'after 2 attempts' }); continue }
      // 信息筛选：封面/插画/其他、无地点无连接的地图、过短转录 → 不入 annex 主体（仍记录供复核）
      const kind = parsed.kind ?? '其他'
      const places = parsed.places ?? []
      const conns = parsed.connections ?? []
      const transcript = String(parsed.transcript ?? '').trim()
      let kept = true
      let dropReason = ''
      if (kind === '插画' || kind === '其他') { kept = false; dropReason = `kind=${kind}（封面/美术/无关图不入 dossier）` }
      else if (kind === '地图' && places.length === 0 && conns.length === 0) { kept = false; dropReason = '无标签地图（places/connections 均空，不硬编）' }
      else if (transcript && transcript.length < 12) { kept = false; dropReason = '转录过短' }
      storyOut.vision.push({ file: fname, page: img.page, parsed, kept, dropReason: dropReason || undefined })
      const p = parsed.places ?? []
      const c = parsed.connections ?? []
      const tr = parsed.transcript ? `文字${parsed.transcript.length}字` : ''
      console.log(`  p${img.page} [${parsed.kind}] places=${p.length} conns=${c.length} ${tr}`)
      for (const pl of p.slice(0, 12)) console.log(`    · ${pl.name}${pl.note ? ' — ' + String(pl.note).slice(0, 40) : ''}`)
      for (const cn of c.slice(0, 8)) console.log(`    ↔ ${cn.from} → ${cn.to}${cn.via ? ` (${cn.via})` : ''}`)
    }
  }
  out.updatedAt = Date.now()
  fs.mkdirSync(path.join(ROOT, 'training', 'eval', 'reports'), { recursive: true })
  const outPath = path.join(ROOT, 'training', 'eval', 'reports', `ab-vision-${Date.now()}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nresults → ${outPath}`)
}
main().catch((e) => { console.error('fail:', e.message); process.exit(1) })
