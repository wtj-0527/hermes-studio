import { describe, expect, it } from 'vitest'
import {
  assertReasoningEffortSupported,
  resolveReasoningCapabilityFromConfig,
} from '../../packages/server/src/services/reasoning-capability'

const config = {
  providers: {
    axonhub: {
      api_mode: 'codex_responses',
      models: {
        'gpt-5.6-sol': {
          supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        legacy: { context_length: 128000 },
      },
    },
  },
}

describe('reasoning capability', () => {
  it('resolves only explicit provider/model/apiMode metadata', () => {
    expect(resolveReasoningCapabilityFromConfig(config, {
      provider: 'axonhub', model: 'gpt-5.6-sol', apiMode: 'codex_responses',
    })).toEqual({ levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], source: 'profile_config' })
    expect(resolveReasoningCapabilityFromConfig(config, {
      provider: 'axonhub', model: 'gpt-5.6-sol', apiMode: 'chat_completions',
    })).toBeNull()
    expect(resolveReasoningCapabilityFromConfig(config, {
      provider: 'axonhub', model: 'legacy', apiMode: 'codex_responses',
    })).toBeNull()
    expect(resolveReasoningCapabilityFromConfig(config, {
      provider: 'axonhub', model: 'gpt-5.6', apiMode: 'codex_responses',
    })).toBeNull()
  })

  it('accepts an absent override without capability metadata', () => {
    expect(() => assertReasoningEffortSupported('', null, {
      provider: 'p', model: 'm', apiMode: 'responses',
    })).not.toThrow()
  })

  it('fails closed when an explicit effort has unknown capability', () => {
    expect(() => assertReasoningEffortSupported('max', null, {
      provider: 'p', model: 'm', apiMode: 'responses',
    })).toThrow(/reasoning_capability_unknown/)
  })

  it('fails closed when an explicit effort is unsupported and never downgrades it', () => {
    expect(() => assertReasoningEffortSupported('max', { levels: ['low', 'high'], source: 'profile_config' }, {
      provider: 'p', model: 'm', apiMode: 'responses',
    })).toThrow(/reasoning_effort_unsupported.*max/)
    expect(() => assertReasoningEffortSupported('high', { levels: ['low', 'high'], source: 'profile_config' }, {
      provider: 'p', model: 'm', apiMode: 'responses',
    })).not.toThrow()
  })

  it.each([
    [null], [3], [{}], [['high', 'MAX']], [['high', 'high']], [['']]],
  )('rejects malformed capability metadata: %j', (levels) => {
    const malformed = { providers: { p: { api_mode: 'responses', models: { m: { supported_reasoning_levels: levels } } } } }
    expect(() => resolveReasoningCapabilityFromConfig(malformed, {
      provider: 'p', model: 'm', apiMode: 'responses',
    })).toThrow(/supported_reasoning_levels/)
  })
})
