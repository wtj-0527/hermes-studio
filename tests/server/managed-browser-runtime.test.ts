import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedBrowserService,
  type BrowserRuntimeAdapter,
  type BrowserRuntimeSession,
} from '../../packages/server/src/services/browser/managed-browser-service'

function fakeRuntime(): BrowserRuntimeAdapter & { session: BrowserRuntimeSession } {
  const pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
  const session: BrowserRuntimeSession = {
    id: 'runtime-session-1',
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
    openLiveView: async () => ({ dispatch: async () => undefined, close: async () => undefined }),
    release: async () => undefined,
  }
  return { session, startSession: async () => session }
}

afterEach(() => {
  delete process.env.HERMES_BROWSER_RUNTIME_URL
})

describe('ManagedBrowserService ownership boundary', () => {
  it('fails closed when no internal managed browser runtime is configured', async () => {
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: {} })
    expect((await service.state({ userId: 1, profile: 'default' })).available).toBe(false)
    await expect(service.createTab({ userId: 1, profile: 'default' }, 'https://example.com')).rejects.toThrow('not configured')
  })

  it('rejects public or credential-bearing Managed endpoints by default', () => {
    expect(() => new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'https://runtime.example.com' } })).toThrow('private')
    expect(() => new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://user:secret@127.0.0.1:3000' } })).toThrow('credentials')
  })

  it('accepts private Docker or source-runtime addresses but rejects public IPs', () => {
    for (const runtimeUrl of [
      'http://10.0.0.8:3000',
      'http://172.16.10.8:3000',
      'http://192.168.10.8:3000',
      'http://[fd00::8]:3000',
    ]) {
      expect(new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: runtimeUrl } }).configured()).toBe(true)
    }
    expect(() => new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://1.1.1.1:3000' } })).toThrow('private')
  })

  it('accepts a single-label private service name for the embedded runtime sidecar', () => {
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://browser-runtime:3000' } })
    expect(service.configured()).toBe(true)
  })

  it('binds tabs and view tokens to the authenticated user and profile without exposing runtime URLs', async () => {
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
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
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const consumed = await service.issueView(owner, tab.id)
    const socketPath = service.consumeViewBootstrap(consumed.token).socketPath
    const socketToken = socketPath.split('/').at(-2)!
    expect(() => service.consumeViewBootstrap(consumed.token)).toThrow('not found')
    expect(service.consumeViewCapabilityWebSocket(socketToken)).toMatchObject({ pageId: tab.id, ownerKey: '7:work', openView: expect.any(Function) })
    expect(() => service.consumeViewCapabilityWebSocket(socketToken)).toThrow('not found')

    const revoked = await service.issueView(owner, tab.id)
    const revokedSocketPath = service.consumeViewBootstrap(revoked.token).socketPath
    const revokedSocketToken = revokedSocketPath.split('/').at(-2)!
    const closeView = vi.fn()
    const detachView = service.attachViewConnection('7:work', tab.id, closeView)
    await service.takeOver(owner, tab.id)
    expect(() => service.consumeViewCapabilityWebSocket(revokedSocketToken)).toThrow('not found')
    expect(closeView).toHaveBeenCalledOnce()
    detachView()
  })

  it('binds an opened live-view capability to the exact runtime incarnation and tab generation', async () => {
    const runtime = fakeRuntime()
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const view = await service.issueView(owner, tab.id)
    const socketToken = service.consumeViewBootstrap(view.token).socketPath.split('/').at(-2)!
    const capability = service.consumeViewCapabilityWebSocket(socketToken)

    expect(capability).toMatchObject({
      ownerKey: '7:work', profile: 'work', runtimeSessionId: 'runtime-session-1', pageId: tab.id,
      generation: 0, incarnation: expect.any(String), openView: expect.any(Function),
    })
    expect(service.allowsViewCapabilityAccess(capability)).toBe(true)
    await service.deactivate(owner)
    await service.createTab(owner, 'https://example.com')
    expect(service.allowsViewCapabilityAccess(capability)).toBe(false)
    expect(service.allowsViewCapabilityInput(capability)).toBe(false)
  })

  it('revokes an attached live view before releasing the exact runtime session', async () => {
    const order: string[] = []
    const runtime = fakeRuntime()
    runtime.session.release = vi.fn(async () => { order.push('release') })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    service.attachViewConnection('7:work', tab.id, () => { order.push('view-close') })

    await service.deactivate(owner)

    expect(order).toEqual(['view-close', 'release'])
  })

  it('revokes an attached live view before shutdown releases the exact runtime session', async () => {
    const order: string[] = []
    const runtime = fakeRuntime()
    runtime.session.release = vi.fn(async () => { order.push('release') })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    service.attachViewConnection('7:work', tab.id, () => { order.push('view-close') })

    await service.shutdown()

    expect(order).toEqual(['view-close', 'release'])
  })

  it('does not consume a pending socket capability after its managed tab disappeared', async () => {
    const runtime = fakeRuntime()
    let pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const view = await service.issueView(owner, tab.id)
    const socketToken = service.consumeViewBootstrap(view.token).socketPath.split('/').at(-2)!
    pages = []
    await service.state(owner)

    expect(() => service.consumeViewCapabilityWebSocket(socketToken)).toThrow('not found')
  })

  it('revokes an attached live view before releasing after its upstream page disappeared', async () => {
    const order: string[] = []
    const runtime = fakeRuntime()
    let pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.release = vi.fn(async () => { order.push('release') })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    service.attachViewConnection('7:work', tab.id, () => { order.push('view-close') })

    pages = []
    await service.state(owner)

    expect(order).toEqual(['view-close', 'release'])
  })

  it('keeps viewer capabilities revoked when release fails after its upstream page disappeared', async () => {
    const runtime = fakeRuntime()
    let pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.release = vi.fn(async () => { throw new Error('forced release failure') })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const view = await service.issueView(owner, tab.id)
    const socketToken = service.consumeViewBootstrap(view.token).socketPath.split('/').at(-2)!
    const capability = service.consumeViewCapabilityWebSocket(socketToken)
    const closeView = vi.fn()
    service.attachViewConnection('7:work', tab.id, closeView)

    pages = []
    await expect(service.state(owner)).rejects.toThrow('forced release failure')

    expect(closeView).toHaveBeenCalledOnce()
    expect(service.allowsViewCapabilityAccess(capability)).toBe(false)
    expect(service.allowsViewCapabilityInput(capability)).toBe(false)
  })

  it('fences queued and in-flight Agent operations when the user takes over', async () => {
    let finishSnapshot!: () => void
    const runtime = fakeRuntime()
    runtime.session.snapshot = vi.fn(async pageId => {
      await new Promise<void>(resolve => { finishSnapshot = resolve })
      return { tabId: pageId }
    })
    runtime.session.cancelAgentOperation = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const first = service.agentRequest(owner, 'snapshot', { tab_id: tab.id })
    await vi.waitFor(() => expect(runtime.session.snapshot).toHaveBeenCalledOnce())
    expect(service.allowsViewInput('7:work', tab.id)).toBe(false)
    const queued = service.agentRequest(owner, 'screenshot', { tab_id: tab.id })

    const takeover = service.takeOver(owner, tab.id)
    await vi.waitFor(() => expect(runtime.session.cancelAgentOperation).toHaveBeenCalledWith(tab.id))
    finishSnapshot()

    await expect(first).rejects.toThrow('cancelled by user takeover')
    await expect(queued).rejects.toThrow('cancelled by user takeover')
    await expect(takeover).resolves.toBeDefined()
    expect(service.allowsViewInput('7:work', tab.id)).toBe(true)
    expect(runtime.session.cancelAgentOperation).toHaveBeenCalledWith(tab.id)
  })

  it('blocks live-view input before an Agent navigation reaches its first async Runtime call', async () => {
    let finishListPages!: () => void
    let finishNavigate!: () => void
    const runtime = fakeRuntime()
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const view = await service.issueView(owner, tab.id)
    const socketToken = service.consumeViewBootstrap(view.token).socketPath.split('/').at(-2)!
    const capability = service.consumeViewCapabilityWebSocket(socketToken)
    let listPagesCalls = 0
    runtime.session.listPages = vi.fn(async () => {
      listPagesCalls += 1
      if (listPagesCalls === 1) await new Promise<void>(resolve => { finishListPages = resolve })
      return [{ id: tab.id, title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    })
    runtime.session.navigate = vi.fn(async (pageId, url) => {
      await new Promise<void>(resolve => { finishNavigate = resolve })
      return { id: pageId, title: 'Example', url, loading: false, canGoBack: true, canGoForward: false }
    })

    const operation = service.agentRequest(owner, 'navigate', { tab_id: tab.id, url: 'https://example.org' })
    expect(service.allowsViewCapabilityInput(capability)).toBe(false)
    await vi.waitFor(() => expect(runtime.session.listPages).toHaveBeenCalledOnce())
    expect(service.allowsViewCapabilityInput(capability)).toBe(false)
    finishListPages()
    await vi.waitFor(() => expect(runtime.session.navigate).toHaveBeenCalledOnce())
    expect(service.allowsViewCapabilityInput(capability)).toBe(false)
    finishNavigate()
    await expect(operation).resolves.toMatchObject({ url: 'https://example.org' })
    expect(service.allowsViewCapabilityInput(capability)).toBe(false)

    await service.takeOver(owner, tab.id)
    expect(service.allowsViewInput('7:work', tab.id)).toBe(true)
  })

  it('treats user navigation as takeover and waits for the in-flight Agent worker', async () => {
    let finishSnapshot!: () => void
    const runtime = fakeRuntime()
    runtime.session.snapshot = vi.fn(async pageId => {
      await new Promise<void>(resolve => { finishSnapshot = resolve })
      return { tabId: pageId }
    })
    runtime.session.cancelAgentOperation = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const operation = service.agentRequest(owner, 'snapshot', { tab_id: tab.id })
    await vi.waitFor(() => expect(runtime.session.snapshot).toHaveBeenCalledOnce())

    const navigation = service.userNavigate(owner, tab.id, 'https://example.org')
    await vi.waitFor(() => expect(runtime.session.cancelAgentOperation).toHaveBeenCalledWith(tab.id))
    finishSnapshot()

    await expect(operation).rejects.toThrow('cancelled by user takeover')
    await expect(navigation).resolves.toMatchObject({ url: 'https://example.org' })
  })

  it('treats user tab creation as takeover and waits for every active Agent worker', async () => {
    let finishSnapshot!: () => void
    const runtime = fakeRuntime()
    runtime.session.snapshot = vi.fn(async pageId => {
      await new Promise<void>(resolve => { finishSnapshot = resolve })
      return { tabId: pageId }
    })
    runtime.session.cancelAgentOperation = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const operation = service.agentRequest(owner, 'snapshot', { tab_id: tab.id })
    await vi.waitFor(() => expect(runtime.session.snapshot).toHaveBeenCalledOnce())

    const create = service.userCreateTab(owner, 'https://example.org')
    await vi.waitFor(() => expect(runtime.session.cancelAgentOperation).toHaveBeenCalledWith(tab.id))
    finishSnapshot()

    await expect(operation).rejects.toThrow('cancelled by user takeover')
    await expect(create).resolves.toMatchObject({ url: 'https://example.org' })
  })

  it('invalidates pending and connected view access when the owner loses authorization', async () => {
    let authorized = true
    const service = new ManagedBrowserService({
      runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' },
      ownerAuthorized: () => authorized,
    })
    const owner = { userId: 7, profile: 'work' }
    const tab = await service.createTab(owner, 'https://example.com')
    const pending = await service.issueView(owner, tab.id)
    authorized = false

    expect(() => service.consumeViewBootstrap(pending.token)).toThrow('not found')
    expect(service.allowsViewAccess('7:work', tab.id)).toBe(false)
    expect(service.allowsViewInput('7:work', tab.id)).toBe(false)
  })

  it('locks a single-runtime deployment to one authenticated owner and fails closed for another user', async () => {
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    await service.createTab({ userId: 7, profile: 'shared' }, 'https://one.example')

    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
    expect(service.resolveAgentOwner('shared')).toEqual({ userId: 7, profile: 'shared' })
  })

  it('atomically reserves the single runtime while the first owner session is starting', async () => {
    const runtime = fakeRuntime()
    let finishStart!: () => void
    runtime.startSession = vi.fn(async () => {
      await new Promise<void>(resolve => { finishStart = resolve })
      return runtime.session
    })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = service.createTab({ userId: 7, profile: 'shared' }, 'https://one.example')
    await vi.waitFor(() => expect(runtime.startSession).toHaveBeenCalledOnce())

    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
    expect(runtime.startSession).toHaveBeenCalledOnce()
    finishStart()
    await expect(first).resolves.toBeDefined()
  })

  it('waits for an in-flight side-effecting Agent operation before takeover returns', async () => {
    const runtime = fakeRuntime()
    let finishInteraction!: () => void
    runtime.session.interact = vi.fn(async pageId => {
      await new Promise<void>(resolve => { finishInteraction = resolve })
      return { id: pageId, title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }
    })
    runtime.session.cancelAgentOperation = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'shared' }
    const tab = await service.createTab(owner, 'https://one.example')
    const operation = service.agentRequest(owner, 'interact', { tab_id: tab.id, action: { action: 'click', ref: '@e1' } })
    await vi.waitFor(() => expect(runtime.session.interact).toHaveBeenCalledOnce())

    let takeoverReturned = false
    const takeover = service.takeOver(owner, tab.id).then(result => { takeoverReturned = true; return result })
    await vi.waitFor(() => expect(runtime.session.cancelAgentOperation).toHaveBeenCalledWith(tab.id))
    await expect(service.agentRequest(owner, 'screenshot', { tab_id: tab.id })).rejects.toThrow('takeover')
    await Promise.resolve()
    expect(takeoverReturned).toBe(false)

    finishInteraction()
    await expect(operation).rejects.toThrow('cancelled by user takeover')
    await expect(takeover).resolves.toBeDefined()
  })

  it('releases the single-runtime owner lock after the final page closes', async () => {
    const runtime = fakeRuntime()
    const pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.closePage = async pageId => { pages.splice(pages.findIndex(page => page.id === pageId), 1) }
    runtime.session.release = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    await service.createTab(first, 'https://one.example')
    await service.closeTab(first, 'page-1')

    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
    expect(runtime.session.release).toHaveBeenCalledOnce()
  })

  it('enforces the advertised tab capacity before creating another runtime page', async () => {
    const runtime = fakeRuntime()
    const pages: Array<{ id: string; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }> = []
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.createPage = vi.fn(async url => {
      const page = { id: `page-${pages.length + 1}`, title: '', url, loading: false, canGoBack: false, canGoForward: false }
      pages.push(page)
      return { ...page }
    })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    for (let index = 0; index < 8; index += 1) await service.createTab(owner)
    await expect(service.createTab(owner)).rejects.toThrow('tab limit')
    expect(runtime.session.createPage).toHaveBeenCalledTimes(8)
  })

  it('releases the owner when the final Studio-managed tab closes even if the runtime keeps a bootstrap page', async () => {
    const runtime = fakeRuntime()
    const pages = [
      { id: 'bootstrap-page', title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false },
    ]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.createPage = async url => {
      const page = { id: 'managed-page', title: 'Managed', url, loading: false, canGoBack: false, canGoForward: false }
      pages.push(page)
      return { ...page }
    }
    runtime.session.closePage = async pageId => { pages.splice(pages.findIndex(page => page.id === pageId), 1) }
    runtime.session.release = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'shared' }

    const tab = await service.createTab(owner, 'https://one.example')
    expect((await service.state(owner)).tabs.map(item => item.id)).toEqual(['managed-page'])
    const closed = await service.closeTab(owner, tab.id)

    expect(closed.tabs).toEqual([])
    expect(runtime.session.release).toHaveBeenCalledOnce()
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
  })

  it('keeps the single-runtime owner fence until final-tab release completes', async () => {
    const runtime = fakeRuntime()
    let finishRelease!: () => void
    runtime.session.release = vi.fn(async () => await new Promise<void>(resolve => { finishRelease = resolve }))
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    await service.createTab(first, 'https://one.example')
    const closing = service.closeTab(first, 'page-1')
    await vi.waitFor(() => expect(runtime.session.release).toHaveBeenCalledOnce())

    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
    finishRelease()
    await closing
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
  })

  it('keeps the single-runtime owner reserved when upstream release fails', async () => {
    const runtime = fakeRuntime()
    runtime.session.release = vi.fn(async () => { throw new Error('release failed') })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    await service.createTab(first, 'https://one.example')

    await expect(service.closeTab(first, 'page-1')).rejects.toThrow('release failed')
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
  })

  it('retries only the confirmed release barrier after provider deactivation release fails', async () => {
    const runtime = fakeRuntime()
    let attempts = 0
    runtime.session.cancelAgentOperation = vi.fn(async () => undefined)
    runtime.session.release = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('release failed')
    })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    await service.createTab(first, 'https://one.example')

    await expect(service.deactivate(first)).rejects.toThrow('release failed')
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
    await expect(service.deactivate(first)).resolves.toBeUndefined()
    expect(runtime.session.cancelAgentOperation).toHaveBeenCalledTimes(1)
    expect(runtime.session.release).toHaveBeenCalledTimes(2)
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
  })

  it('releases the owner reservation when the first managed page cannot be created', async () => {
    const runtime = fakeRuntime()
    runtime.session.createPage = vi.fn().mockRejectedValueOnce(new Error('page failed')).mockResolvedValue({
      id: 'page-2', title: 'Second', url: 'https://two.example', loading: false, canGoBack: false, canGoForward: false,
    })
    runtime.session.release = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })

    await expect(service.createTab({ userId: 7, profile: 'shared' }, 'https://one.example')).rejects.toThrow('page failed')
    expect(runtime.session.release).toHaveBeenCalledOnce()
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
  })

  it('does not release an owner while its first direct UI tab is still being created', async () => {
    const runtime = fakeRuntime()
    let finishCreate!: () => void
    runtime.session.createPage = vi.fn(async url => {
      await new Promise<void>(resolve => { finishCreate = resolve })
      return { id: 'late-page', title: 'Late', url, loading: false, canGoBack: false, canGoForward: false }
    })
    runtime.session.release = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'shared' }

    const creating = service.createTab(owner, 'https://one.example')
    await vi.waitFor(() => expect(runtime.session.createPage).toHaveBeenCalledOnce())
    await expect(service.state(owner)).resolves.toMatchObject({ tabs: [] })
    expect(runtime.session.release).not.toHaveBeenCalled()
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')

    finishCreate()
    await expect(creating).resolves.toMatchObject({ id: 'late-page' })
    expect(runtime.session.release).not.toHaveBeenCalled()
  })

  it('waits for a pending direct UI tab creation before deactivating its owner', async () => {
    const runtime = fakeRuntime()
    let finishCreate!: () => void
    runtime.session.createPage = vi.fn(async url => {
      await new Promise<void>(resolve => { finishCreate = resolve })
      return { id: 'late-page', title: 'Late', url, loading: false, canGoBack: false, canGoForward: false }
    })
    runtime.session.release = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'shared' }

    const creating = service.createTab(owner, 'https://one.example')
    await vi.waitFor(() => expect(runtime.session.createPage).toHaveBeenCalledOnce())
    let deactivated = false
    const deactivation = service.deactivate(owner).then(() => { deactivated = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(deactivated).toBe(false)
    expect(runtime.session.release).not.toHaveBeenCalled()

    finishCreate()
    await expect(creating).resolves.toMatchObject({ id: 'late-page' })
    await deactivation
    expect(runtime.session.release).toHaveBeenCalledOnce()
  })

  it('releases the owner when all managed pages disappeared upstream', async () => {
    const runtime = fakeRuntime()
    let pages = [{ id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }]
    runtime.session.listPages = async () => pages.map(page => ({ ...page }))
    runtime.session.release = vi.fn(async () => undefined)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    await service.createTab(first, 'https://one.example')
    pages = []

    expect((await service.state(first)).tabs).toEqual([])
    expect(runtime.session.release).toHaveBeenCalledOnce()
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).resolves.toBeDefined()
  })

  it('deduplicates the same owner operation identity and rejects conflicting reuse', async () => {
    const runtime = fakeRuntime()
    runtime.session.createPage = vi.fn(runtime.session.createPage)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }
    const context = { operationId: 'operation-create-1' }

    const first = service.agentRequest(owner, 'tabs.create', { url: 'https://example.com' }, context)
    const duplicate = service.agentRequest(owner, 'tabs.create', { url: 'https://example.com' }, context)
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2)
    expect(runtime.session.createPage).toHaveBeenCalledOnce()
    await expect(service.agentRequest(owner, 'tabs.create', { url: 'https://different.example' }, context)).rejects.toThrow('conflicts')
  })

  it('lets Agent or MCP create the first managed runtime tab without a pre-existing UI session', async () => {
    const runtime = fakeRuntime()
    runtime.startSession = vi.fn(async () => runtime.session)
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'work' }

    await expect(service.agentRequest(owner, 'tabs.list', {})).resolves.toMatchObject({ tabs: [] })
    await expect(service.agentRequest(owner, 'tabs.create', { url: 'https://example.com' })).resolves.toMatchObject({ id: 'page-1' })
    expect(runtime.startSession).toHaveBeenCalledOnce()
    expect((await service.state(owner)).tabs).toHaveLength(1)
  })

  it('keeps non-creating Agent operations fail-closed without an owner session', async () => {
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    await expect(service.agentRequest({ userId: 7, profile: 'work' }, 'snapshot', { tab_id: 'page-1' })).rejects.toThrow('session not found')
  })

  it('fails closed when shutdown cannot confirm the upstream release', async () => {
    const runtime = fakeRuntime()
    runtime.session.release = vi.fn(async () => { throw new Error('shutdown release failed') })
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'shared' }
    await service.createTab(owner, 'https://one.example')
    const view = await service.issueView(owner, 'page-1')
    const socketToken = service.consumeViewBootstrap(view.token).socketPath.split('/').at(-2)!
    const closeView = vi.fn()
    service.attachViewConnection('7:shared', 'page-1', closeView)

    await expect(service.shutdown()).rejects.toThrow('shutdown release failed')
    expect(closeView).toHaveBeenCalledOnce()
    expect(() => service.consumeViewCapabilityWebSocket(socketToken)).toThrow('not found')
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'https://two.example')).rejects.toThrow('already assigned')
  })

  it('returns the unique owner for Agent operations so UI and Agent share the same page', async () => {
    const service = new ManagedBrowserService({ runtime: fakeRuntime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const owner = { userId: 7, profile: 'default' }
    const tab = await service.createTab(owner, 'https://example.com')

    expect(service.resolveAgentOwner('default')).toEqual(owner)
    expect((await service.agentState(owner)).tabs[0].id).toBe(tab.id)
  })
})
