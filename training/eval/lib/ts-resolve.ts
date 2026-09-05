/**
 * TypeScript resolve hook：把相对导入的 `.js` 后缀改写到 `.ts`（Node 24 原生
 * type stripping 不做该改写，而 server/shared 源码遵循 tsc ESM 的 `.js` 后缀
 * 风格）。评测/训练脚本由此直接复用 server 的提示词纯函数（kpPromptService）
 * 与 shared 的工具契约/校验规则，无需构建步骤、零 npm 依赖。
 *
 * 用法：node --import training/eval/register-ts.ts training/eval/run-eval.ts
 * 只在「默认解析失败」时兜底改写，非相对导入（npm 包）不受影响。
 */
import type { ResolveHookContext, NextResolve } from 'node:module'

export async function resolve(specifier: string, context: ResolveHookContext, next: NextResolve) {
  try {
    return await next(specifier, context)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return await next(specifier.slice(0, -3) + '.ts', context)
    }
    throw err
  }
}
