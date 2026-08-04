import http from 'http'
import Koa from 'koa'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCorsOriginResolver,
  isOriginAllowed,
  parseUpgradeRequestUrl,
  securityHeaders,
  shouldRejectUpgradeOrigin,
} from '../../packages/server/src/security'
import { createBrowserController } from '../../packages/server/src/controllers/browser'
import { ManagedBrowserService, type BrowserRuntimeAdapter } from '../../packages/server/src/services/browser/managed-browser-service'

function fakeCtx(origin: string, host: string) {
  return {
    host,
    get(name: string) {
      return name.toLowerCase() === 'origin' ? origin : ''
    },
  } as any
}

describe('server security policy', () => {
  let servers: http.Server[] = []

  afterEach(async () => {
    const closing = servers.map(server => new Promise<void>((resolve) => server.close(() => resolve())))
    servers = []
    await Promise.all(closing)
  })

  it('allows same-host browser origins without enabling wildcard CORS', async () => {
    const resolveOrigin = createCorsOriginResolver('')

    await expect(resolveOrigin(fakeCtx('http://127.0.0.1:8648', '127.0.0.1:8648'))).resolves.toBe('http://127.0.0.1:8648')
    await expect(resolveOrigin(fakeCtx('https://evil.example', '127.0.0.1:8648'))).resolves.toBe('')
  })

  it('allows configured origins and explicit wildcard opt-in only', () => {
    expect(isOriginAllowed('https://app.example', '127.0.0.1:8648', 'https://app.example')).toBe(true)
    expect(isOriginAllowed('https://evil.example', '127.0.0.1:8648', 'https://app.example')).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:8648', '')).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:8648', '*')).toBe(true)
    expect(isOriginAllowed('https://evil.example', '127.0.0.1:8648', '*')).toBe(true)
  })

  it('rejects disallowed browser websocket upgrade origins', () => {
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:8648' } } as any, '')).toBe(true)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'null', host: '127.0.0.1:8648' } } as any, '')).toBe(true)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'http://127.0.0.1:8648', host: '127.0.0.1:8648' } } as any, '')).toBe(false)
    expect(shouldRejectUpgradeOrigin({ headers: { host: '127.0.0.1:8648' } } as any, '')).toBe(false)
  })

  it('parses upgrade URLs only with a single valid Host authority', () => {
    expect(parseUpgradeRequestUrl({ url: '/socket?token=ok', headers: { host: 'studio.example:8648' } } as any)?.pathname).toBe('/socket')
    expect(parseUpgradeRequestUrl({ url: '/socket', headers: {} } as any)).toBeNull()
    expect(parseUpgradeRequestUrl({ url: '/socket', headers: { host: '' } } as any)).toBeNull()
    expect(parseUpgradeRequestUrl({ url: '/socket', headers: { host: '%' } } as any)).toBeNull()
    expect(parseUpgradeRequestUrl({ url: '/socket', headers: { host: 'one.example,two.example' } } as any)).toBeNull()
  })

  it('adds baseline browser security headers', async () => {
    const app = new Koa()
    app.use(securityHeaders())
    app.use((ctx) => {
      ctx.body = { ok: true }
    })
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected tcp server')

    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { 'x-forwarded-proto': 'https' },
    })

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000')
  })

  it('lets only the same Studio origin frame a one-time Browser viewer document', async () => {
    const page = { id: 'page-1', title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false }
    const session = {
      id: 'session-1', listPages: async () => [page], createPage: async (url: string) => ({ ...page, url }),
      closePage: async () => undefined, activatePage: async () => undefined, navigate: async (_id: string, url: string) => ({ ...page, url }), navigationAction: async () => page,
      snapshot: async () => ({}), readText: async () => ({}), interact: async () => page, screenshot: async () => ({}), consoleEntries: async () => [], clearConsole: async () => undefined,
      cancelAgentOperation: async () => undefined, openLiveView: async () => ({ dispatch: async () => undefined, close: async () => undefined }), release: async () => undefined,
    }
    const runtime: BrowserRuntimeAdapter = { startSession: async () => session }
    const service = new ManagedBrowserService({ runtime, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const tab = await service.createTab({ userId: 7, profile: 'work' })
    const view = await service.issueView({ userId: 7, profile: 'work' }, tab.id)
    const controller = createBrowserController(service)
    const app = new Koa()
    app.use(securityHeaders())
    app.use(async (ctx) => {
      ctx.params = { token: ctx.path.split('/').pop() || '' }
      await controller.viewDocument(ctx)
    })
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected tcp server')
    const response = await fetch(`http://127.0.0.1:${address.port}${view.url}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  })
})
