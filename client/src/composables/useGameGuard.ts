import { useGameStore } from '../stores/gameStore'

/**
 * 路由守卫语义封装（迁移自原 `router/index.ts` 的 beforeEach requiresGame 守卫）：
 * 仅当 gamePhase ∈ { 'playing', 'ended' } 且 characterSheet 存在时放行游戏页
 * （pages/game、pages/game-end），否则跳转首页（uni-app 无 vue-router，
 * 由 Task 8 页面在 onLoad/onShow 调用本 composable）。
 */
export function useGameGuard(): { checkGameAccess: () => boolean } {
  const gameStore = useGameStore()

  function checkGameAccess(): boolean {
    const okPhase = gameStore.gamePhase === 'playing' || gameStore.gamePhase === 'ended'
    if (okPhase && gameStore.characterSheet) return true
    // 原守卫：return { path: '/', replace: true }（vue-router）→ uni.reLaunch 首页
    try {
      uni.reLaunch({ url: '/pages/home/index' })
    } catch {
      // 测试环境或极端情况下导航失败不抛出 —— 调用方仍可依据返回值处理
    }
    return false
  }

  return { checkGameAccess }
}
