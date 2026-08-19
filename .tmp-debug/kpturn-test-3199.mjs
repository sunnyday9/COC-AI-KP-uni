// 最小复现：注册用户 → WS kp:turn（侦查消息）→ 打印所有帧
import WebSocket from 'ws'

const BASE = 'http://localhost:3199'
const r = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'kpt_' + Date.now(), password: 'test-pass-123' }),
})
const auth = await r.json()
console.log('register:', r.status, auth.user ? 'ok' : JSON.stringify(auth).slice(0, 120))

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: auth.user.username, password: 'test-pass-123' }),
})
const loginJson = await login.json()
const token = loginJson.token
console.log('login ok, token len', token.length)

const ws = new WebSocket(`ws://localhost:3100/ws?token=${encodeURIComponent(token)}`)
const frames = []
ws.on('open', () => {
  console.log('ws open, sending kp:turn')
  ws.send(JSON.stringify({
    type: 'kp:turn',
    streamId: 't1',
    messages: [
      { role: 'system', content: '你是守秘人。' },
      { role: 'user', content: '我侦查一下书架。' },
    ],
    storyContext: null,
    characterSheet: {
      occupationId: 'judge', occupationName: '法官', playerName: '测试员',
      attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 60, luck: 50 },
      skills: { 'Spot Hidden': 65 }, derived: { hp: 10, hpMax: 10, mp: 6, mpMax: 6, san: 60, sanMax: 60 },
      dailySanLoss: 0, phobias: [], manias: [], hasMajorWound: false, isDying: false, weapons: [],
    },
  }))
})
ws.on('message', (d) => {
  const f = JSON.parse(d.toString())
  console.log('FRAME:', f.type, f.type === 'chunk' ? f.chunk.slice(0, 60) : f.type === 'end' ? `content=${(f.content||'').slice(0,80)} tools=${(f.toolCalls||[]).map(t=>t.name).join(',')} display=${(f.displayMessages||[]).length} deltas=${JSON.stringify(f.worldDeltas||{}).slice(0,100)}` : f.error || '')
  if (f.type === 'end' || f.type === 'error') { ws.close(); process.exit(0) }
})
ws.on('error', (e) => { console.log('WS ERROR', e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT 25s, frames:', frames.length); process.exit(2) }, 25000)
