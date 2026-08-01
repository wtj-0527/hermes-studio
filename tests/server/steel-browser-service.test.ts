import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SteelBrowserService,
  type SteelRuntimeAdapter,
  type SteelRuntimeSession,
} from '../../packages/server/src/services/browser/steel-browser-service'

function fakeRuntime(): SteelRuntimeAdapter & { session: SteelRuntimeSession } {
  const pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
  const session: SteelRuntimeSession = {
    id: 'steel-session-1',
    listPages: async () => pages.map(page => ({ ...page })),
    createPage: async (url) => ({ ...pages[0], url }),
    closePage: async () => undefined,
    activatePage: async () => undefined,
    navigate: async (pageId, url) => ({ ...pages[0], id: pageId, url }),
    navigationAction: async (pageId) => ({ ...pages[0], id: pageId }),
    snapshot: async pageId => ({ tabId: pageId, snapshotId: 'snapshot-1', url: pages[0].url, title: pages[0].title, nodes: [], text: 'Example' }),
    readText: async (_pageId, input) => ({ tabId: 'page-1', ...input, text: 'Example', totalLength: 7, returnedLength: 7, hasMore: false }),
    interact: async pageId => ({ ...pages[0], id: pageId }),
    screenshot: async pageId => ({ tabId: pageId, url: pages[0].url, title: pages[0].title, mediaType: 'image/png', data: 'AA==', width: 1, height: 1 }),
    consoleEntries: async () => [],
    clearConsole: async () => undefined,
    cancelAgentOperation: async () => undefined,
    castWebSocketUrl: pageId => `ws://127.0.0.1:3000/v1/sessions/cast?pageId=${encodeURIComponent(pageId)}`,
    release: async () => undefined,
  }
  return { session, startSession: async () => session }
}

afterEach(() => {
  delete process.env.HERMES_STEEL_BROWSER_URL
})

describe('SteelBrowserService ownership boundary', () => {
  it('fails closed when no internal Steel runtime is configured', async () => {
    const service = new SteelBrowserService({ runtime: fakeRuntime(), env: {} })
    expect((await service.state({ userId: 1, profile: 'default' })).available).toBe(false)
    await expect(service.createTab({ userId: 1, profile: 'default' }, 'https://example.com')).rejects.toThrow('not configured')
  })

  it('rejects public or credential-bearing Steel endpoints by default', () => {
    expect(() => new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'https://steel.example.com' } })).toThrow('private')
    expect(() => new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'http://user:secret@127.0.0.1:3000' } })).toThrow('credentials')
  })

  it('accepts a single-label private service name for the embedded Steel sidecar', () => {
    const service = new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'http://steel-browser:3000' } })
    expect(service.configured()).toBe(true)
  })

  it('binds tabs and view tokens to the authenticated user and profile without exposing Steel URLs', async () => {
    const service = new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const view = await service.issueView(owner, tab.id)

    expect(view.url).toMatch(/^\/api\/browser\/view\/[A-Za-z0-9_-]+$/)
    expect(view.url).not.toContain('127.0.0.1')
    expect(service.resolveView(view.token, owner)).toMatchObject({ pageId: tab.id, ownerKey: '7:work' })
    expect(() => service.resolveView(view.token, { userId: 8, profile: 'work' })).toThrow('not found')
    await expect(service.navigate({ userId: 8, profile: 'work' }, tab.id, 'https://example.org')).rejects.toThrow('not found')
  })

  it('consumes a live-view socket capability once and revokes pending grants on takeover', async () => {
    const service = new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const consumed = await service.issueView(owner, tab.id)
    expect(service.consumeViewCapabilityWebSocket(consumed.token)).toMatchObject({ pageId: tab.id, ownerKey: '7:work' })
    expect(() => service.consumeViewCapabilityWebSocket(consumed.token)).toThrow('not found')

    const revoked = await service.issueView(owner, tab.id)
    const closeView = vi.fn()
    const detachView = service.attachViewConnection('7:work', tab.id, closeView)
    await service.takeOver(owner, tab.id)
    expect(() => service.consumeViewCapabilityWebSocket(revoked.token)).toThrow('not found')
    expect(closeView).toHaveBeenCalledOnce()
    detachView()
  })

  it('fences queued and in-flight Agent operations when the user takes over', async () => {
    let finishSnapshot!: () => void
    const runtime = fakeRuntime()
    runtime.session.snapshot = vi.fn(async pageId => {
      await new Promise<void>(resolve => { finishSnapshot = resolve })
      return { tabId: pageId }
    })
    runtime.session.cancelAgentOperation = vi.fn(async () => undefined)
    const service = new SteelBrowserService({ runtime, env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const first = service.agentRequest(owner, 'snapshot', { tab_id: tab.id })
    await vi.waitFor(() => expect(runtime.session.snapshot).toHaveBeenCalledOnce())
    const queued = service.agentRequest(owner, 'screenshot', { tab_id: tab.id })

    await service.takeOver(owner, tab.id)
    finishSnapshot()

    await expect(first).rejects.toThrow('cancelled by user takeover')
    await expect(queued).rejects.toThrow('cancelled by user takeover')
    expect(runtime.session.cancelAgentOperation).toHaveBeenCalledWith(tab.id)
  })

  it('locks a single-runtime deployment to one authenticated owner and fails closed for another user', async () => {
    const service = new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    await service.createTab({ userId: 7, profile: 'shared' }, 'https://one.example')

    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
    expect(service.resolveAgentOwner('shared')).toEqual({ userId: 7, profile: 'shared' })
  })

  it('releases the single-runtime owner lock after the final page closes', async () => {
    const runtime = fakeRuntime()
    const pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.closePage = async pageId => { pages.splice(pages.findIndex(page => page.id === pageId), 1) }
    runtime.session.release = vi.fn(async () => undefined)
    const service = new SteelBrowserService({ runtime, env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    await service.createTab(first, 'https://one.example')
    await service.closeTab(first, 'page-1')

    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
    expect(runtime.session.release).toHaveBeenCalledOnce()
  })

  it('returns the unique owner for Agent operations so UI and Agent share the same page', async () => {
    const service = new SteelBrowserService({ runtime: fakeRuntime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'default' }
    const tab = await service.createTab(owner, 'https://example.com')

    expect(service.resolveAgentOwner('default')).toEqual(owner)
    expect((await service.agentState(owner)).tabs[0].id).toBe(tab.id)
  })
})
