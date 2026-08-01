import { describe, expect, it, vi } from 'vitest'
import { SteelBrowserService, type SteelRuntimeAdapter } from '../../packages/server/src/services/browser/steel-browser-service'
import {
  createBrowserController,
  createBrowserRoutes,
} from '../../packages/server/src/controllers/browser'

function runtime(): SteelRuntimeAdapter {
  const page = { id: 'page-1', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }
  return {
    startSession: async () => ({
      id: 'session-1', listPages: async () => [page], createPage: async () => page,
      closePage: async () => undefined, activatePage: async () => undefined,
      navigate: async () => page, navigationAction: async () => page,
      snapshot: async () => ({}), readText: async () => ({}), interact: async () => page,
      screenshot: async () => ({}), consoleEntries: async () => [], clearConsole: async () => undefined,
      cancelAgentOperation: async () => undefined,
      castWebSocketUrl: id => `ws://127.0.0.1:3000/v1/sessions/cast?pageId=${id}`,
      release: async () => undefined,
    }),
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { user: { id: 7 }, profile: { name: 'work' } },
    params: {}, request: { body: {} }, status: 200, body: undefined, set: vi.fn(), get: vi.fn(() => ''),
    ...overrides,
  } as any
}

describe('authenticated Web browser routes', () => {
  it('requires an authenticated user and resolved Hermes profile', async () => {
    const service = new SteelBrowserService({ runtime: runtime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)

    const missingUser = context({ state: { profile: { name: 'work' } } })
    await controller.state(missingUser)
    expect(missingUser.status).toBe(401)

    const missingProfile = context({ state: { user: { id: 7 } } })
    await controller.state(missingProfile)
    expect(missingProfile.status).toBe(400)
  })

  it('never accepts owner identity from the request body', async () => {
    const service = new SteelBrowserService({ runtime: runtime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)
    const ctx = context({ request: { body: { url: 'https://example.com', userId: 8, profile: 'other' } } })

    await controller.createTab(ctx)

    expect(ctx.body).toMatchObject({ id: 'page-1', profileId: 'work' })
    expect(service.resolveAgentOwner('work')).toEqual({ userId: 7, profile: 'work' })
  })

  it('binds Agent requests to the authenticated user instead of another owner sharing the profile', async () => {
    const service = new SteelBrowserService({ runtime: runtime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)
    await controller.createTab(context({ request: { body: { url: 'https://example.com' } } }))
    const otherUser = context({
      state: { user: { id: 8 }, profile: { name: 'work' } },
      request: { body: { profile: 'work', method: 'tabs.list', params: {} } },
    })

    await expect(controller.agent(otherUser)).rejects.toThrow('not found for this user and profile')
  })

  it('registers only authenticated /api/browser routes and no arbitrary proxy route', () => {
    const router = createBrowserRoutes(createBrowserController(new SteelBrowserService({ runtime: runtime(), env: {} })))
    const paths = (router as any).stack.map((layer: any) => layer.path)
    expect(paths).toContain('/api/browser/state')
    expect(paths).toContain('/api/browser/tabs/:tabId/view')
    expect(paths).not.toContain('/api/browser/proxy/(.*)')
    expect(paths).not.toContain('/api/browser/view/:token')
  })

  it('returns a no-store viewer document with only an opaque same-origin socket capability', async () => {
    const service = new SteelBrowserService({ runtime: runtime(), env: { HERMES_STEEL_BROWSER_URL: 'http://127.0.0.1:3000' } })
    const controller = createBrowserController(service)
    await controller.createTab(context({ request: { body: { url: 'https://example.com' } } }))
    const issueCtx = context({ params: { tabId: 'page-1' } })
    await controller.issueView(issueCtx)
    expect(issueCtx.body.html).toContain('/api/browser/view/')
    expect(issueCtx.body.html).toContain('/socket')
    expect(issueCtx.body.html).not.toContain('127.0.0.1')
    expect(issueCtx.body.html).not.toContain('ws://')
    expect(issueCtx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
