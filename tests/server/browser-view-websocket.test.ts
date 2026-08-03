import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { isAllowedBrowserViewOrigin, setupBrowserViewWebSocket } from '../../packages/server/src/services/browser/browser-view-websocket'

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
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'studio.example' } } as any)).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example:9443', host: 'studio.example:9443' } } as any)).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'other.example' } } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'null', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: {} } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://attacker.example', host: 'studio.example', 'x-forwarded-proto': 'https' } } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://evil.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'http://studio.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
  })

  it('performs a real exact-origin one-time upgrade and revokes an attached view connection', async () => {
    const upstreamServer = createServer()
    const upstreamWss = new WebSocketServer({ server: upstreamServer })
    upstreamWss.on('connection', socket => socket.on('message', data => socket.send(data)))
    const upstreamPort = await listen(upstreamServer)
    let available = true
    const closeConnection = vi.fn()
    const service = {
      consumeViewCapabilityWebSocket: vi.fn((token: string) => {
        if (!available || token !== 'a'.repeat(32)) throw new Error('Browser view not found')
        available = false
        return { url: `ws://127.0.0.1:${upstreamPort}`, ownerKey: '7:work', pageId: 'page-1' }
      }),
      attachViewConnection: vi.fn((_owner: string, _pageId: string, close: () => void) => {
        closeConnection.mockImplementation(close)
        return () => undefined
      }),
      allowsViewInput: vi.fn(() => true),
      allowsViewAccess: vi.fn(() => true),
    }
    const studioServer = createServer((_request, response) => { response.statusCode = 404; response.end() })
    setupBrowserViewWebSocket(studioServer, service as any, { configuredOrigin: 'https://studio.example' })
    const studioPort = await listen(studioServer)
    const url = `ws://127.0.0.1:${studioPort}/api/browser/view/${'a'.repeat(32)}/socket`
    const client = new WebSocket(url, { origin: 'https://studio.example' })
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    client.send('ping')
    await expect(new Promise<string>((resolve, reject) => {
      client.once('message', data => resolve(data.toString()))
      client.once('error', reject)
    })).resolves.toBe('ping')
    expect(service.attachViewConnection).toHaveBeenCalledWith('7:work', 'page-1', expect.any(Function))
    closeConnection()
    await new Promise<void>(resolve => client.once('close', () => resolve()))
    await expectUpgradeRejected(url, 'https://studio.example')
  })

  it('rejects missing, null, and cross-origin upgrades without consuming the capability', async () => {
    const consume = vi.fn(() => ({ url: 'ws://127.0.0.1:1', ownerKey: '7:work', pageId: 'page-1' }))
    const studioServer = createServer()
    setupBrowserViewWebSocket(studioServer, { consumeViewCapabilityWebSocket: consume, allowsViewInput: () => false, allowsViewAccess: () => false } as any, { configuredOrigin: 'https://studio.example' })
    const studioPort = await listen(studioServer)
    const url = `ws://127.0.0.1:${studioPort}/api/browser/view/${'b'.repeat(32)}/socket`
    await expectUpgradeRejected(url)
    await expectUpgradeRejected(url, 'null')
    await expectUpgradeRejected(url, 'https://attacker.example')
    expect(consume).not.toHaveBeenCalled()
  })
})