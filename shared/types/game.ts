export type MessageRole = 'kp' | 'player' | 'system'

export interface BaseMessage {
  id: string
  timestamp: number
}

export interface KPMessage extends BaseMessage {
  role: 'kp'
  content: string
  isStreaming?: boolean
}

export interface PlayerMessage extends BaseMessage {
  role: 'player'
  playerName: string
  content: string
}

export interface SystemMessage extends BaseMessage {
  role: 'system'
  content: string
}

export interface DiceMessage extends BaseMessage {
  role: 'system'
  type: 'dice'
  content: string
  /** 骰子结构化事实（#79）。可选：环境伤害类（溺水/毒药/坠落/火焰）产 type:'dice' 无 result。 */
  result?: { skill?: string; roll: number; target?: number; outcome?: string }
}

export type Message = KPMessage | PlayerMessage | SystemMessage | DiceMessage
