// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ request: vi.fn(), getActiveProfileName: vi.fn(() => 'default') }))
vi.mock('@/api/client', () => ({ request: api.request, getActiveProfileName: api.getActiveProfileName }))

function electronBridge() {
  const state = {
    available: true,
    activeProfileId: 'desktop',
    tabs: [],
    profiles: [],
    downloads: [],
    permissions: [],
    visible: false,
    maxTabs: 8,
  }
  return {
    getState: vi.fn().mockResolvedValue(state),
    setViewport: vi.fn().mockResolvedValue(state),
    createTab: vi.fn(), closeTab: vi.fn(), activateTab: vi.fn(), navigate: vi.fn(),
    navigationAction: vi.fn(), createProfile: vi.fn(), chooseProfileRootDirectory: vi.fn(),
    renameProfile: vi.fn(), profileSwitchImpact: vi.fn(), switchProfile: vi.fn(), updateProfile: vi.fn(),
    deleteProfile: vi.fn(), clearProfileData: vi.fn(), cancelDownload: vi.fn(), takeOver: vi.fn(),
    annotate: vi.fn(), cancelAnnotation: vi.fn(), updateAnnotationNote: vi.fn(), captureAnnotations: vi.fn(),
    clearAnnotations: vi.fn(), onAnnotationRequest: vi.fn(() => () => {}), onStateChange: vi.fn(() => () => {}),
  }
}

describe('platform browser provider selection', () => {
  beforeEach(() => {
    vi.resetModules()
    api.request.mockReset()
    delete (window as any).hermesDesktop
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:https://studio.example/viewer')
      static revokeObjectURL = vi.fn()
    })
    vi.useRealTimers()
  })

  it('registers Electron and Managed independently and can select Managed without changing the Electron bridge', async () => {
    api.request.mockImplementation(async (path: string) => {
      if (path === '/api/browser/providers') return {
        providers: [
          { id: 'electron-local', kind: 'electron', label: 'Electron', available: true, selected: true },
          { id: 'managed-runtime', kind: 'remote', label: 'Managed', available: true, selected: false },
        ],
      }
      if (path === '/api/browser/providers/managed-runtime/select') return { selected_provider_id: 'managed-runtime' }
      if (path === '/api/browser/tabs') return { id: 'tab-1' }
      throw new Error(`unexpected ${path}`)
    })
    const bridge = electronBridge()
    ;(window as any).hermesDesktop = { isDesktop: true, browser: bridge }

    const {
      browserProvider,
      browserProviders,
      selectBrowserProvider,
    } = await import('@/browser/provider')

    expect((await browserProviders()).map((provider: { id: string; kind: string; available: boolean }) => ({ id: provider.id, kind: provider.kind, available: provider.available }))).toEqual([
      { id: 'electron-local', kind: 'electron', available: true },
      { id: 'managed-runtime', kind: 'remote', available: true },
    ])

    await selectBrowserProvider('managed-runtime')
    const provider = browserProvider()
    expect(provider.id).toBe('managed-runtime')
    expect(provider.kind).toBe('remote')
    await provider.createTab('https://example.com', true)
    expect(api.request).toHaveBeenCalledWith('/api/browser/tabs', expect.objectContaining({ method: 'POST' }))
    expect(bridge.createTab).not.toHaveBeenCalled()
  })

  it('uses ElectronBrowserProvider only for a complete trusted desktop bridge', async () => {
    const bridge = electronBridge()
    ;(window as any).hermesDesktop = { isDesktop: true, browser: bridge }

    const { browserProvider } = await import('@/browser/provider')
    const provider = browserProvider()

    expect(provider.kind).toBe('electron')
    await provider.getState()
    expect(bridge.getState).toHaveBeenCalledOnce()
    expect(api.request).not.toHaveBeenCalled()
  })

  it('uses ManagedBrowserProvider in the Web UI, exposes honest capabilities, and never returns an upstream runtime URL', async () => {
    api.request.mockImplementation(async (path: string) => {
      if (path === '/api/browser/state') return {
        available: true,
        activeProfileId: 'default',
        activeTabId: 'tab-owned',
        tabs: [{ id: 'tab-owned', profileId: 'default', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false, crashed: false, agentControl: 'idle' }],
        profiles: [], downloads: [], permissions: [], visible: true, maxTabs: 8,
      }
      if (path === '/api/browser/tabs/tab-owned/view') return { url: '/api/browser/view/opaque-studio-token-1234567890' }
      throw new Error(`unexpected ${path}`)
    })

    const { browserProvider } = await import('@/browser/provider')
    const provider = browserProvider()

    expect(provider.kind).toBe('remote')
    expect(provider.capabilities).toMatchObject({ profiles: false, downloads: false, annotations: false, htmlPreview: false })
    expect((await provider.getState()).activeTabId).toBe('tab-owned')
    const view = await provider.getViewUrl?.('tab-owned')
    expect(view).toBe('/api/browser/view/opaque-studio-token-1234567890')
    expect(view).not.toContain('127.0.0.1')
    expect(view).not.toContain('ws://')
    provider.revokeViewUrl?.(view)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('routes Web tab and navigation operations through authenticated Studio APIs', async () => {
    api.request.mockResolvedValue({ id: 'tab-1' })
    const { browserProvider } = await import('@/browser/provider')
    const provider = browserProvider()

    await provider.createTab('https://example.com', true)
    await provider.navigate('tab-1', 'https://example.org')
    await provider.navigationAction('tab-1', 'reload')
    await provider.takeOver('tab-1')

    expect(api.request).toHaveBeenNthCalledWith(1, '/api/browser/tabs', expect.objectContaining({ method: 'POST' }))
    expect(api.request).toHaveBeenNthCalledWith(2, '/api/browser/tabs/tab-1/navigate', expect.objectContaining({ method: 'POST' }))
    expect(api.request).toHaveBeenNthCalledWith(3, '/api/browser/tabs/tab-1/navigation', expect.objectContaining({ method: 'POST' }))
    expect(api.request).toHaveBeenNthCalledWith(4, '/api/browser/tabs/tab-1/takeover', expect.objectContaining({ method: 'POST' }))
  })

  it('creates a tab for an entered address when no active tab exists', async () => {
    api.request.mockResolvedValue({ id: 'tab-1' })
    const { browserProvider, navigateBrowserAddress } = await import('@/browser/provider')
    const provider = browserProvider()

    await navigateBrowserAddress(provider, undefined, '  baidu.com  ')

    expect(api.request).toHaveBeenCalledWith('/api/browser/tabs', {
      method: 'POST',
      body: JSON.stringify({ url: 'baidu.com', activate: true }),
    })
  })

  it('polls Web browser state only while a listener is subscribed', async () => {
    vi.useFakeTimers()
    api.request.mockResolvedValue({
      available: true, activeProfileId: 'default', tabs: [], profiles: [], downloads: [], permissions: [], visible: false, maxTabs: 8,
    })
    const { browserProvider } = await import('@/browser/provider')
    const provider = browserProvider()
    const listener = vi.fn()
    const stop = provider.onStateChange(listener)

    await vi.advanceTimersByTimeAsync(2_100)
    expect(api.request).toHaveBeenCalledWith('/api/browser/state')
    expect(listener).toHaveBeenCalled()

    const calls = api.request.mock.calls.length
    stop()
    await vi.advanceTimersByTimeAsync(2_100)
    expect(api.request).toHaveBeenCalledTimes(calls)
  })

  it('fails closed instead of silently inventing a local provider selection when server discovery fails', async () => {
    api.request.mockRejectedValue(new Error('provider discovery unavailable'))
    const { browserProviders } = await import('@/browser/provider')
    await expect(browserProviders()).rejects.toThrow('provider discovery unavailable')
  })

  it('does not let stale provider discovery overwrite a newer explicit selection', async () => {
    let finishDiscovery!: (value: unknown) => void
    api.request.mockImplementation(async (path: string) => {
      if (path === '/api/browser/providers') return await new Promise(resolve => { finishDiscovery = resolve })
      if (path === '/api/browser/providers/managed-runtime/select') return { selected_provider_id: 'managed-runtime' }
      throw new Error(`unexpected ${path}`)
    })
    const bridge = electronBridge()
    ;(window as any).hermesDesktop = { isDesktop: true, browser: bridge }
    const { browserProvider, browserProviders, selectBrowserProvider } = await import('@/browser/provider')

    const staleDiscovery = browserProviders()
    await vi.waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/browser/providers'))
    await selectBrowserProvider('managed-runtime')
    finishDiscovery({ providers: [
      { id: 'electron-local', kind: 'electron', label: 'Electron', available: true, selected: true },
      { id: 'managed-runtime', kind: 'remote', label: 'Managed', available: true, selected: false },
    ] })
    await staleDiscovery

    expect(browserProvider().id).toBe('managed-runtime')
  })

  it('tells the control plane to release the previous profile before re-resolving providers', async () => {
    api.request.mockResolvedValue({ ok: true })
    const { transitionBrowserProfile } = await import('@/browser/provider')
    await transitionBrowserProfile('profile-a')
    expect(api.request).toHaveBeenCalledWith('/api/browser/profile-transition', {
      method: 'POST',
      body: JSON.stringify({ previous_profile: 'profile-a' }),
    })
  })

  it('serializes rapid A to B to A profile transitions', async () => {
    let finishFirst!: () => void
    api.request
      .mockImplementationOnce(async () => await new Promise<void>(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce({ ok: true })
    const { transitionBrowserProfile } = await import('@/browser/provider')
    const first = transitionBrowserProfile('profile-a')
    await vi.waitFor(() => expect(api.request).toHaveBeenCalledTimes(1))
    const second = transitionBrowserProfile('profile-b')
    await Promise.resolve()
    expect(api.request).toHaveBeenCalledTimes(1)
    finishFirst()
    await first
    await second
    expect(api.request).toHaveBeenNthCalledWith(2, '/api/browser/profile-transition', expect.objectContaining({
      body: JSON.stringify({ previous_profile: 'profile-b' }),
    }))
  })
})
