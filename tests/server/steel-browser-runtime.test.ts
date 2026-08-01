import { createServer, type Server } from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteelHttpRuntimeAdapter } from '../../packages/server/src/services/browser/steel-http-runtime'

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
})

describe('SteelHttpRuntimeAdapter', () => {
  it('creates and releases one pinned Steel session without exposing upstream URLs', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bodyText = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: request.url || '', method: request.method || '', body: bodyText ? JSON.parse(bodyText) : null })
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'POST' && request.url === '/v1/sessions') {
        response.end(JSON.stringify({
          id: 'steel-session-1',
          status: 'live',
          websocketUrl: `ws://0.0.0.0:${(server!.address() as any).port}/v1/sessions/steel-session-1/cdp`,
        }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/steel-session-1/release') {
        response.end(JSON.stringify({ success: true }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server not listening')

    const page = {
      url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), isClosed: vi.fn(() => false),
      goto: vi.fn(async () => null), close: vi.fn(async () => undefined), bringToFront: vi.fn(async () => undefined),
      goBack: vi.fn(async () => null), goForward: vi.fn(async () => null), reload: vi.fn(async () => null),
      screenshot: vi.fn(async () => Buffer.from([0])), viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
      locator: vi.fn(), keyboard: { press: vi.fn(), type: vi.fn() }, mouse: { wheel: vi.fn() },
      on: vi.fn(), removeAllListeners: vi.fn(),
    }
    const context = {
      pages: vi.fn(() => [page]), newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })),
        detach: vi.fn(async () => undefined),
      })),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const chromium = { connectOverCDP: vi.fn(async () => browser) }
    const egressProxy = { start: vi.fn(async () => 'http://steel-user:steel-token@studio.internal:43123'), close: vi.fn(async () => undefined) }
    const adapter = new SteelHttpRuntimeAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      userDataRoot: '/var/private/browser-data',
      chromium: chromium as any,
      egressProxy,
    })

    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    expect(session.id).toBe('steel-session-1')
    expect(chromium.connectOverCDP).toHaveBeenCalledWith(
      `ws://127.0.0.1:${address.port}/v1/sessions/steel-session-1/cdp`,
      expect.any(Object),
    )
    expect(requests[0]).toMatchObject({
      url: '/v1/sessions',
      method: 'POST',
      body: {
        sessionId: expect.any(String),
        persist: true,
        userDataDir: expect.stringMatching(/^\/var\/private\/browser-data\//),
        proxyUrl: 'http://steel-user:steel-token@studio.internal:43123',
      },
    })
    expect(session.castWebSocketUrl('page-1')).toBe(`ws://127.0.0.1:${address.port}/v1/sessions/cast?pageId=page-1`)
    await session.cancelAgentOperation('page-1')

    await session.release()
    expect(browser.close).toHaveBeenCalledOnce()
    expect(requests[1]).toMatchObject({ url: '/v1/sessions/steel-session-1/release', method: 'POST' })
    await adapter.shutdown()
    expect(egressProxy.close).toHaveBeenCalledOnce()
  })
})
