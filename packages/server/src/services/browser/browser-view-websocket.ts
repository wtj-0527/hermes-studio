import type { IncomingMessage, Server as HttpServer } from 'http'
import { WebSocketServer, type RawData } from 'ws'
import type { ManagedBrowserService } from './managed-browser-service'

const VIEW_SOCKET = /^\/api\/browser\/view\/([A-Za-z0-9_-]{20,200})\/socket$/
const MAX_VIEW_INPUT_BYTES = 64 * 1024
const MAX_VIEW_BUFFERED_BYTES = 1024 * 1024

export function shouldSendBrowserViewFrame(bufferedAmount: number, sendPending = false): boolean {
  return !sendPending && Number.isFinite(bufferedAmount) && bufferedAmount >= 0 && bufferedAmount <= MAX_VIEW_BUFFERED_BYTES
}

export function isBrowserViewSocketPath(pathname: string): boolean {
  return VIEW_SOCKET.test(pathname)
}

export function isAllowedBrowserViewOrigin(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  configuredOrigin?: string,
  options: { trustProxy?: boolean } = {},
): boolean {
  const value = request.headers.origin
  if (typeof value !== 'string' || !value || value === 'null' || value.includes(',')) return false
  try {
    const origin = new URL(value).origin
    if (configuredOrigin) return origin === new URL(configuredOrigin).origin
    let host = request.headers.host
    let protocol = Boolean((request.socket as { encrypted?: unknown } | undefined)?.encrypted) ? 'https' : 'http'
    if (options.trustProxy) {
      const forwardedHost = request.headers['x-forwarded-host']
      const forwardedProto = request.headers['x-forwarded-proto']
      if (typeof forwardedHost !== 'string' || !forwardedHost || forwardedHost.includes(',')) return false
      if (typeof forwardedProto !== 'string' || !/^(?:http|https)$/.test(forwardedProto)) return false
      host = forwardedHost
      protocol = forwardedProto
    }
    if (typeof host !== 'string' || !host || host.includes(',')) return false
    const requestOrigin = new URL(`${protocol}://${host.trim()}`).origin
    return origin === requestOrigin
  } catch {
    return false
  }
}

function decodeViewInput(data: RawData): unknown {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer)
  if (buffer.byteLength > MAX_VIEW_INPUT_BYTES) throw new Error('Browser live-view input is too large')
  return JSON.parse(buffer.toString('utf8'))
}

export function setupBrowserViewWebSocket(
  httpServers: HttpServer | HttpServer[],
  service: ManagedBrowserService,
  options: { configuredOrigin?: string; trustProxy?: boolean } = {},
): void {
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_VIEW_INPUT_BYTES })

  for (const httpServer of servers) {
    httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`)
      const match = url.pathname.match(VIEW_SOCKET)
      if (!match) return
      if (!isAllowedBrowserViewOrigin(
        request,
        options.configuredOrigin ?? process.env.HERMES_PUBLIC_ORIGIN,
        { trustProxy: options.trustProxy ?? process.env.HERMES_TRUST_PROXY === 'true' },
      )) {
        socket.destroy()
        return
      }
      let capability: ReturnType<ManagedBrowserService['consumeViewCapabilityWebSocket']>
      try {
        capability = service.consumeViewCapabilityWebSocket(match[1])
      } catch {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, client => {
        let runtimeView: Awaited<ReturnType<typeof capability.openView>> | null = null
        let closed = false
        let frameSendPending = false
        let inputQueue = Promise.resolve()
        let detach: () => void = () => undefined
        const close = () => {
          if (closed) return
          closed = true
          detach()
          void runtimeView?.close().catch(() => undefined)
          if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) client.close()
        }
        detach = service.attachViewConnection(capability.ownerKey, capability.pageId, close)
        const authorizationTimer = setInterval(() => {
          if (!service.allowsViewCapabilityAccess(capability)) close()
        }, 1_000)
        authorizationTimer.unref?.()
        const closeWithTimer = () => { clearInterval(authorizationTimer); close() }
        client.on('message', data => {
          if (!service.allowsViewCapabilityInput(capability)) return
          inputQueue = inputQueue
            .then(async () => {
              if (closed || !service.allowsViewCapabilityInput(capability) || !runtimeView) return
              await runtimeView.dispatch(decodeViewInput(data))
            })
            .catch(closeWithTimer)
        })
        client.on('close', closeWithTimer)
        client.on('error', closeWithTimer)
        void capability.openView(capability.pageId, frame => {
          if (closed || !service.allowsViewCapabilityAccess(capability) || client.readyState !== client.OPEN) return
          if (!shouldSendBrowserViewFrame(client.bufferedAmount, frameSendPending)) return
          frameSendPending = true
          try {
            client.send(JSON.stringify(frame), error => {
              frameSendPending = false
              if (error) closeWithTimer()
            })
          } catch {
            frameSendPending = false
            closeWithTimer()
          }
        }).then(view => {
          runtimeView = view
          if (closed) void view.close().catch(() => undefined)
        }).catch(closeWithTimer)
      })
    })
  }
}
