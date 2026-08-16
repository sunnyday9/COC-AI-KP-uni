// Patch miniprogram-automator for WeChat DevTools 2.02+ compatibility.
//
// 新版开发者工具的 Tool.getInfo 返回 { version } 而非旧版 { SDKVersion }，
// automator 0.12.1 的 checkVersion 会读取 undefined 并崩溃（且 2.02 版本号会让
// 旧比较器误判为旧版）。本脚本把 checkVersion 改为跳过版本校验（幂等，可重复执行）。
//
// 用法：cd <miniprogram-automator 安装目录> && node patch-automator.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(__dirname, 'node_modules', 'miniprogram-automator', 'out', 'MiniProgram.js')

if (!fs.existsSync(target)) {
  console.error(`未找到 ${target}，请先 npm i miniprogram-automator`)
  process.exit(1)
}

const src = fs.readFileSync(target, 'utf8')
const OLD = 'async checkVersion(){let t="";if(t=(await this.send("Tool.getInfo")).SDKVersion,'
const NEW = 'async checkVersion(){let t="2.7.3";if("dev"!==t&&'

if (!src.includes('Tool.getInfo').valueOf() || !src.includes(OLD)) {
  // 已修补或结构变化：确认跳过逻辑已存在
  if (src.includes('async checkVersion(){let t="2.7.3"')) {
    console.log('checkVersion 已修补，无需操作')
    process.exit(0)
  }
  console.error('未匹配到已知的 checkVersion 结构，请手动检查 ' + target)
  process.exit(1)
}

const patched = src.replace(OLD, NEW)
fs.writeFileSync(target, patched)
console.log('已修补 checkVersion（跳过版本校验）')
