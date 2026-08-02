import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { connect as tcpConnect } from 'node:net'

interface ResolvedAddress {
  address: string
  family: number
}

type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>

function ipv4Number(address: string): number | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const value = ipv4Number(address)
  const network = ipv4Number(base)
  if (value === null || network === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (network & mask)
}

function expandIpv6(address: string): bigint | null {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.startsWith('::ffff:') && isIP(normalized.slice(7)) === 4) {
    const mapped = ipv4Number(normalized.slice(7))
    return mapped === null ? null : (0xffffn << 32n) | BigInt(mapped)
  }
  if (isIP(normalized) !== 6) return null
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) {
    const part = Number.parseInt(group || '0', 16)
    if (!Number.isInteger(part) || part < 0 || part > 0xffff) return null
    value = (value << 16n) | BigInt(part)
  }
  return value
}

function ipv6InCidr(address: string, base: string, prefix: number): boolean {
  const value = expandIpv6(address)
  const network = expandIpv6(base)
  if (value === null || network === null) return false
  const shift = BigInt(128 - prefix)
  return (value >> shift) === (network >> shift)
}

export function isPublicBrowserAddress(address: string): boolean {
  let normalized = address.toLowerCase().split('%')[0]
  if (normalized.startsWith('::ffff:') && isIP(normalized.slice(7)) === 4) normalized = normalized.slice(7)
  if (isIP(normalized) === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, prefix]) => ipv4InCidr(normalized, String(base), Number(prefix)))
  }
  if (isIP(normalized) === 6) {
    return ![
      ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32],
      ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
    ].some(([base, prefix]) => ipv6InCidr(normalized, String(base), Number(prefix)))
  }
  return false
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class BrowserEgressProxy {
  private readonly advertisedHost: string
  private readonly lookupAll: LookupAll
  private readonly username = randomBytes(18).toString('base64url')
  private readonly password = randomBytes(32).toString('base64url')
  private server: Server | null = null

  constructor(options: { advertisedHost?: string; lookupAll?: LookupAll } = {}) {
    this.advertisedHost = String(options.advertisedHost || '127.0.0.1').trim()
    if (!this.advertisedHost || /[\s/@]/.test(this.advertisedHost)) throw new Error('Invalid browser egress proxy host')
    this.lookupAll = options.lookupAll || (async hostname => await lookup(hostname, { all: true, verbatim: true }))
  }

  async start(): Promise<string> {
    if (this.server) return this.proxyUrl(this.server)
    const server = createServer((request, response) => { void this.handleHttp(request, response) })
    server.on('connect', (request, socket, head) => { void this.handleConnect(request, socket, head) })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    return this.proxyUrl(server)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private proxyUrl(server: Server): string {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Browser egress proxy did not bind a TCP port')
    return `http://${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@${this.advertisedHost}:${address.port}`
  }

  private authorized(request: IncomingMessage): boolean {
    const header = String(request.headers['proxy-authorization'] || '')
    if (!header.startsWith('Basic ')) return false
    let decoded = ''
    try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8') } catch { return false }
    return safeEqual(decoded, `${this.username}:${this.password}`)
  }

  private deny(response: ServerResponse, status: number, message: string): void {
    response.statusCode = status
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.end(message)
  }

  private async resolvePublic(hostname: string): Promise<ResolvedAddress> {
    const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    const normalized = unwrapped.toLowerCase()
    if (normalized === 'localhost' || normalized.endsWith('.localhost')) throw new Error('Private browser destination is not allowed')
    const directFamily = isIP(normalized)
    const addresses = directFamily ? [{ address: normalized, family: directFamily }] : await this.lookupAll(normalized)
    if (!addresses.length || addresses.some(item => !isPublicBrowserAddress(item.address))) throw new Error('Private browser destination is not allowed')
    return addresses[0]
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      response.setHeader('Proxy-Authenticate', 'Basic realm="Hermes Browser"')
      this.deny(response, 407, 'Proxy authentication required')
      return
    }
    try {
      const target = new URL(request.url || '')
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error('Invalid browser proxy URL')
      const destination = await this.resolvePublic(target.hostname)
      const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.host }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const upstream = httpRequest({
        host: destination.address,
        family: destination.family,
        port: target.port ? Number(target.port) : 80,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      })
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('Browser proxy timeout')))
      upstream.on('error', () => this.deny(response, 502, 'Browser destination failed'))
      request.pipe(upstream)
    } catch {
      this.deny(response, 403, 'Browser destination is not allowed')
    }
  }

  private async handleConnect(request: IncomingMessage, socket: any, head: Buffer): Promise<void> {
    if (!this.authorized(request)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Hermes Browser"\r\n\r\n')
      return
    }
    try {
      const target = new URL(`https://${request.url || ''}`)
      const destination = await this.resolvePublic(target.hostname)
      const upstream = tcpConnect({ host: destination.address, family: destination.family, port: target.port ? Number(target.port) : 443 })
      upstream.setTimeout(30_000, () => upstream.destroy())
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.once('error', () => socket.destroy())
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    }
  }
}
