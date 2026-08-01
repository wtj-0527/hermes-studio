import type { IncomingMessage, Server as HttpServer } from 'http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { SteelBrowserService } from './steel-browser-service'

const VIEW_SOCKET = /^\/api\/browser\/view\/([A-Za-z0-9_-]{20,200})\/socket$/

export function isBrowserViewSocketPath(pathname: string): boolean {
  return VIEW_SOCKET.test(pathname)
}

export function isAllowedBrowserViewOrigin(request: Pick<IncomingMessage, 'headers' | 'socket'>, configuredOrigin?: string): boolean {
  const value = request.headers.origin
  if (typeof value !== 'string' || !value || value === 'null' || value.includes(',')) return false
  try {
    const origin = new URL(value).origin
    if (configuredOrigin) return origin === new URL(configuredOrigin).origin
    const host = String(request.headers.host || '')
    if (!host) return false
    const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0]?.trim().toLowerCase()
    const protocol = forwarded === 'https' || (!forwarded && (request.socket as any)?.encrypted) ? 'https:' : 'http:'
    return origin === `${protocol}//${host}`
  } catch {
    return false
  }
}

export function setupBrowserViewWebSocket(httpServers: HttpServer | HttpServer[], service: SteelBrowserService): void {
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]
  const wss = new WebSocketServer({ noServer: true })

  for (const httpServer of servers) {
    httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`)
      const match = url.pathname.match(VIEW_SOCKET)
      if (!match) return
      if (!isAllowedBrowserViewOrigin(request, process.env.HERMES_PUBLIC_ORIGIN)) {
        socket.destroy()
        return
      }
      let view: { url: string; ownerKey: string; pageId: string }
      try {
        view = service.consumeViewCapabilityWebSocket(match[1])
      } catch {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, client => {
        const upstream = new WebSocket(view.url, { perMessageDeflate: false })
        const pending: RawData[] = []
        let detach: () => void = () => undefined
        client.on('message', data => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
          else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 100) pending.push(data)
        })
        upstream.on('open', () => {
          for (const data of pending.splice(0)) upstream.send(data)
        })
        upstream.on('message', data => {
          if (client.readyState === WebSocket.OPEN) client.send(data)
        })
        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          detach()
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close()
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
        }
        detach = service.attachViewConnection(view.ownerKey, view.pageId, close)
        client.on('close', close)
        client.on('error', close)
        upstream.on('close', close)
        upstream.on('error', close)
      })
    })
  }
}
