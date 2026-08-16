// WeChat Mini Program automated smoke test via miniprogram-automator.
//
// 前置条件（详见 README「设备端测试」）：
//   1. 微信开发者工具以【管理员身份】启动（自动化端口 9420 才绑定），游客/测试号登录
//   2. 设置 → 安全设置 → 服务端口 开启
//   3. 导入本项目构建产物 client/dist/build/mp-weixin（AppID 选测试号）
//   4. npm i miniprogram-automator 后先运行 node patch-automator.mjs（兼容新版 IDE 的 Tool.getInfo 返回结构）
//
// 用法：node mp-test.mjs
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

const automator = (await import('miniprogram-automator')).default
let miniProgram

try {
  miniProgram = await automator.connect({ wsEndpoint: 'ws://localhost:9420', timeout: 15000 })
  check('连接开发者工具自动化 (connect)', true)

  // 1. 打开首页（reLaunch 返回 Page）
  const home = await miniProgram.reLaunch('/pages/home/index')
  await home.waitFor(1500)
  const views = await home.$$('view')
  const texts = await home.$$('text')
  const viewTexts = []
  for (const t of texts.slice(0, 12)) {
    const txt = await t.text().catch(() => '')
    if (txt) viewTexts.push(txt.trim())
  }
  check('首页渲染 (home 有 view/text 节点)', views.length > 0 && texts.length > 0, `view=${views.length} text=${texts.length}`)
  const joined = viewTexts.join('|')
  check('首页含应用关键文案', /COC|AI|KP|开始|剧本|设置|调查员/i.test(joined), joined.slice(0, 80) || '(无文本)')

  // 2. 首页按钮可点击性
  const buttons = await home.$$('button')
  check('首页含 button 组件', buttons.length > 0, `button=${buttons.length}`)

  // 3. 设置页（登录/配置表单）
  const setPage = await miniProgram.navigateTo('/pages/settings/index')
  await setPage.waitFor(1200)
  const inputs = await setPage.$$('input')
  const setTexts = []
  for (const t of (await setPage.$$('text')).slice(0, 15)) {
    const txt = await t.text().catch(() => '')
    if (txt) setTexts.push(txt.trim())
  }
  const setJoined = setTexts.join('|')
  check('设置页可打开且有表单输入框', inputs.length > 0, `input=${inputs.length}`)
  check('设置页含登录/配置相关文案', /登录|注册|AI|模型|API|配置/i.test(setJoined), setJoined.slice(0, 80) || '(无文本)')

  // 4. 返回首页
  await miniProgram.navigateBack()
  await new Promise((r) => setTimeout(r, 800))
  check('返回首页 (navigateBack)', true)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 小程序冒烟测试 ${failed.length === 0 ? '全部通过' : failed.length + ' 项失败'} (${results.length} 项) ===`)
  await miniProgram.close().catch(() => {})
  process.exit(failed.length === 0 ? 0 : 1)
} catch (e) {
  console.error('ERROR:', e.message)
  if (miniProgram) await miniProgram.close().catch(() => {})
  process.exit(2)
}
