/**
 * 文本文件下载（Task 8 新增，供 GameEndView / DebugPanel 导出使用）。
 * 原 Electron 渲染层用 Blob + <a download> 下载（DOM API，三端不可用）：
 *   - H5：Blob + 临时 <a> 点击下载（#ifdef H5）
 *   - mp-weixin / app：写入剪贴板 + toast（#ifndef H5，原生端无文件系统下载）
 */
export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  // #ifdef H5
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  // #endif
  // #ifndef H5
  try {
    uni.setClipboardData({
      data: content,
      success: () => uni.showToast({ title: `已复制 ${filename} 到剪贴板`, icon: 'none' }),
    })
  } catch {
    // 剪贴板不可用时静默
  }
  // #endif
}
