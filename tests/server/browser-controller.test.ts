import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ManagedBrowserService, type BrowserRuntimeAdapter } from '../../packages/server/src/services/browser/managed-browser-service'
import { BrowserProviderRegistry, type BrowserProviderCapabilities } from '../../packages/server/src/services/browser/provider-registry'
import {
  createBrowserController,
  createBrowserPublicRoutes,
  createBrowserRoutes,
} from '../../packages/server/src/controllers/browser'

const providerCapabilities: BrowserProviderCapabilities = {
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
}

function runtime(): BrowserRuntimeAdapter {
  const page = { id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }
  return {
    startSession: async () => ({
      id: 'session-1', listPages: async () => [page], createPage: async () => page,
      closePage: async () => undefined, activatePage: async () => undefined,
      navigate: async () => page, navigationAction: async () => page,
      snapshot: async () => ({}), readText: async () => ({}), interact: async () => page,
      screenshot: async () => ({}), consoleEntries: async () => [], clearConsole: async () => undefined,
      cancelAgentOperation: async () => undefined,
      openLiveView: async () => ({ dispatch: async () => undefined, close: async () => undefined }),
      release: async () => undefined,
    }),
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { user: { id: 7 }, profile: { name: 'work' } },
    params: {}, request: { body: {} }, status: 200, body: undefined, set: vi.fn(), remove: vi.fn(), get: vi.fn(() => ''),
    ...overrides,
  } as any
}

describe('authenticated Web browser routes', () => {
  it('requires an authenticated user and resolved Hermes profile', async () => {
    const service = new ManagedBrowserService({ runtime: runtime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)

    const missingUser = context({ state: { profile: { name: 'work' } } })
    await controller.state(missingUser)
    expect(missingUser.status).toBe(401)

    const missingProfile = context({ state: { user: { id: 7 } } })
    await controller.state(missingProfile)
    expect(missingProfile.status).toBe(400)
  })

  it('never accepts owner identity from the request body', async () => {
    const service = new ManagedBrowserService({ runtime: runtime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)
    const ctx = context({ request: { body: { url: 'https://example.com', userId: 8, profile: 'other' } } })

    await controller.createTab(ctx)

    expect(ctx.body).toMatchObject({ id: 'page-1', profileId: 'work' })
    expect(service.resolveAgentOwner('work')).toEqual({ userId: 7, profile: 'work' })
  })

  it('binds Agent requests to the authenticated user instead of another owner sharing the profile', async () => {
    const service = new ManagedBrowserService({ runtime: runtime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)
    await controller.createTab(context({ request: { body: { url: 'https://example.com' } } }))
    const otherUser = context({
      state: { user: { id: 8 }, profile: { name: 'work' } },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'work' : ''),
      request: { body: { profile: 'work', method: 'tabs.list', params: {} } },
    })

    await controller.agent(otherUser)
    expect(otherUser).toMatchObject({ status: 409, body: { error: expect.stringContaining('already assigned') } })
  })

  it('exposes owner-scoped provider discovery and selection through the shared control plane', async () => {
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local', 'managed-runtime'] })
    const electronRequest = vi.fn(async () => ({ provider: 'electron-local' }))
    const runtimeRequest = vi.fn(async () => ({ provider: 'managed-runtime' }))
    registry.register({
      id: 'electron-local', kind: 'electron', label: 'Electron', capabilities: providerCapabilities,
      available: () => true, agentRequest: electronRequest,
    })
    registry.register({
      id: 'managed-runtime', kind: 'remote', label: 'Managed', capabilities: providerCapabilities,
      available: () => true, agentRequest: runtimeRequest,
    })
    const controller = createBrowserController(
      new ManagedBrowserService({ runtime: runtime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } }),
      registry,
    )

    const listCtx = context()
    await controller.providers(listCtx)
    expect(listCtx.body).toEqual(expect.objectContaining({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: 'electron-local', selected: true }),
        expect.objectContaining({ id: 'managed-runtime', selected: false }),
      ]),
    }))

    const blockedManagedState = context()
    await controller.state(blockedManagedState)
    expect(blockedManagedState.status).toBe(409)
    expect(blockedManagedState.body.error).toContain('selected browser provider')

    const selectCtx = context({ params: { providerId: 'managed-runtime' } })
    await controller.selectProvider(selectCtx)
    expect(selectCtx.body).toMatchObject({ selected_provider_id: 'managed-runtime' })

    const agentCtx = context({
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'work' : ''),
      request: { body: { method: 'tabs.list', params: {}, operation_id: 'operation-1' } },
    })
    await controller.agent(agentCtx)
    expect(agentCtx.body).toEqual({ operation_id: 'operation-1', result: { provider: 'managed-runtime' } })
    expect(runtimeRequest).toHaveBeenCalledWith({ userId: 7, profile: 'work' }, 'tabs.list', {}, { operationId: 'operation-1' })
    expect(electronRequest).not.toHaveBeenCalled()
  })

  it('maps provider selection and availability failures to stable non-500 responses', async () => {
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['managed-runtime'] })
    registry.register({
      id: 'managed-runtime', kind: 'remote', label: 'Managed', capabilities: providerCapabilities,
      available: () => false, agentRequest: vi.fn(),
    })
    const controller = createBrowserController(new ManagedBrowserService({ runtime: runtime(), env: {} }), registry)
    const unavailable = context({ params: { providerId: 'managed-runtime' } })
    await controller.selectProvider(unavailable)
    expect(unavailable).toMatchObject({ status: 503, body: { error: 'Browser provider is not available: managed-runtime' } })

    const unknown = context({ params: { providerId: 'missing' } })
    await controller.selectProvider(unknown)
    expect(unknown).toMatchObject({ status: 400, body: { error: 'Browser provider is not registered: missing' } })
  })

  it.each([
    ['non-string', 7],
    ['leading whitespace', ' operation-1'],
    ['unsupported characters', 'operation/1'],
    ['overlong', `o${'p'.repeat(128)}`],
  ])('rejects %s Agent operation identities before provider dispatch', async (_label, operationId) => {
    const request = vi.fn(async () => ({ ok: true }))
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['managed-runtime'] })
    registry.register({
      id: 'managed-runtime', kind: 'remote', label: 'Managed', capabilities: providerCapabilities,
      available: () => true, agentRequest: request,
    })
    const controller = createBrowserController(new ManagedBrowserService({ runtime: runtime(), env: {} }), registry)
    const ctx = context({
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'work' : ''),
      request: { body: { method: 'tabs.list', params: {}, operation_id: operationId } },
    })

    await controller.agent(ctx)

    expect(ctx).toMatchObject({ status: 400, body: { error: expect.stringContaining('operation_id') } })
    expect(request).not.toHaveBeenCalled()
  })

  it('maps provider protocol identity failures to a bounded upstream error', async () => {
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['electron-local'] })
    registry.register({
      id: 'electron-local', kind: 'electron', label: 'Electron', capabilities: providerCapabilities,
      available: () => true,
      agentRequest: vi.fn(async () => { throw new Error('Browser provider operation identity mismatch') }),
    })
    const controller = createBrowserController(new ManagedBrowserService({ runtime: runtime(), env: {} }), registry)
    const ctx = context({
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'work' : ''),
      request: { body: { method: 'tabs.list', params: {}, operation_id: 'operation-1' } },
    })

    await controller.agent(ctx)

    expect(ctx).toMatchObject({ status: 502, body: { error: 'Browser provider operation identity mismatch' } })
  })

  it('deactivates the previous profile provider before resolving the new profile', async () => {
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['managed-runtime'] })
    const deactivate = vi.fn(async () => undefined)
    registry.register({
      id: 'managed-runtime', kind: 'remote', label: 'Managed', capabilities: providerCapabilities,
      available: () => true, deactivate, agentRequest: vi.fn(),
    })
    await registry.select({ userId: 7, profile: 'profile-a' }, 'managed-runtime')
    await registry.agentRequest({ userId: 7, profile: 'profile-a' }, 'tabs.list', {})
    const controller = createBrowserController(new ManagedBrowserService({ runtime: runtime(), env: {} }), registry)
    const ctx = context({
      state: { user: { id: 7 }, profile: { name: 'profile-b' } },
      request: { body: { previous_profile: 'profile-a' } },
    })
    await controller.transitionProfile(ctx)
    expect(ctx.body).toEqual({ ok: true, profile: 'profile-b' })
    expect(deactivate).toHaveBeenCalledWith({ userId: 7, profile: 'profile-a' })
  })

  it('keeps a direct Managed route inside the registry authority transaction', async () => {
    let authorized = true
    let enterCreate!: () => void
    let finishCreate!: () => void
    const createEntered = new Promise<void>(resolve => { enterCreate = resolve })
    const createGate = new Promise<void>(resolve => { finishCreate = resolve })
    const service = new ManagedBrowserService({
      runtime: runtime(),
      env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' },
      ownerAuthorized: () => authorized,
    })
    const originalCreate = service.userCreateTab.bind(service)
    vi.spyOn(service, 'userCreateTab').mockImplementation(async (...args) => {
      enterCreate()
      await createGate
      return await originalCreate(...args)
    })
    const registry = new BrowserProviderRegistry({ preferredProviderIds: ['managed-runtime'] })
    registry.register({
      id: 'managed-runtime', kind: 'remote', label: 'Managed', capabilities: providerCapabilities,
      available: () => true,
      deactivate: owner => service.deactivate(owner),
      agentRequest: (owner, method, params, operation) => service.agentRequest(owner, method, params, operation),
    })
    await registry.select({ userId: 7, profile: 'work' }, 'managed-runtime')
    const controller = createBrowserController(service, registry)

    const ctx = context({ request: { body: { url: 'https://example.com' } } })
    const creating = controller.createTab(ctx)
    await createEntered
    let mutationFinished = false
    const mutation = registry.withUserAuthorityRevoked(7, async () => {
      authorized = false
      mutationFinished = true
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(mutationFinished).toBe(false)

    finishCreate()
    await creating
    expect(ctx.body).toMatchObject({ id: 'page-1' })
    await mutation
    expect(mutationFinished).toBe(true)
  })

  it('registers only authenticated /api/browser routes and no arbitrary proxy route', () => {
    const controller = createBrowserController(new ManagedBrowserService({ runtime: runtime(), env: {} }))
    const protectedPaths = (createBrowserRoutes(controller) as any).stack.map((layer: any) => layer.path)
    const publicPaths = (createBrowserPublicRoutes(controller) as any).stack.map((layer: any) => layer.path)
    expect(protectedPaths).toContain('/api/browser/state')
    expect(protectedPaths).toContain('/api/browser/tabs/:tabId/view')
    expect(protectedPaths).not.toContain('/api/browser/view/:token')
    expect(publicPaths).toEqual(['/api/browser/view/:token'])
    expect([...protectedPaths, ...publicPaths]).not.toContain('/api/browser/proxy/(.*)')
  })

  it('mounts the capability bootstrap route before bearer/profile middleware', () => {
    const routes = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    expect(routes.indexOf('app.use(browserPublicRoutes.routes())')).toBeLessThan(routes.indexOf('authMiddleware.forEach'))
    expect(routes.indexOf('app.use(browserRoutes.routes())')).toBeGreaterThan(routes.indexOf('authMiddleware.forEach'))
  })

  it('returns a one-time no-store same-origin viewer bootstrap URL', async () => {
    const service = new ManagedBrowserService({ runtime: runtime(), env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)
    await controller.createTab(context({ request: { body: { url: 'https://example.com' } } }))
    const issueCtx = context({ params: { tabId: 'page-1' } })
    await controller.issueView(issueCtx)
    expect(issueCtx.body.url).toMatch(/^\/api\/browser\/view\/[A-Za-z0-9_-]+$/)
    expect(issueCtx.body).not.toHaveProperty('html')
    expect(issueCtx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')

    const bootstrapToken = issueCtx.body.url.split('/').pop()
    const bootstrapCtx = context({ state: {}, params: { token: bootstrapToken } })
    await controller.viewDocument(bootstrapCtx)
    const socketToken = bootstrapCtx.body.match(/\/api\/browser\/view\/([A-Za-z0-9_-]+)\/socket/)?.[1]
    expect(socketToken).toBeTruthy()
    expect(socketToken).not.toBe(bootstrapToken)
    expect(bootstrapCtx.body).not.toContain('127.0.0.1')
    expect(bootstrapCtx.body).not.toContain('ws://')
    expect(bootstrapCtx.body).toContain("ws.binaryType='arraybuffer'")
    expect(bootstrapCtx.body).toContain('new TextDecoder().decode(event.data)')
    expect(bootstrapCtx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(bootstrapCtx.remove).toHaveBeenCalledWith('X-Frame-Options')
    expect(bootstrapCtx.set).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining("frame-ancestors 'self'"))
    expect(bootstrapCtx.type).toBe('text/html; charset=utf-8')
    const replayCtx = context({ state: {}, params: { token: bootstrapToken } })
    await controller.viewDocument(replayCtx)
    expect(replayCtx.status).toBe(404)
    expect(replayCtx.body).toEqual({ error: 'not_found' })
  })
})
