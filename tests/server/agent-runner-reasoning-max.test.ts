import { describe, expect, it } from 'vitest'

import {
  anthropicToOpenAiChat,
  anthropicToOpenAiResponses,
  targetReasoningEffort as targetAnthropicReasoningEffort,
} from '../../packages/server/src/services/agent-runner/adapters/anthropic'
import {
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
  targetReasoningEffort as targetResponsesReasoningEffort,
} from '../../packages/server/src/services/agent-runner/adapters/responses'

const anthropicTarget = {
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: 'https://example.invalid',
  reasoningEffort: 'max',
}

const responsesTarget = {
  model: 'test-model',
  reasoningEffort: 'max',
}

describe('coding-agent proxy reasoning effort', () => {
  it('accepts max for Anthropic-protocol proxy targets', () => {
    expect(targetAnthropicReasoningEffort(anthropicTarget)).toBe('max')
  })

  it('forwards max from Anthropic protocol to the OpenAI Chat payload', () => {
    expect(anthropicToOpenAiChat({ messages: [] }, anthropicTarget)).toMatchObject({
      reasoning_effort: 'max',
    })
  })

  it('forwards max from Anthropic protocol to the OpenAI Responses payload', () => {
    expect(anthropicToOpenAiResponses({ messages: [] }, anthropicTarget)).toMatchObject({
      reasoning: { effort: 'max' },
    })
  })

  it('accepts max for Responses-protocol proxy targets', () => {
    expect(targetResponsesReasoningEffort(responsesTarget)).toBe('max')
  })

  it('forwards max from Responses protocol to the OpenAI Chat payload', () => {
    expect(responsesToOpenAiChat({ input: [] }, responsesTarget)).toMatchObject({
      reasoning_effort: 'max',
    })
  })

  it('forwards max from Responses protocol to the Anthropic payload', () => {
    expect(responsesToAnthropicMessages({ input: [] }, responsesTarget)).toMatchObject({
      reasoning_effort: 'max',
    })
  })
})
