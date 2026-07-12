import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readConfigMock, safeReadFileMock } = vi.hoisted(() => ({ readConfigMock: vi.fn(), safeReadFileMock: vi.fn() }))
vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: readConfigMock,
  safeReadFile: safeReadFileMock,
  providerModelsUrl: (baseUrl: string) => {
    const base = baseUrl.replace(/\/+$/, '')
    return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => `/profiles/${profile}`,
}))

describe('reasoning capability live custom provider validation', () => {
  beforeEach(async () => {
    const { clearReasoningCapabilityCacheForTests } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    clearReasoningCapabilityCacheForTests()
    safeReadFileMock.mockResolvedValue('')
    readConfigMock.mockResolvedValue({
      custom_providers: [{
        name: 'gateway', base_url: 'https://gateway.invalid/v1', api_key: 'secret',
        model: 'gpt-5.6-sol', api_mode: 'chat_completions',
      }],
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses the authenticated live catalog and preserves the exact effort', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      expect(_url).toBe('https://gateway.invalid/v1/models')
      expect(init.headers.Authorization).toBe('Bearer secret')
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'default', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).resolves.toBe('max')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the standard /v1/models route when the configured base URL has no version suffix', async () => {
    readConfigMock.mockResolvedValue({
      custom_providers: [{
        name: 'gateway', base_url: 'https://gateway.invalid', api_key: 'secret',
        model: 'gpt-5.6-sol', api_mode: 'chat_completions',
      }],
    })
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://gateway.invalid/v1/models')
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'default', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).resolves.toBe('max')
  })

  it('resolves a standard custom provider key_env from the selected profile dotenv', async () => {
    readConfigMock.mockResolvedValue({
      custom_providers: [{
        name: 'gateway', base_url: 'https://gateway.invalid/v1', key_env: 'GATEWAY_KEY',
        model: 'gpt-5.6-sol', api_mode: 'chat_completions',
      }],
    })
    safeReadFileMock.mockResolvedValue('OTHER=x\nGATEWAY_KEY=from-profile-env\n')
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      expect(init.headers.Authorization).toBe('Bearer from-profile-env')
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'work', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).resolves.toBe('max')
    expect(safeReadFileMock).toHaveBeenCalledWith('/profiles/work/.env')
  })

  it('strips matching dotenv quotes from a selected-profile key_env value', async () => {
    readConfigMock.mockResolvedValue({
      custom_providers: [{
        name: 'gateway', base_url: 'https://gateway.invalid/v1', key_env: 'GATEWAY_KEY',
        model: 'gpt-5.6-sol', api_mode: 'chat_completions',
      }],
    })
    safeReadFileMock.mockResolvedValue('GATEWAY_KEY="quoted-profile-token"\n')
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      expect(init.headers.Authorization).toBe('Bearer quoted-profile-token')
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'work', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).resolves.toBe('max')
  })

  it('resolves a v12 provider by the same visible name key used by the Studio model catalog', async () => {
    readConfigMock.mockResolvedValue({
      providers: {
        'internal-dict-key': {
          name: 'Display Gateway', base_url: 'https://gateway.invalid/v1', api_key: 'secret',
          models: { 'gpt-5.6-sol': {} }, api_mode: 'chat_completions',
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }),
    })))
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'default', provider: 'custom:display-gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).resolves.toBe('max')
  })

  it('coalesces concurrent positive catalog probes for the same profile target', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await pending
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile, clearReasoningCapabilityCacheForTests } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    clearReasoningCapabilityCacheForTests()
    const input = {
      profile: 'default', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    }
    const first = validateReasoningEffortForProfile(input)
    const second = validateReasoningEffortForProfile(input)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    release()
    await expect(Promise.all([first, second])).resolves.toEqual(['max', 'max'])
    await expect(validateReasoningEffortForProfile(input)).resolves.toBe('max')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a positive capability across different provider credentials', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    const input = {
      profile: 'default', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    }
    await expect(validateReasoningEffortForProfile(input)).resolves.toBe('max')
    readConfigMock.mockResolvedValue({
      custom_providers: [{
        name: 'gateway', base_url: 'https://gateway.invalid/v1', api_key: 'rotated-secret',
        model: 'gpt-5.6-sol', api_mode: 'chat_completions',
      }],
    })
    await expect(validateReasoningEffortForProfile(input)).resolves.toBe('max')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]?.[1] as any)?.headers?.Authorization).toContain('rotated-secret')
  })

  it('fails closed before probing when the configured provider API mode differs from the exact tuple', async () => {
    readConfigMock.mockResolvedValue({
      custom_providers: [{
        name: 'gateway', base_url: 'https://gateway.invalid/v1', api_key: 'secret',
        model: 'gpt-5.6-sol', api_mode: 'codex_responses',
      }],
    })
    const fetchMock = vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { reasoning: true } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'default', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).rejects.toThrow(/reasoning_capability_unknown/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the authenticated catalog cannot prove reasoning support', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol', capabilities: { vision: true } }] }),
    })))
    const { validateReasoningEffortForProfile } = await import(
      '../../packages/server/src/services/reasoning-capability'
    )
    await expect(validateReasoningEffortForProfile({
      profile: 'default', provider: 'custom:gateway', model: 'gpt-5.6-sol',
      apiMode: 'chat_completions', reasoningEffort: 'max',
    })).rejects.toThrow(/reasoning_capability_unknown/)
  })
})
