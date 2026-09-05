/**
 * KP 数据导出器 CLI（T2，spec #36 / 票 #38）。
 *
 * 用法（training 工作区内）：
 *   npm run export -- --out kp-context.jsonl [--db server/data/ai-kp.db] [--room <id>...] [--save <id>...]
 *     [--no-rooms] [--no-orphan-wire] [--no-saves]
 *
 * IO 边界：--db / --out 相对路径分别解析到各自的允许根目录内，越界（../ 逃逸）
 * 一律拒绝——
 *   --db  根 = KP_EXPORT_DB_ROOT 环境变量，缺省仓库根（默认值即 server/data/ai-kp.db）；
 *   --out 根 = KP_EXPORT_OUT_ROOT 环境变量，缺省 training/out/（自动创建）。
 * 数据在别处（如 Kaggle 数据集目录）时，用环境变量声明根目录后照常使用。
 *
 * 输出 OpenAI messages + tools JSONL（每行 meta + messages + tools），meta 标注
 * 来源（wire=真实注入 / rebuilt=确定性重建）与离线重建限制（meta.caveats）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportKpContext, renderJsonl } from './exporter.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DB_ROOT = path.resolve(process.env.KP_EXPORT_DB_ROOT ?? REPO_ROOT)
const OUT_ROOT = path.resolve(process.env.KP_EXPORT_OUT_ROOT ?? path.join(REPO_ROOT, 'training', 'out'))

const USAGE = `用法: npm run export -- --out <file.jsonl> [--db <path>] [--room <id>...] [--save <id>...] [--no-rooms] [--no-orphan-wire] [--no-saves]
IO 根目录: --db ⊆ ${DB_ROOT}（KP_EXPORT_DB_ROOT 可改） / --out ⊆ ${OUT_ROOT}（KP_EXPORT_OUT_ROOT 可改）`

interface CliArgs {
  db: string
  out: string
  rooms: string[]
  saves: string[]
  includeRooms: boolean
  includeOrphanWire: boolean
  includeSaves: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    db: 'server/data/ai-kp.db',
    out: 'kp-context.jsonl',
    rooms: [],
    saves: [],
    includeRooms: true,
    includeOrphanWire: true,
    includeSaves: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 缺少参数值\n${USAGE}`)
      return v
    }
    switch (a) {
      case '--db': args.db = next(); break
      case '--out': args.out = next(); break
      case '--room': args.rooms.push(next()); break
      case '--save': args.saves.push(next()); break
      case '--no-rooms': args.includeRooms = false; break
      case '--no-orphan-wire': args.includeOrphanWire = false; break
      case '--no-saves': args.includeSaves = false; break
      case '--help': case '-h': throw new Error(USAGE)
      default: throw new Error(`未知参数: ${a}\n${USAGE}`)
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.db.includes('\0') || args.out.includes('\0')) throw new Error(`路径含非法字符\n${USAGE}`)

  // --db 边界：path.resolve(root, input) 后校验 target 仍在根内（含 ../ 逃逸拒绝）
  const dbPath = path.resolve(DB_ROOT, args.db)
  if (dbPath !== DB_ROOT && !dbPath.startsWith(DB_ROOT + path.sep)) {
    throw new Error(`--db 必须位于 ${DB_ROOT} 内，拒绝越界路径: ${args.db}`)
  }
  // --out 边界：同上
  const outPath = path.resolve(OUT_ROOT, args.out)
  if (outPath !== OUT_ROOT && !outPath.startsWith(OUT_ROOT + path.sep)) {
    throw new Error(`--out 必须位于 ${OUT_ROOT} 内，拒绝越界路径: ${args.out}`)
  }

  const result = exportKpContext({
    dbPath,
    roomIds: args.rooms,
    saveIds: args.saves,
    includeRooms: args.includeRooms,
    includeOrphanWire: args.includeOrphanWire,
    includeSaves: args.includeSaves,
  })

  const jsonl = renderJsonl(result.lines)
  if (jsonl) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, jsonl, 'utf-8')
  }

  console.log(`导出完成: ${result.stats.lines} 行 → ${jsonl ? outPath : '(空结果，未写文件)'}`)
  console.log(
    `  来源: room=${result.stats.rooms} orphan-wire=${result.stats.orphanWireRooms} save=${result.stats.saves}` +
      ` | wire=${result.stats.wire} rebuilt=${result.stats.rebuilt} opening=${result.stats.opening}`,
  )
  for (const w of result.warnings) console.warn(`  [警告] ${w}`)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
