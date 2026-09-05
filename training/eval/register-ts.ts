// 注册 .js → .ts resolve hook（见 lib/ts-resolve.ts）。
// CLI 入口：node --import training/eval/register-ts.ts <script.ts>
import { register } from 'node:module'
register('./lib/ts-resolve.ts', import.meta.url)
