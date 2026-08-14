import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { traceBus } from '../services/tracing'
import type { Trace, TraceEvent } from '../services/tracing'

/**
 * Task 7 决策（简报决策 5）：debugStore 保持事件源接口（emit 由页面/服务调用）。
 * KPTrace 数据源（服务端 WS trace 帧）不在本任务接线 —— 契约 §4 与 shared
 * KpStreamPayload 均未定义 trace 帧（Task 6 报告 concern 2），Bridge 按未知帧
 * 静默丢弃；具体 trace 接线留 Task 10/11 评估（需先补契约与 shared 类型）。
 */
export const useDebugStore = defineStore('debug', () => {
  const enabled = ref(false)
  const liveEvents = ref<TraceEvent[]>([])
  const maxLiveEvents = 200
  let unsubscribe: (() => void) | null = null

  function setEnabled(val: boolean) {
    enabled.value = val
    traceBus.enabled = val
    if (val && !unsubscribe) {
      unsubscribe = traceBus.subscribe((event) => {
        liveEvents.value.push(event)
        if (liveEvents.value.length > maxLiveEvents) {
          liveEvents.value = liveEvents.value.slice(-maxLiveEvents)
        }
      })
    } else if (!val && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }

  const traces = computed<readonly Trace[]>(() => traceBus.traceHistory)

  const latestTrace = computed<Trace | null>(() => {
    const history = traceBus.traceHistory
    return history.length > 0 ? history[history.length - 1] : null
  })

  const currentTrace = computed<Trace | null>(() => traceBus.currentTrace)

  function clearHistory() {
    traceBus.clearHistory()
    liveEvents.value = []
  }

  function exportTraces(): string {
    return JSON.stringify(traceBus.exportTraces(), null, 2)
  }

  return {
    enabled,
    liveEvents,
    traces,
    latestTrace,
    currentTrace,
    setEnabled,
    clearHistory,
    exportTraces,
  }
})
