// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/client', () => ({ request: api.request }))

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

  it('uses SteelBrowserProvider in the Web UI and never returns an upstream Steel URL', async () => {
    api.request.mockImplementation(async (path: string) => {
      if (path === '/api/browser/state') return {
        available: true,
        activeProfileId: 'default',
        activeTabId: 'tab-owned',
        tabs: [{ id: 'tab-owned', profileId: 'default', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false, crashed: false, agentControl: 'idle' }],
        profiles: [], downloads: [], permissions: [], visible: true, maxTabs: 8,
      }
      if (path === '/api/browser/tabs/tab-owned/view') return { html: '<script>new WebSocket(location.protocol+"//"+location.host+"/api/browser/view/opaque-studio-token-1234567890/socket")</script>' }
      throw new Error(`unexpected ${path}`)
    })

    const { browserProvider } = await import('@/browser/provider')
    const provider = browserProvider()

    expect(provider.kind).toBe('steel')
    expect((await provider.getState()).activeTabId).toBe('tab-owned')
    const view = await provider.getViewUrl?.('tab-owned')
    expect(view).toBe('blob:https://studio.example/viewer')
    expect(view).not.toContain('127.0.0.1')
    expect(view).not.toContain('ws://')
    provider.revokeViewUrl?.(view)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(view)
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
})
