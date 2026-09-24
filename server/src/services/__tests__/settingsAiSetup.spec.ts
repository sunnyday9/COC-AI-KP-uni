import { describe, expect, it } from 'vitest'
import { getDb } from '../../db/index.js'
import { getAiSetupIssue } from '../settingsService.js'

let nextUserId = 88000

function saveAiConfig(ai: Record<string, unknown>): number {
  const userId = nextUserId++
  getDb().prepare('INSERT INTO settings (user_id, data) VALUES (?, ?)').run(userId, JSON.stringify({ ai }))
  return userId
}

describe('getAiSetupIssue', () => {
  it.each(['openai_chat', 'openai_responses'])('requires a key for the default %s endpoint', (protocol) => {
    const userId = saveAiConfig({ protocol, model: 'gpt-test', baseUrl: '', temperature: 0.7, maxTokens: 100 })
    expect(getAiSetupIssue(userId)).toContain('API Key')
  })

  it('recognizes the official OpenAI host despite host case and a trailing slash', () => {
    const userId = saveAiConfig({ protocol: 'openai_chat', model: 'gpt-test', baseUrl: 'https://API.OPENAI.COM/v1/', temperature: 0.7, maxTokens: 100 })
    expect(getAiSetupIssue(userId)).toContain('API Key')
  })

  it('allows a keyless custom OpenAI-compatible endpoint', () => {
    const userId = saveAiConfig({ protocol: 'openai_chat', model: 'local-model', baseUrl: 'https://llm-gateway.example/v1', temperature: 0.7, maxTokens: 100 })
    expect(getAiSetupIssue(userId)).toBeNull()
  })

  it('pauses before consuming an action when the configured endpoint is blocked', () => {
    const userId = saveAiConfig({ protocol: 'openai_chat', model: 'local-model', baseUrl: 'http://127.0.0.1:1234/v1', temperature: 0.7, maxTokens: 100 })
    expect(getAiSetupIssue(userId)).toContain('Base URL')
  })

  it('requires both a model and a key for a keyed protocol', () => {
    const missingModel = saveAiConfig({ protocol: 'anthropic_messages', model: '', baseUrl: '', temperature: 0.7, maxTokens: 100 })
    const missingKey = saveAiConfig({ protocol: 'anthropic_messages', model: 'claude-test', baseUrl: '', temperature: 0.7, maxTokens: 100 })
    expect(getAiSetupIssue(missingModel)).toContain('模型')
    expect(getAiSetupIssue(missingKey)).toContain('API Key')
  })
})
