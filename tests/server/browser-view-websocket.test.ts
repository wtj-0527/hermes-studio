import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { isAllowedBrowserViewOrigin, setupBrowserViewWebSocket, shouldSendBrowserViewFrame } from '../../packages/server/src/services/browser/browser-view-websocket'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP server')
  return address.port
}

async function expectUpgradeRejected(url: string, origin?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : undefined)
    socket.once('open', () => { socket.close(); reject(new Error('unexpected websocket upgrade')) })
    socket.once('error', () => resolve())
  })
}

describe('Browser live-view WebSocket origin boundary', () => {
  it('accepts only the exact same origin and rejects opaque sandbox origins', () => {
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'studio.example' }, socket: { encrypted: true } } as any)).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example:9443', host: 'studio.example:9443' }, socket: { encrypted: true } } as any)).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'http://studio.example', host: 'studio.example' }, socket: { encrypted: false } } as any)).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'http://studio.example', host: 'studio.example' }, socket: { encrypted: true } } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'studio.example' }, socket: { encrypted: false } } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'other.example' } } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'null', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: {} } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'studio.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'studio.example' }, socket: { encrypted: false } } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin(
      { headers: { origin: 'https://studio.example', host: 'studio.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'studio.example' }, socket: { encrypted: false } } as any,
      undefined,
      { trustProxy: true },
    )).toBe(true)
    expect(isAllowedBrowserViewOrigin(
      { headers: { origin: 'https://attacker.example', host: 'studio.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'studio.example' }, socket: { encrypted: false } } as any,
      undefined,
      { trustProxy: true },
    )).toBe(false)
    expect(isAllowedBrowserViewOrigin(
      { headers: { origin: 'https://studio.example', host: 'studio.example', 'x-forwarded-proto': 'https,http', 'x-forwarded-host': 'studio.example' }, socket: { encrypted: false } } as any,
      undefined,
      { trustProxy: true },
    )).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://evil.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'http://studio.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
  })

  it('accepts a same-origin upgrade through an explicitly trusted TLS-terminating proxy', async () => {
    const consume = vi.fn(() => ({
      ownerKey: '7:work', pageId: 'page-1',
      openView: async () => ({ dispatch: async () => undefined, close: async () => undefined }),
    }))
    const service = {
      consumeViewCapabilityWebSocket: consume,
      attachViewConnection: vi.fn(() => () => undefined),
      allowsViewCapabilityInput: vi.fn(() => false),
      allowsViewCapabilityAccess: vi.fn(() => true),
    }
    const studioServer = createServer()
    setupBrowserViewWebSocket(studioServer, service as any, { trustProxy: true })
    const studioPort = await listen(studioServer)
    const client = new WebSocket(`ws://127.0.0.1:${studioPort}/api/browser/view/${'d'.repeat(32)}/socket`, {
      origin: 'https://studio.example',
      headers: {
        host: 'studio.example',
        'x-forwarded-host': 'studio.example',
        'x-forwarded-proto': 'https',
      },
    })

    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    expect(consume).toHaveBeenCalledOnce()
    client.close()
  })

  it('bridges one exact-origin capability to a Studio-owned CDP view and revokes it', async () => {
    let available = true
    let emitFrame: ((frame: { data: string }) => void) | undefined
    const dispatch = vi.fn(async () => undefined)
    const closeRuntimeView = vi.fn(async () => undefined)
    const closeConnection = vi.fn()
    const openView = vi.fn(async (_pageId: string, onFrame: (frame: { data: string }) => void) => {
      emitFrame = onFrame
      return { dispatch, close: closeRuntimeView }
    })
    const service = {
      consumeViewCapabilityWebSocket: vi.fn((token: string) => {
        if (!available || token !== 'a'.repeat(32)) throw new Error('Browser view not found')
        available = false
        return { openView, ownerKey: '7:work', pageId: 'page-1' }
      }),
      attachViewConnection: vi.fn((_owner: string, _pageId: string, close: () => void) => {
        closeConnection.mockImplementation(close)
        return () => undefined
      }),
      allowsViewCapabilityInput: vi.fn(() => true),
      allowsViewCapabilityAccess: vi.fn(() => true),
    }
    const studioServer = createServer((_request, response) => { response.statusCode = 404; response.end() })
    setupBrowserViewWebSocket(studioServer, service as any, { configuredOrigin: 'https://studio.example' })
    const studioPort = await listen(studioServer)
    const url = `ws://127.0.0.1:${studioPort}/api/browser/view/${'a'.repeat(32)}/socket`
    const client = new WebSocket(url, { origin: 'https://studio.example' })
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('page-1', expect.any(Function)))

    emitFrame?.({ data: 'jpeg-frame' })
    await expect(new Promise<any>((resolve, reject) => {
      client.once('message', data => resolve(JSON.parse(data.toString())))
      client.once('error', reject)
    })).resolves.toEqual({ data: 'jpeg-frame' })

    client.send(JSON.stringify({ type: 'insertText', text: 'hello' }))
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'insertText', text: 'hello' }))
    expect(service.attachViewConnection).toHaveBeenCalledWith('7:work', 'page-1', expect.any(Function))
    closeConnection()
    await new Promise<void>(resolve => client.once('close', () => resolve()))
    expect(closeRuntimeView).toHaveBeenCalledOnce()
    await expectUpgradeRejected(url, 'https://studio.example')
  })

  it('drops viewer input while Agent control is active', async () => {
    const dispatch = vi.fn(async () => undefined)
    const service = {
      consumeViewCapabilityWebSocket: vi.fn(() => ({
        ownerKey: '7:work', pageId: 'page-1',
        openView: async () => ({ dispatch, close: async () => undefined }),
      })),
      attachViewConnection: vi.fn(() => () => undefined),
      allowsViewCapabilityInput: vi.fn(() => false),
      allowsViewCapabilityAccess: vi.fn(() => true),
    }
    const studioServer = createServer()
    setupBrowserViewWebSocket(studioServer, service as any, { configuredOrigin: 'https://studio.example' })
    const studioPort = await listen(studioServer)
    const client = new WebSocket(`ws://127.0.0.1:${studioPort}/api/browser/view/${'c'.repeat(32)}/socket`, { origin: 'https://studio.example' })
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    client.send(JSON.stringify({ type: 'insertText', text: 'blocked' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(dispatch).not.toHaveBeenCalled()
    client.close()
  })

  it('drops live-view frames when the WebSocket is already backpressured', () => {
    expect(shouldSendBrowserViewFrame(0)).toBe(true)
    expect(shouldSendBrowserViewFrame(512 * 1024)).toBe(true)
    expect(shouldSendBrowserViewFrame(0, true)).toBe(false)
    expect(shouldSendBrowserViewFrame(8 * 1024 * 1024)).toBe(false)
    expect(shouldSendBrowserViewFrame(512 * 1024 * 1024)).toBe(false)
  })

  it('rejects missing, null, and cross-origin upgrades without consuming the capability', async () => {
    const consume = vi.fn(() => ({ ownerKey: '7:work', pageId: 'page-1', openView: async () => ({ dispatch: async () => undefined, close: async () => undefined }) }))
    const studioServer = createServer()
    setupBrowserViewWebSocket(studioServer, { consumeViewCapabilityWebSocket: consume, allowsViewCapabilityInput: () => false, allowsViewCapabilityAccess: () => false } as any, { configuredOrigin: 'https://studio.example' })
    const studioPort = await listen(studioServer)
    const url = `ws://127.0.0.1:${studioPort}/api/browser/view/${'b'.repeat(32)}/socket`
    await expectUpgradeRejected(url)
    await expectUpgradeRejected(url, 'null')
    await expectUpgradeRejected(url, 'https://attacker.example')
    expect(consume).not.toHaveBeenCalled()
  })
})
