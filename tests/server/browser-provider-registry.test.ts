import { describe, expect, it, vi } from 'vitest'
import {
  BrowserProviderRegistry,
  type BrowserControlProvider,
} from '../../packages/server/src/services/browser/provider-registry'

const owner = { userId: 7, profile: 'work' }

function provider(
  id: string,
  kind: 'electron' | 'remote',
  available = true,
): BrowserControlProvider & { agentRequest: ReturnType<typeof vi.fn> } {
  return {
    id,
    kind,
    label: kind === 'electron' ? 'Electron' : 'Managed',
    capabilities: {
      tabs: true,
      navigation: true,
      snapshot: true,
      interaction: true,
      screenshot: true,
      console: true,
      liveView: true,
      takeover: true,
      profiles: true,
      downloads: true,
      annotations: true,
      htmlPreview: true,
    },
    available: vi.fn(() => available),
    agentRequest: vi.fn(async (_owner, method, params, context) => ({ provider: id, method, params, operationId: context?.operationId })),
  }
}

describe('BrowserProviderRegistry control plane', () => {
  it('discovers independent Electron and managed runtime providers and selects the preferred available default', async () => {
    const electron = provider('electron-local', 'electron')
    const runtime = provider('managed-runtime', 'remote')
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)

    expect(await registry.list(owner)).toEqual([
      expect.objectContaining({ id: 'electron-local', kind: 'electron', available: true, selected: true }),
      expect.objectContaining({ id: 'managed-runtime', kind: 'remote', available: true, selected: false }),
    ])
  })

  it('routes UI and MCP semantic operations to the same owner-scoped selected provider', async () => {
    const electron = provider('electron-local', 'electron')
    const runtime = provider('managed-runtime', 'remote')
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)

    await registry.select(owner, 'managed-runtime')
    const result = await registry.agentRequest(owner, 'navigate', { tab_id: 'tab-1', url: 'https://example.com' }, { operationId: 'operation-1' })

    expect(result).toMatchObject({ provider: 'managed-runtime', method: 'navigate', operationId: 'operation-1' })
    expect(runtime.agentRequest).toHaveBeenCalledWith(owner, 'navigate', expect.objectContaining({ tab_id: 'tab-1' }), { operationId: 'operation-1' })
    expect(electron.agentRequest).not.toHaveBeenCalled()
    expect((await registry.list({ userId: 8, profile: 'work' })).find(item => item.selected)?.id).toBe('electron-local')
  })

  it('keeps an explicit selection pinned and fails closed when that provider becomes unavailable', async () => {
    let runtimeAvailable = true
    const electron = provider('electron-local', 'electron')
    const runtime = provider('managed-runtime', 'remote')
    runtime.available = vi.fn(() => runtimeAvailable)
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)

    await registry.select(owner, 'managed-runtime')
    runtimeAvailable = false

    await expect(registry.resolve(owner)).rejects.toThrow('Selected browser provider is not available: managed-runtime')
    await expect(registry.agentRequest(owner, 'tabs.list', {})).rejects.toThrow('Selected browser provider is not available: managed-runtime')
    expect((await registry.list(owner)).find(item => item.selected)?.id).toBe('managed-runtime')
    expect(electron.agentRequest).not.toHaveBeenCalled()
  })

  it('pins the first available default and never silently changes it when availability later changes', async () => {
    let electronAvailable = false
    const electron = provider('electron-local', 'electron')
    electron.available = vi.fn(() => electronAvailable)
    const runtime = provider('managed-runtime', 'remote')
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)

    expect((await registry.list(owner)).find(item => item.selected)?.id).toBe('managed-runtime')
    electronAvailable = true
    expect((await registry.list(owner)).find(item => item.selected)?.id).toBe('managed-runtime')
    expect((await registry.resolve(owner))?.id).toBe('managed-runtime')
  })

  it('fails closed when a requested provider is unknown or unavailable', async () => {
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(provider('electron-local', 'electron', false))
    registry.register(provider('managed-runtime', 'remote', true))

    expect((await registry.list(owner)).find(item => item.selected)?.id).toBe('managed-runtime')
    await expect(registry.select(owner, 'electron-local')).rejects.toThrow('not available')
    await expect(registry.select(owner, 'missing')).rejects.toThrow('not registered')
  })

  it('keeps the previous selection when deactivation fails and serializes concurrent switches', async () => {
    let finishDeactivate!: () => void
    const electron = provider('electron-local', 'electron')
    const runtime = provider('managed-runtime', 'remote')
    electron.deactivate = vi.fn()
      .mockImplementationOnce(async () => await new Promise<void>(resolve => { finishDeactivate = resolve }))
      .mockResolvedValue(undefined)
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)
    await registry.agentRequest(owner, 'tabs.list', {})

    const firstSwitch = registry.select(owner, 'managed-runtime')
    await vi.waitFor(() => expect(electron.deactivate).toHaveBeenCalledOnce())
    const secondSwitch = registry.select(owner, 'electron-local')
    finishDeactivate()
    await expect(firstSwitch).resolves.toBe(runtime)
    await expect(secondSwitch).resolves.toBe(electron)
    expect((await registry.list(owner)).find(item => item.selected)?.id).toBe('electron-local')

    runtime.deactivate = vi.fn(async () => { throw new Error('release failed') })
    await registry.select(owner, 'managed-runtime')
    await registry.agentRequest(owner, 'tabs.list', {})
    await expect(registry.select(owner, 'electron-local')).rejects.toThrow('release failed')
    expect((await registry.list(owner)).find(item => item.selected)?.id).toBe('managed-runtime')
  })

  it('does not retain a failed default acquisition or deactivate another owner runtime when switching', async () => {
    const electron = provider('electron-local', 'electron')
    const runtime = provider('managed-runtime', 'remote')
    const actualOwner = { userId: 7, profile: 'work' }
    const otherOwner = { userId: 8, profile: 'work' }
    let electronOwner: string | null = null
    electron.agentRequest.mockImplementation(async current => {
      const key = `${current.userId}:${current.profile}`
      if (electronOwner && electronOwner !== key) throw new Error('assigned to another authenticated owner')
      electronOwner = key
      return { provider: 'electron-local' }
    })
    electron.deactivate = vi.fn(async current => {
      const key = `${current.userId}:${current.profile}`
      if (electronOwner && electronOwner !== key) throw new Error('assigned to another authenticated owner')
      electronOwner = null
    })
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)

    await registry.agentRequest(actualOwner, 'tabs.list', {})
    await expect(registry.agentRequest(otherOwner, 'tabs.list', {})).rejects.toThrow('assigned to another authenticated owner')

    await expect(registry.select(otherOwner, 'managed-runtime')).resolves.toBe(runtime)
    expect(electron.deactivate).not.toHaveBeenCalled()
    expect((await registry.list(otherOwner)).find(item => item.selected)?.id).toBe('managed-runtime')
  })

  it('waits for an in-flight provider switch before dispatching the next Agent operation', async () => {
    let finishDeactivate!: () => void
    const electron = provider('electron-local', 'electron')
    electron.deactivate = vi.fn(async () => await new Promise<void>(resolve => { finishDeactivate = resolve }))
    const runtime = provider('managed-runtime', 'remote')
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)
    await registry.agentRequest(owner, 'tabs.list', {})
    const switching = registry.select(owner, 'managed-runtime')
    await vi.waitFor(() => expect(electron.deactivate).toHaveBeenCalledOnce())
    let dispatched = false
    const operation = registry.agentRequest(owner, 'tabs.list', {}).then(result => { dispatched = true; return result })
    await Promise.resolve()
    expect(dispatched).toBe(false)
    finishDeactivate()
    await switching
    await expect(operation).resolves.toMatchObject({ provider: 'managed-runtime' })
  })

  it('deactivates every selected provider owned by a revoked user or profile', async () => {
    const electron = provider('electron-local', 'electron')
    electron.deactivate = vi.fn(async () => undefined)
    const runtime = provider('managed-runtime', 'remote')
    runtime.deactivate = vi.fn(async () => undefined)
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    registry.register(electron)
    registry.register(runtime)
    await registry.select({ userId: 7, profile: 'work' }, 'managed-runtime')
    await registry.select({ userId: 7, profile: 'home' }, 'managed-runtime')
    await registry.select({ userId: 8, profile: 'work' }, 'managed-runtime')
    await registry.agentRequest({ userId: 7, profile: 'work' }, 'tabs.list', {})
    await registry.agentRequest({ userId: 7, profile: 'home' }, 'tabs.list', {})
    await registry.agentRequest({ userId: 8, profile: 'work' }, 'tabs.list', {})

    await registry.deactivateUser(7)
    expect(runtime.deactivate).toHaveBeenCalledWith({ userId: 7, profile: 'work' })
    expect(runtime.deactivate).toHaveBeenCalledWith({ userId: 7, profile: 'home' })
    await registry.deactivateProfile('work')
    expect(runtime.deactivate).toHaveBeenCalledWith({ userId: 8, profile: 'work' })
  })

  it.each([
    ['user', (registry: BrowserProviderRegistry, mutation: () => Promise<void>) => registry.withUserAuthorityRevoked(owner.userId, mutation)],
    ['profile', (registry: BrowserProviderRegistry, mutation: () => Promise<void>) => registry.withProfileAuthorityRevoked(owner.profile, mutation)],
  ] as const)('drains queued owner work and rejects late dispatch during %s authority revocation', async (_kind, revoke) => {
    let finishAvailability!: () => void
    const runtime = provider('managed-runtime', 'remote')
    runtime.available = vi.fn()
      .mockImplementationOnce(async () => await new Promise<boolean>(resolve => {
        finishAvailability = () => resolve(true)
      }))
      .mockResolvedValue(true)
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['managed-runtime'] })
    registry.register(runtime)

    const discovery = registry.list(owner)
    await vi.waitFor(() => expect(runtime.available).toHaveBeenCalledOnce())
    const operation = registry.agentRequest(owner, 'tabs.create', { url: 'https://example.com' })
    const mutation = vi.fn(async () => undefined)
    let revoked = false
    const authorityChange = revoke(registry, mutation).then(() => { revoked = true })

    await Promise.resolve()
    expect(revoked).toBe(false)
    finishAvailability()
    await expect(discovery).resolves.toEqual([
      expect.objectContaining({ id: 'managed-runtime', selected: true }),
    ])
    await expect(operation).rejects.toThrow('Browser authority mutation is in progress')
    await expect(authorityChange).resolves.toBeUndefined()
    expect(mutation).toHaveBeenCalledOnce()
    expect(runtime.agentRequest).not.toHaveBeenCalled()
  })
})
