/**
 * annex spec（P18 map annex，TDD）— 抽取 util（尺寸/去重/横幅）、铁律 2 筛选
 * 表、保守合并（精确/漂移/缺失/重复边/线索卡）、runAnnex 编排 + generateDossier
 * (annex:true) 集成（合成 PDF 上传 → 视觉 mock → 合并落盘 → annex 文件留档）。
 *
 * 合成 PDF：XObject Image 流直接装「PNG 文件字节(FlateDecode) / JPEG 字节
 * (DCTDecode)」——与真实模组 PDF 的内嵌方式一致（Vision 原型对真实语料验证过）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'annex-spec-'))
const tmpUploads = path.join(tmpRoot, 'uploads')
const tmpDossier = path.join(tmpRoot, 'dossiers')

vi.stubEnv('UPLOADS_DIR', tmpUploads)
vi.stubEnv('DOSSIER_DATA_DIR', tmpDossier)
vi.resetModules()

/* ═════════════ 合成图片 / PDF 构造 ═════════════ */

let rngSeed = 0x9e3779b9
function nextByte(): number {
  // xorshift32 → 确定性的伪随机字节（deflate 后尺寸 ≈ raw，排序可预测）
  rngSeed ^= rngSeed << 13
  rngSeed ^= rngSeed >>> 17
  rngSeed ^= rngSeed << 5
  return rngSeed & 0xff
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  t.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length)
  return out
}

/** 生成 RGB8 PNG 文件字节（噪声内容 → 体积 ≈ w*h*3，排序稳定）。 */
function makePng(w: number, h: number): Buffer {
  rngSeed = (w * 2654435761 + h * 40503 + 7) >>> 0 // 尺寸不同 → 内容不同
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : nextByte()
  const idat = zlib.deflateSync(raw, { level: 1 }) // 噪声内容 level1 快且尺寸≈raw（排序稳定）
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

/** 生成带 SOF0 头声明的「JPEG」字节（仅头部真实；内容不参与解码，≥2KB）。 */
function makeJpeg(w: number, h: number): Buffer {
  rngSeed = (w * 40503 + h * 2654435761 + 13) >>> 0
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
  ]
  const dim = Buffer.alloc(4)
  dim.writeUInt16BE(h, 0)
  dim.writeUInt16BE(w, 2)
  const tail = Buffer.alloc(2400)
  for (let i = 0; i < tail.length; i++) tail[i] = nextByte()
  return Buffer.concat([...parts, dim, tail])
}

interface PdfImageSpec {
  bytes: Buffer
  w: number
  h: number
  /** 'FlateDecode'（PNG 文件字节）或 'DCTDecode'（JPEG 字节）。 */
  filter: 'FlateDecode' | 'DCTDecode'
}

function imgDimsOf(bytes: Buffer): { w: number; h: number } {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  return isPng ? { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) } : { w: bytes.readUInt16BE(27), h: bytes.readUInt16BE(25) }
}

/** 手拼最小 PDF：每页一个 Image XObject（stream = 图文件字节 + Filter）。 */
function buildPdf(pages: { images: PdfImageSpec[] }[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = [0]
  let cursor = parts[0].length
  const objStart = (num: number) => {
    offsets[num] = cursor
  }
  const emit = (s: string | Buffer) => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s
    parts.push(b)
    cursor += b.length
  }
  const streamObj = (num: number, dictPrefix: string, data: Buffer | null) => {
    if (data) {
      emit(`${num} 0 obj\n${dictPrefix} /Length ${data.length} >>\nstream\n`)
      parts.push(data)
      cursor += data.length
      emit('\nendstream\nendobj\n')
    } else {
      emit(`${num} 0 obj\n${dictPrefix} /Length 0 >>\nstream\nendstream\nendobj\n`)
    }
  }
  const pageObjs = pages.map((_, i) => 3 + i)
  objStart(1)
  emit('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  objStart(2)
  emit(`2 0 obj\n<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`)
  let imgNum = 3 + pages.length
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi]
    objStart(pageObjs[pi])
    const xo = pg.images.map((_, ii) => `/Im${ii} ${imgNum + ii} 0 R`).join(' ')
    const contents = imgNum + pg.images.length
    emit(
      `${pageObjs[pi]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << ${xo} >> >> /Contents ${contents} 0 R >>\nendobj\n`,
    )
    for (const im of pg.images) {
      objStart(imgNum)
      const w = im.w || imgDimsOf(im.bytes).w
      const h = im.h || imgDimsOf(im.bytes).h
      streamObj(imgNum, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${im.filter}`, im.bytes)
      imgNum++
    }
    objStart(contents)
    streamObj(contents, '<<', null)
    imgNum++
  }
  const size = imgNum
  const xrefStart = cursor
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let i = 1; i < size; i++) xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`
  emit(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`)
  return Buffer.concat(parts)
}

/* ═════════════ 视觉 / 档案 mock ═════════════ */

// 视觉 fixture 顺序 = 候选按面积降序（构建时保证面积严格递减）
const visionFixtures: Record<string, unknown>[] = [
  // p3 插画（面积最大 → 第一个被调用）
  { kind: '插画', places: [{ name: '封面标题' }] },
  // p5 标注地图：4 精确命中 + 1 漂移 + 1 缺失；1 条可并边 + 1 条重复边 + 1 条端点缺失边
  {
    kind: '地图',
    places: [
      { name: '办公楼', note: '二层' },
      { name: '温室展厅' },
      { name: '休息区域' },
      { name: '露营区域' },
      { name: '露营营地', note: '东北角' },
      { name: '山崖', note: '北侧' },
      { name: '森林' },
      { name: '废弃房屋' },
    ],
    connections: [
      { from: '办公楼', to: '温室展厅', via: '走廊' },
      { from: '露营营地', to: '山崖', via: '小径' },
      { from: '森林', to: '废弃房屋' },
      { from: '森林', to: '废弃房屋' }, // 同一张图内重复
    ],
    transcript: '大泽岛露营地图（标注北侧山崖与林间小径）',
  },
  // p8 线索文字图（国民证 → 追加 clue）
  { kind: '线索文字图', transcript: '田代島にゃんこ共和国国民証 氏名：島之江真子 身長：163cm …以上內容屬實，特此證明。' },
  // p9 无标签地图（无地点无连接 → drop）
  { kind: '地图', places: [], connections: [], transcript: '平面图（无标注）' },
  // p10 过短转录（<12 字符 → drop）
  { kind: '线索文字图', transcript: '好的' },
]

const dossierFixture = {
  scriptId: '',
  storyName: '测试剧本',
  scenes: [
    { id: 'sc_a', name: '办公楼', sceneText: '办公楼内景描述。', description: '' },
    { id: 'sc_b', name: '温室展厅', sceneText: '温室展厅描述。', description: '' },
    { id: 'sc_c', name: '休息区域', sceneText: '休息区域描述。', description: '' },
    { id: 'sc_d', name: '森林', sceneText: '森林描述。', description: '' },
    { id: 'sc_e', name: '废弃房屋', sceneText: '废弃房屋描述。', description: '' },
    { id: 'sc_f', name: '露营区域', sceneText: '露营区域描述。', description: '' },
  ],
  clues: [],
  npcs: [],
  transitions: [{ id: 't1', from: 'sc_d', to: 'sc_e', condition: '穿过林间小径' }],
}

let visionCallCount = 0
vi.mock('../../../services/aiService.js', () => ({
  chatForRag: vi.fn(async (_userId: number, { messages }: { messages: { content: unknown }[] }) => {
    const content = messages[0]?.content
    if (Array.isArray(content)) {
      // 视觉消息（content 数组）→ 按序返回 fixture
      const fixture = visionFixtures[visionCallCount % visionFixtures.length]
      visionCallCount++
      return { content: JSON.stringify(fixture) }
    }
    return { content: JSON.stringify(dossierFixture) }
  }),
}))

// storyService 保持真实实现，只把 readStoryForRag 换掉（合成 PDF 无文本）
vi.mock('../../../services/storyService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/storyService.js')>()
  return {
    ...actual,
    readStoryForRag: vi.fn(async () => ({ name: 'synthetic.pdf', content: '这是测试剧本的抽取文本。'.repeat(60) })),
  }
})

const {
  generateDossier,
  loadDossier,
  deleteDossier,
} = await import('../storyDossierService.js')
const {
  assertVisionModel,
  parseVisionJson,
  classifyAnnexImage,
  imgDims,
  extractPdfImageCandidates,
  matchAnnexPlace,
  mergeAnnexIntoDossier,
  runAnnex,
  persistAnnex,
  loadAnnex,
} = await import('../annex.js')
import type { AnnexImageRecord } from '../annex.js'
const { importStory } = await import('../../../services/storyService.js')
const { chatForRag } = await import('../../../services/aiService.js')

beforeEach(() => {
  visionCallCount = 0
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

function mkScene(name: string): { id: string; name: string; sceneText: string } {
  return { id: `id_${name}`, name, sceneText: `${name} 的现场描述文字。` }
}

/* ═════════════ 模型守卫 ═════════════ */

describe('annex: 视觉模型守卫（铁律 1）', () => {
  it('mimo-v2.5 放行；缺省回落 mimo-v2.5', () => {
    expect(assertVisionModel('mimo-v2.5')).toBe('mimo-v2.5')
    expect(assertVisionModel(undefined)).toBe('mimo-v2.5')
  })
  it('-pro 及其余模型拒绝（mimo-v2.5-pro 上游 404，无 image input）', () => {
    expect(() => assertVisionModel('mimo-v2.5-pro')).toThrow(/mimo-v2\.5/)
    expect(() => assertVisionModel('gpt-4o')).toThrow()
  })
})

/* ═════════════ 解析 + 铁律 2 筛选表 ═════════════ */

describe('annex: parseVisionJson', () => {
  it('提取 JSON（容忍围栏/散文前后缀），字段防御性归一', () => {
    const p = parseVisionJson('```json\n{"kind":"地图","places":[{"name":"山崖"}],"connections":[{"from":"A","to":"B"}],"transcript":"x"}\n```')
    expect(p?.kind).toBe('地图')
    expect(p?.places?.[0]?.name).toBe('山崖')
    expect(p?.connections?.[0]?.to).toBe('B')
    const bad = parseVisionJson('完全没有 json')
    expect(bad).toBeNull()
    expect(parseVisionJson('')).toBeNull()
    // 坏字段丢弃（places 非对象 / name 缺失）
    const dirty = parseVisionJson('{"kind":"地图","places":[null,{"note":"x"},"str"],"connections":[{"from":"A"}]}')
    expect(dirty?.places ?? []).toHaveLength(0)
    expect(dirty?.connections ?? []).toHaveLength(0)
  })
})

describe('annex: 铁律 2 信息筛选表', () => {
  const img = (over: Record<string, unknown>): AnnexImageRecord => ({
    page: 1,
    kind: '地图',
    places: [{ name: '山崖' }],
    connections: [],
    transcript: '超过十二字符的转录文本',
    kept: true,
    ...over,
  } as AnnexImageRecord)

  it('封面/插画/其他 → drop（不入 dossier）', () => {
    for (const kind of ['插画', '其他']) {
      const r = classifyAnnexImage({ kind })
      expect(r.kept).toBe(false)
      expect(r.dropReason).toContain(kind)
    }
  })
  it('无地点无连接的无标签地图 → drop', () => {
    const r = classifyAnnexImage({ kind: '地图', places: [], connections: [] })
    expect(r.kept).toBe(false)
    expect(r.dropReason).toContain('无标签')
  })
  it('过短转录（<12 字符）→ drop', () => {
    const r = classifyAnnexImage({ kind: '线索文字图', transcript: '短' })
    expect(r.kept).toBe(false)
    expect(r.dropReason).toContain('转录过短')
  })
  it('正常标注地图 / 长转录线索卡 → 保留', () => {
    expect(classifyAnnexImage({ kind: '地图', places: [{ name: '山崖' }], connections: [{ from: 'A', to: 'B' }] }).kept).toBe(true)
    expect(classifyAnnexImage({ kind: '线索文字图', transcript: '足够长的完整转录文字内容' }).kept).toBe(true)
  })
  it('无转录的线索文字图也保留（kept 语义 = 不入筛选黑名单）', () => {
    const r = classifyAnnexImage({ kind: '线索文字图' })
    expect(r.kept).toBe(true)
  })
})

/* ═════════════ 抽图 util（合成 PDF） ═════════════ */

describe('annex: imgDims', () => {
  it('JPEG SOF 头与 PNG IHDR 尺寸解析', () => {
    const j = makeJpeg(1234, 567)
    expect(imgDims(j)).toEqual({ w: 1234, h: 567 })
    const p = makePng(640, 480)
    expect(imgDims(p)).toEqual({ w: 640, h: 480 })
    expect(imgDims(Buffer.from([1, 2, 3]))).toBeNull()
  })
})

describe('annex: extractPdfImageCandidates 抽图规则', () => {
  it('尺寸过滤：600×600 入、小图出；长边≥1000 且短边≥400 入；横幅条（宽高比>3.2）出', async () => {
    // 每页≤2 张（先按页取最大、再整体尺寸过滤——与真实管线同序）
    const pdf = buildPdf([
      {
        images: [
          { bytes: makePng(600, 600), w: 600, h: 600, filter: 'FlateDecode' }, // 入
          { bytes: makePng(400, 300), w: 400, h: 300, filter: 'FlateDecode' }, // 出（太小）
        ],
      },
      {
        images: [
          { bytes: makePng(1200, 500), w: 1200, h: 500, filter: 'FlateDecode' }, // 入（长边≥1000 短边≥400）
          { bytes: makeJpeg(1300, 300), w: 1300, h: 300, filter: 'DCTDecode' }, // 出（短边 300）
        ],
      },
      {
        images: [{ bytes: makePng(2000, 600), w: 2000, h: 600, filter: 'FlateDecode' }], // 出（宽高比 3.33 > 3.2）
      },
    ])
    const hits = await extractPdfImageCandidates(pdf)
    const dims = hits.map((h) => `${h.w}x${h.h}`)
    expect(dims).toContain('600x600')
    expect(dims).toContain('1200x500')
    expect(dims).not.toContain('400x300')
    expect(dims).not.toContain('1300x300')
    expect(dims).not.toContain('2000x600')
    expect(hits).toHaveLength(2)
  })

  it('每页至多 2 张最大（按字节）；<2KB 装饰小图跳过', async () => {
    const pdf = buildPdf([
      {
        images: [
          { bytes: makePng(700, 700), w: 700, h: 700, filter: 'FlateDecode' },
          { bytes: makePng(660, 660), w: 660, h: 660, filter: 'FlateDecode' },
          { bytes: makePng(900, 900), w: 900, h: 900, filter: 'FlateDecode' }, // 最大 → 必须入选
        ],
      },
      { images: [{ bytes: makePng(20, 20), w: 20, h: 20, filter: 'FlateDecode' }] }, // <2KB 跳过
    ])
    const hits = await extractPdfImageCandidates(pdf)
    const pages = hits.map((h) => h.page)
    expect(pages).toEqual([1, 1])
    expect(hits.some((h) => h.w === 900)).toBe(true)
    expect(hits.some((h) => h.w === 700)).toBe(true)
  })

  it('跨页字节去重：同图多页复用只算一次', async () => {
    const shared = makePng(640, 640)
    const pdf = buildPdf([
      { images: [{ bytes: shared, w: 640, h: 640, filter: 'FlateDecode' }] },
      { images: [{ bytes: shared, w: 640, h: 640, filter: 'FlateDecode' }] }, // 同字节 → 去重
      { images: [{ bytes: makePng(650, 650), w: 650, h: 650, filter: 'FlateDecode' }] },
    ])
    const hits = await extractPdfImageCandidates(pdf)
    expect(hits).toHaveLength(2)
    expect(new Set(hits.map((h) => h.page))).toEqual(new Set([1, 3]))
  })

  it('非 PNG/JPEG 内容流跳过（未知格式不入候选）', async () => {
    const garbage = Buffer.from(zlib.deflateSync(Buffer.alloc(4000, 7)))
    const pdf = buildPdf([
      {
        images: [
          { bytes: makePng(700, 700), w: 700, h: 700, filter: 'FlateDecode' },
          { bytes: garbage, w: 700, h: 700, filter: 'FlateDecode' }, // flate 解出非图字节 → 跳过
        ],
      },
    ])
    const hits = await extractPdfImageCandidates(pdf)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.mime).toBe('image/png')
  })
})

/* ═════════════ 地点匹配 + 保守合并 ═════════════ */

describe('annex: matchAnnexPlace', () => {
  const scenes = ['办公楼', '露营区域', '休息区域', '旧图书馆'].map(mkScene)

  it('精确命中（trim/大小写无关）', () => {
    expect(matchAnnexPlace(scenes, '办公楼').hit).toBe('exact')
    expect(matchAnnexPlace(scenes, ' 休息区域 ').hit).toBe('exact')
  })
  it('命名漂移：互相包含 / 剥通用词同名 / 共享词根 → drift（不自动合并）', () => {
    expect(matchAnnexPlace(scenes, '图书馆').hit).toBe('drift') // ⊂ 旧图书馆
    expect(matchAnnexPlace(scenes, '露营营地').hit).toBe('drift') // 与露营区域共享「露营」
    const sc = matchAnnexPlace(scenes, '露营营地')
    if (sc.hit === 'drift') expect(sc.note).toContain('露营区域')
  })
  it('无对应 → unmatched（不建场景）', () => {
    const m = matchAnnexPlace(scenes, '山崖')
    expect(m.hit).toBe('unmatched')
  })
})

describe('annex: mergeAnnexIntoDossier 保守合并', () => {
  const baseDossier = {
    scriptId: 's',
    storyName: 's',
    generatedAt: 0,
    scenes: ['办公楼', '温室展厅', '森林', '废弃房屋', '露营区域'].map(mkScene),
    clues: [{ id: 'clue_0', description: '现有线索。' }],
    npcs: [{ id: 'n1', name: '某人', description: '' }],
    transitions: [{ id: 't1', from: 'id_森林', to: 'id_废弃房屋', condition: '穿过林间小径' }],
  }

  it('精确命中记 alias；漂移/未匹配进 pending；不新建场景/真相/结局', () => {
    const kept: AnnexImageRecord[] = [
      {
        page: 5,
        kind: '地图',
        kept: true,
        places: [{ name: '办公楼' }, { name: '露营营地' }, { name: '山崖' }],
        connections: [],
      },
    ]
    const { dossier, pending, merged } = mergeAnnexIntoDossier(baseDossier as never, kept)
    expect(dossier.scenes).toHaveLength(baseDossier.scenes.length)
    expect(pending.map((p) => `${p.type}:${p.name}`)).toEqual(['name-drift:露营营地', 'unmatched-place:山崖'])
    expect(merged.filter((m) => m.type === 'alias')).toHaveLength(1)
    expect(merged[0]?.detail).toContain('办公楼')
    expect(pending[0]?.note).toContain('露营区域')
  })

  it('connections：两端都解析 → 并入 tr_map_（condition=地图标注）；任一端 pending 不并；现有边去重', () => {
    const kept: AnnexImageRecord[] = [
      {
        page: 5,
        kind: '地图',
        kept: true,
        places: [{ name: '办公楼' }, { name: '温室展厅' }, { name: '森林' }, { name: '废弃房屋' }, { name: '露营营地' }, { name: '山崖' }],
        connections: [
          { from: '办公楼', to: '温室展厅' }, // 并入
          { from: '森林', to: '废弃房屋' }, // 与现有 t1 重复 → 跳过
          { from: '森林', to: '废弃房屋' }, // 同图重复 → 跳过
          { from: '露营营地', to: '山崖' }, // 端点 pending → 跳过
        ],
      },
    ]
    const { dossier, pending, merged } = mergeAnnexIntoDossier(baseDossier as never, kept)
    expect(pending).toHaveLength(2)
    const trs = dossier.transitions ?? []
    expect(trs).toHaveLength(2)
    const added = trs.find((t) => t.id === 'tr_map_1')
    expect(added).toMatchObject({ from: 'id_办公楼', to: 'id_温室展厅', condition: '地图标注' })
    expect(merged.some((m) => m.type === 'transition' && m.detail.includes('办公楼 → 温室展厅'))).toBe(true)
  })

  it('线索卡转录 → clue_map_* 追加（location=附图 第N页）；同页重复转录跳过；地图转录不追加', () => {
    const kept: AnnexImageRecord[] = [
      {
        page: 8,
        kind: '线索文字图',
        kept: true,
        places: [],
        connections: [],
        transcript: '田代島にゃんこ共和国国民証 氏名：島之江真子 …',
      },
      {
        page: 8,
        kind: '线索文字图',
        kept: true,
        places: [],
        connections: [],
        transcript: '田代島にゃんこ共和国国民証 氏名：島之江真子 …', // 同页同文 → 描述相同 → 跳过
      },
      {
        page: 10,
        kind: '地图',
        kept: true,
        places: [{ name: '办公楼' }],
        connections: [],
        transcript: '地图标题：大泽岛', // 地图的转录不当线索卡
      },
    ]
    const { dossier, merged } = mergeAnnexIntoDossier(baseDossier as never, kept)
    const clues = dossier.clues ?? []
    expect(clues).toHaveLength(2)
    const added = clues.find((c) => c.id === 'clue_map_1')
    expect(added?.description).toContain('【线索卡·第8页】')
    expect(added?.location).toBe('附图 第8页')
    expect(merged.filter((m) => m.type === 'card')).toHaveLength(1)
  })

  it('与既有 clue_map_* 编号不撞（前缀计数）', () => {
    const dossier = {
      ...baseDossier,
      clues: [
        { id: 'clue_0', description: '现有线索。' },
        { id: 'clue_map_1', description: '旧线索卡转录。' },
      ],
    }
    const kept: AnnexImageRecord[] = [
      { page: 8, kind: '线索文字图', kept: true, places: [], connections: [], transcript: '一张全新的线索卡转录内容，足够长。' },
    ]
    const { dossier: out } = mergeAnnexIntoDossier(dossier as never, kept)
    expect((out.clues ?? []).some((c) => c.id === 'clue_map_2')).toBe(true)
  })
})

/* ═════════════ runAnnex / generateDossier 集成 ═════════════ */

describe('annex: runAnnex + generateDossier(annex:true) 集成', () => {
  let userId = 1
  let uploadsDir: string

  beforeEach(async () => {
    userId = 1
    uploadsDir = path.join(tmpUploads, String(userId), 'stories')
    await fs.mkdir(uploadsDir, { recursive: true })
  })

  async function upload(name: string, bytes: Buffer): Promise<string> {
    const up = await importStory(userId, { originalname: name, buffer: bytes, size: bytes.length })
    expect(up.ok).toBe(true)
    return up.id as string
  }

  it('txt（无图）→ annex 空、流程不崩、计数 0、留档 note', async () => {
    const scriptId = await upload('demo-story.txt', Buffer.from('无图故事文本。'))
    const res = await generateDossier(userId, scriptId, { annex: true })
    expect(res.ok).toBe(true)
    expect(res.annexImages).toBe(0)
    expect(res.annexDrops).toBe(0)
    expect(res.annexFailed).toBe(0)
    expect(res.annexPending).toBe(0)
    // 只跑了档案文本生成（annex txt 不调视觉）
    expect(visionCallCount).toBe(0)
    const annex = await loadAnnex(userId, scriptId)
    expect(annex).not.toBeNull()
    expect(annex?.note).toContain('非 PDF')
    const dossier = await loadDossier(userId, scriptId)
    expect(dossier?.annex).toMatchObject({ images: 0, drops: 0, failed: 0, pending: 0 })
    await deleteDossier(userId, scriptId)
    expect(await loadAnnex(userId, scriptId)).toBeNull()
  })

  it('PDF：抽图→视觉→筛选→保守合并→dossier 落盘 + annex 明细留档', async () => {
    // 页面布局：p3 插画 / p5 标注地图 / p8 线索卡 / p9 无标签地图 / p10 过短转录
    // （噪声 PNG 体积≈w*h*3，控制在单图 3.5MB 上限内；面积严格递减 → 候选序稳定）
    const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => {
      if (p === 3) return { images: [{ bytes: makePng(1050, 950), w: 1050, h: 950, filter: 'FlateDecode' as const }] }
      if (p === 5) return { images: [{ bytes: makePng(1020, 900), w: 1020, h: 900, filter: 'FlateDecode' as const }] }
      if (p === 8) return { images: [{ bytes: makePng(980, 850), w: 980, h: 850, filter: 'FlateDecode' as const }] }
      if (p === 9) return { images: [{ bytes: makePng(940, 700), w: 940, h: 700, filter: 'FlateDecode' as const }] }
      if (p === 10) return { images: [{ bytes: makeJpeg(900, 600), w: 900, h: 600, filter: 'DCTDecode' as const }] }
      return { images: [] }
    })
    const pdfBytes = buildPdf(pages)
    const scriptId = await upload('map-cards.pdf', pdfBytes)

    const res = await generateDossier(userId, scriptId, { annex: true })
    expect(res.ok).toBe(true)
    // 5 张候选全部 vision 成功：2 kept / 3 drop；pending 2（漂移 露营营地 + 未匹配 山崖）
    expect(visionCallCount).toBe(5)
    expect(res.annexImages).toBe(2)
    expect(res.annexDrops).toBe(3)
    expect(res.annexFailed).toBe(0)
    expect(res.annexPending).toBe(2)
    expect(res.annexTransitions).toBe(1)
    expect(res.annexClues).toBe(1)

    // dossier：transitions 并入 tr_map_1（与 t1 重复的边被去重）、clues 追加 clue_map_1
    const dossier = await loadDossier(userId, scriptId)
    expect(dossier).not.toBeNull()
    expect(dossier?.scenes).toHaveLength(6)
    expect(dossier?.transitions).toHaveLength(2)
    expect(dossier?.transitions?.find((t) => t.id === 'tr_map_1')).toMatchObject({
      from: 'sc_a',
      to: 'sc_b',
      condition: '地图标注',
    })
    expect(dossier?.transitions?.find((t) => t.id === 't1')?.from).toBe('sc_d')
    const mapClue = dossier?.clues?.find((c) => c.id === 'clue_map_1')
    expect(mapClue?.description).toContain('【线索卡·第8页】')
    expect(mapClue?.location).toBe('附图 第8页')
    expect(dossier?.annex).toMatchObject({ images: 2, drops: 3, pending: 2, transitions: 1, clues: 1 })

    // annex 明细：kept/dropReason 全留档（铁律 2）
    const annex = await loadAnnex(userId, scriptId)
    expect(annex?.images).toHaveLength(5)
    const byKind = new Map(annex?.images.map((i) => [i.kind, i]) ?? [])
    expect(byKind.get('插画')?.kept).toBe(false)
    expect(byKind.get('插画')?.dropReason).toContain('kind=插画')
    expect(byKind.get('地图')?.kept).toBe(false) // p9 无标签
    const cardDropped = annex?.images.find((i) => i.transcript === '好的')
    expect(cardDropped?.dropReason).toBe('转录过短')
    const mapKept = annex?.images.find((i) => i.kind === '地图' && i.kept)
    expect(mapKept?.places).toHaveLength(8)
    expect(annex?.pending.map((p) => p.name).sort()).toEqual(['山崖', '露营营地'])
    expect(annex?.pending.find((p) => p.name === '露营营地')?.type).toBe('name-drift')
    expect(annex?.pending.find((p) => p.name === '山崖')?.type).toBe('unmatched-place')
    expect(annex?.merged.filter((m) => m.type === 'transition')).toHaveLength(1)
    expect(annex?.merged.filter((m) => m.type === 'card')).toHaveLength(1)

    // deleteDossier 同时清 annex 文件
    await deleteDossier(userId, scriptId)
    expect(await loadDossier(userId, scriptId)).toBeNull()
    expect(await loadAnnex(userId, scriptId)).toBeNull()
  })

  it('annex 守卫失败（-pro 模型）→ 降级告警不阻断档案生成', async () => {
    const scriptId = await upload('demo-story.txt', Buffer.from('无图故事文本。'))
    const res = await generateDossier(userId, scriptId, { annex: true, model: 'mimo-v2.5-pro' })
    expect(res.ok).toBe(true)
    expect(res.annexImages).toBeUndefined()
    expect(res.warnings?.some((w) => w.includes('annex 未运行'))).toBe(true)
  })

  it('runAnnex 直调（txt）：dossier 带 annex 摘要；persistAnnex 往返', async () => {
    const scriptId = await upload('plain.txt', Buffer.from('纯文本'))
    const { dossier, annex } = await runAnnex(userId, {
      scriptId,
      storyName: '纯文本故事',
      dossier: { scriptId, storyName: '纯文本故事', generatedAt: 0, scenes: [mkScene('场景甲')], clues: [], npcs: [] } as never,
    })
    expect(annex.note).toContain('非 PDF')
    expect(dossier.annex).toMatchObject({ images: 0, drops: 0, failed: 0, pending: 0 })
    await persistAnnex(userId, annex)
    const loaded = await loadAnnex(userId, scriptId)
    expect(loaded?.scriptId).toBe(scriptId)
  })
})
