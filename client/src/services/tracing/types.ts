export interface TraceEvent {
  id: string
  traceId: string
  spanName: string
  eventType: string
  timestamp: number
  data: Record<string, unknown>
}

export interface Span {
  name: string
  startTime: number
  endTime?: number
  events: TraceEvent[]
}

export interface Trace {
  id: string
  turnId: string
  startTime: number
  endTime?: number
  spans: Map<string, Span>
  /** Flattened event list for easy iteration */
  events: TraceEvent[]
}

export interface CharacterSnapshot {
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  san: number
  sanMax: number
  luck: number
  insanityState: string
  hasMajorWound: boolean
  isDying: boolean
  dailySanLoss: number
}

export interface TraceEventMap {
  // RAG retrieval span
  rag_query_sent: { query: string; scriptId?: string; topK: number }
  rag_context_received: { chunkCount: number; contextLength: number; hasGraphSummary: boolean; hasUserGraph: boolean }

  // Prompt assembly span
  system_prompt_built: {
    totalLength: number
    hasLongTermSummary: boolean
    longTermSummaryLength: number
    memoryEntries: number
    ragContextLength: number
    conversationWindowSize: number
  }

  // KP Agent span
  intent_classified: { intent: string; rawLLMOutput: string }
  agent_routed: { agentType: string; intent: string }
  tool_plan_created: { requiredTools: string[]; plan: string; stallLevel: number }
  llm_generate_start: { messageCount: number; agentType: string }
  llm_generate_end: { responseLength: number; hasToolCalls: boolean; toolCallCount: number; durationMs: number }
  validation_result: { result: string; hasSimulation: boolean; missingTools: string[]; retryCount: number }
  force_tools_invoked: { requiredTools: string[]; newToolCount: number }
  kp_agent_loop_iteration: { iteration: number; maxIterations: number; hasToolCalls: boolean }
  direct_chat_used: { reason: string }

  // Tool execution span
  tool_executed: { name: string; args: Record<string, unknown>; resultSummary: string; success: boolean; durationMs: number }

  // State update span
  character_snapshot: CharacterSnapshot
  character_delta: { field: string; before: unknown; after: unknown }
  memory_updated: { kpMemoryLength: number; newEntryPreview: string }
  scene_changed: { from: string; to: string }
  clue_added: { description: string }

  // Long-term summary span
  summary_triggered: { trigger: 'scene_change' | 'periodic'; playerTurnCount: number }
  summary_input: { recentMessagesLength: number; currentSummaryLength: number; ragContextLength: number; userGraphLength: number }
  summary_output: { newSummaryLength: number; newSummaryPreview: string }

  // Error events
  trace_error: { source: string; message: string; stack?: string }
}

export type TraceEventType = keyof TraceEventMap
