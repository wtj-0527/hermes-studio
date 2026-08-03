import type { IncomingMessage, Server as HttpServer } from 'http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { ManagedBrowserService } from './managed-browser-service'

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
    const host = request.headers.host
    return typeof host === 'string' && !host.includes(',') && new URL(value).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false
  }
}

export function setupBrowserViewWebSocket(
  httpServers: HttpServer | HttpServer[],
  service: ManagedBrowserService,
  options: { configuredOrigin?: string } = {},
): void {
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]
  const wss = new WebSocketServer({ noServer: true })

  for (const httpServer of servers) {
    httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`)
      const match = url.pathname.match(VIEW_SOCKET)
      if (!match) return
      if (!isAllowedBrowserViewOrigin(request, options.configuredOrigin ?? process.env.HERMES_PUBLIC_ORIGIN)) {
        socket.destroy()
        return
      }
      let view: { url: string; headers: Record<string, string>; ownerKey: string; pageId: string }
      try {
        view = service.consumeViewCapabilityWebSocket(match[1])
      } catch {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, client => {
        const upstream = new WebSocket(view.url, { perMessageDeflate: false, headers: view.headers })
        const pending: RawData[] = []
        let detach: () => void = () => undefined
        client.on('message', data => {
          if (!service.allowsViewInput(view.ownerKey, view.pageId)) return
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
          else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 100) pending.push(data)
        })
        upstream.on('open', () => {
          const queued = pending.splice(0)
          if (service.allowsViewInput(view.ownerKey, view.pageId)) {
            for (const data of queued) upstream.send(data)
          }
        })
        upstream.on('message', data => {
          if (service.allowsViewAccess(view.ownerKey, view.pageId) && client.readyState === WebSocket.OPEN) client.send(data)
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
        const authorizationTimer = setInterval(() => {
          if (!service.allowsViewAccess(view.ownerKey, view.pageId)) close()
        }, 1_000)
        authorizationTimer.unref?.()
        const closeWithTimer = () => { clearInterval(authorizationTimer); close() }
        client.on('close', closeWithTimer)
        client.on('error', closeWithTimer)
        upstream.on('close', closeWithTimer)
        upstream.on('error', closeWithTimer)
      })
    })
  }
}
