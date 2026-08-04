import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { connect as tcpConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { domainToASCII } from 'node:url'

interface ResolvedAddress {
  address: string
  family: number
}

type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>

interface DohRequestInput {
  resolver: URL
  bootstrapAddress: ResolvedAddress
  query: Uint8Array
}

interface DohResponse {
  statusCode: number
  contentType: string
  body: Uint8Array
}

type DohRequest = (input: DohRequestInput) => Promise<DohResponse>

const DOH_RESPONSE_LIMIT_BYTES = 65_535
const DOH_TIMEOUT_MS = 5_000
const DOH_MAX_CNAME_DEPTH = 16

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

function mappedIpv4(address: string): string | null {
  const value = expandIpv6(address)
  if (value === null || (value >> 32n) !== 0xffffn) return null
  const mapped = Number(value & 0xffffffffn)
  return [mapped >>> 24, (mapped >>> 16) & 0xff, (mapped >>> 8) & 0xff, mapped & 0xff].join('.')
}

function isBenchmarkingFakeIp(address: string): boolean {
  const raw = address.toLowerCase().split('%')[0]
  const normalized = mappedIpv4(raw) || raw
  return isIP(normalized) === 4 && ipv4InCidr(normalized, '198.18.0.0', 15)
}

function normalizeDnsName(hostname: string): string {
  const ascii = domainToASCII(hostname.trim().replace(/\.$/, '').toLowerCase())
  if (!ascii || ascii.length > 253) throw new Error('Browser DNS resolver received an invalid name')
  const labels = ascii.split('.')
  if (labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('Browser DNS resolver received an invalid name')
  }
  return ascii
}

function encodeDnsName(hostname: string): Buffer {
  const labels = normalizeDnsName(hostname).split('.')
  return Buffer.concat([
    ...labels.map(label => {
      const value = Buffer.from(label, 'ascii')
      return Buffer.concat([Buffer.from([value.length]), value])
    }),
    Buffer.from([0]),
  ])
}

function createDnsQuery(hostname: string, type: 1 | 28): Buffer {
  const header = Buffer.alloc(12)
  randomBytes(2).copy(header, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const question = Buffer.alloc(4)
  question.writeUInt16BE(type, 0)
  question.writeUInt16BE(1, 2)
  return Buffer.concat([header, encodeDnsName(hostname), question])
}

function readDnsName(message: Uint8Array, start: number): { name: string; nextOffset: number } {
  const labels: string[] = []
  const visited = new Set<number>()
  let cursor = start
  let nextOffset = -1
  let jumps = 0
  while (true) {
    if (cursor >= message.length) throw new Error('Browser DNS resolver returned a malformed response')
    const length = message[cursor]
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= message.length) throw new Error('Browser DNS resolver returned a malformed response')
      const pointer = ((length & 0x3f) << 8) | message[cursor + 1]
      if (pointer >= cursor || pointer >= message.length || visited.has(pointer) || jumps >= DOH_MAX_CNAME_DEPTH) {
        throw new Error('Browser DNS resolver returned a malformed response')
      }
      visited.add(pointer)
      jumps += 1
      if (nextOffset < 0) nextOffset = cursor + 2
      cursor = pointer
      continue
    }
    if ((length & 0xc0) !== 0 || length > 63) throw new Error('Browser DNS resolver returned a malformed response')
    cursor += 1
    if (length === 0) {
      if (nextOffset < 0) nextOffset = cursor
      break
    }
    if (cursor + length > message.length) throw new Error('Browser DNS resolver returned a malformed response')
    const raw = Buffer.from(message.subarray(cursor, cursor + length))
    if ([...raw].some(value => value > 0x7f)) throw new Error('Browser DNS resolver returned a malformed response')
    labels.push(raw.toString('ascii'))
    cursor += length
  }
  const name = labels.join('.')
  return { name: name ? normalizeDnsName(name) : '.', nextOffset }
}

function parseDnsResponse(query: Uint8Array, response: Uint8Array, expectedHostname: string, expectedType: 1 | 28): ResolvedAddress[] {
  if (response.byteLength > DOH_RESPONSE_LIMIT_BYTES) throw new Error('Browser DNS resolver response is too large')
  if (query.byteLength < 17 || response.byteLength < 12) throw new Error('Browser DNS resolver returned a malformed response')
  const queryView = Buffer.from(query)
  const view = Buffer.from(response)
  if (view.readUInt16BE(0) !== queryView.readUInt16BE(0)) throw new Error('Browser DNS resolver returned a mismatched response')
  const flags = view.readUInt16BE(2)
  if (
    (flags & 0x8000) === 0
    || (flags & 0x7800) !== 0
    || (flags & 0x0200) !== 0
    || (flags & 0x0070) !== 0
    || (flags & 0x000f) !== 0
  ) {
    throw new Error('Browser DNS resolver failed')
  }
  if (view.readUInt16BE(4) !== 1) throw new Error('Browser DNS resolver returned a malformed response')

  const expectedName = normalizeDnsName(expectedHostname)
  const question = readDnsName(response, 12)
  if (question.nextOffset + 4 > response.byteLength) throw new Error('Browser DNS resolver returned a malformed response')
  const questionType = view.readUInt16BE(question.nextOffset)
  const questionClass = view.readUInt16BE(question.nextOffset + 2)
  if (question.name !== expectedName || questionType !== expectedType || questionClass !== 1) {
    throw new Error('Browser DNS resolver returned a mismatched response')
  }

  const cnameByOwner = new Map<string, string>()
  const addressRecords: Array<{ owner: string; address: ResolvedAddress }> = []
  let offset = question.nextOffset + 4
  const sectionCounts = [view.readUInt16BE(6), view.readUInt16BE(8), view.readUInt16BE(10)]
  let optSeen = false
  for (let section = 0; section < sectionCounts.length; section += 1) {
    for (let index = 0; index < sectionCounts[section]; index += 1) {
      const owner = readDnsName(response, offset)
      offset = owner.nextOffset
      if (offset + 10 > response.byteLength) throw new Error('Browser DNS resolver returned a malformed response')
      const type = view.readUInt16BE(offset)
      const recordClass = view.readUInt16BE(offset + 2)
      const ttl = view.readUInt32BE(offset + 4)
      const dataLength = view.readUInt16BE(offset + 8)
      const dataOffset = offset + 10
      const dataEnd = dataOffset + dataLength
      if (dataEnd > response.byteLength) throw new Error('Browser DNS resolver returned a malformed response')

      if (type === 41) {
        if (section !== 2 || owner.name !== '.' || optSeen || (ttl >>> 24) !== 0 || ((ttl >>> 16) & 0xff) !== 0) {
          throw new Error('Browser DNS resolver returned a malformed response')
        }
        optSeen = true
      } else if (recordClass === 1 && type === 5) {
        const target = readDnsName(response, dataOffset)
        if (target.nextOffset !== dataEnd) throw new Error('Browser DNS resolver returned a malformed response')
        if (section === 0) {
          if (cnameByOwner.has(owner.name)) throw new Error('Browser DNS resolver returned a malformed response')
          cnameByOwner.set(owner.name, target.name)
        }
      } else if (type === 1) {
        if (dataLength !== 4) throw new Error('Browser DNS resolver returned a malformed response')
        if (recordClass === 1 && section === 0) {
          const address = [...response.subarray(dataOffset, dataEnd)].join('.')
          if (!isPublicBrowserAddress(address)) throw new Error('Private browser destination is not allowed')
          addressRecords.push({ owner: owner.name, address: { address, family: 4 } })
        }
      } else if (type === 28) {
        if (dataLength !== 16) throw new Error('Browser DNS resolver returned a malformed response')
        if (recordClass === 1 && section === 0) {
          const groups: string[] = []
          for (let cursor = dataOffset; cursor < dataEnd; cursor += 2) groups.push(view.readUInt16BE(cursor).toString(16))
          const address = groups.join(':')
          if (!isPublicBrowserAddress(address)) throw new Error('Private browser destination is not allowed')
          addressRecords.push({ owner: owner.name, address: { address, family: 6 } })
        }
      }
      offset = dataEnd
    }
  }
  if (offset !== response.byteLength) throw new Error('Browser DNS resolver returned a malformed response')

  const allowedOwners = new Set<string>([expectedName])
  let current = expectedName
  for (let depth = 0; cnameByOwner.has(current); depth += 1) {
    if (depth >= DOH_MAX_CNAME_DEPTH) throw new Error('Browser DNS resolver returned a malformed response')
    current = cnameByOwner.get(current)!
    if (allowedOwners.has(current)) throw new Error('Browser DNS resolver returned a malformed response')
    allowedOwners.add(current)
  }
  return addressRecords
    .filter(record => allowedOwners.has(record.owner) && record.address.family === (expectedType === 1 ? 4 : 6))
    .map(record => record.address)
}

async function defaultDohRequest(input: DohRequestInput): Promise<DohResponse> {
  return await new Promise<DohResponse>((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    const request = httpsRequest({
      protocol: 'https:',
      hostname: input.bootstrapAddress.address,
      family: input.bootstrapAddress.family,
      port: input.resolver.port ? Number(input.resolver.port) : 443,
      path: `${input.resolver.pathname}${input.resolver.search}`,
      method: 'POST',
      servername: input.resolver.hostname,
      rejectUnauthorized: true,
      headers: {
        Host: input.resolver.host,
        Accept: 'application/dns-message',
        'Content-Type': 'application/dns-message',
        'Content-Length': input.query.byteLength,
      },
    }, response => {
      response.once('error', reject)
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > DOH_RESPONSE_LIMIT_BYTES) {
        response.destroy(new Error('Browser DNS resolver response is too large'))
        return
      }
      response.on('data', (chunk: Buffer) => {
        received += chunk.byteLength
        if (received > DOH_RESPONSE_LIMIT_BYTES) {
          response.destroy(new Error('Browser DNS resolver response is too large'))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => resolve({
        statusCode: response.statusCode || 0,
        contentType: String(response.headers['content-type'] || ''),
        body: Buffer.concat(chunks),
      }))
    })
    request.setTimeout(DOH_TIMEOUT_MS, () => request.destroy(new Error('Browser DNS resolver timed out')))
    request.once('error', reject)
    request.end(input.query)
  })
}

export function parseBrowserDohBootstrapAddresses(value: string): string[] {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))]
}

export function isPublicBrowserAddress(address: string): boolean {
  let normalized = address.toLowerCase().split('%')[0]
  normalized = mappedIpv4(normalized) || normalized
  if (isIP(normalized) === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, prefix]) => ipv4InCidr(normalized, String(base), Number(prefix)))
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('::ffff:0:')) return false
    return ![
      ['::', 96], ['::ffff:0:0', 96], ['100::', 64], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
      ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
      ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8],
    ].some(([base, prefix]) => ipv6InCidr(normalized, String(base), Number(prefix)))
  }
  return false
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createConnectTunnel(client: Duplex, upstream: Duplex, head: Buffer = Buffer.alloc(0)): { start(): void } {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    client.unpipe(upstream)
    upstream.unpipe(client)
    client.destroy()
    upstream.destroy()
  }
  client.once('error', close)
  client.once('close', close)
  upstream.once('error', close)
  upstream.once('close', close)
  if (client.destroyed || upstream.destroyed) close()
  return {
    start() {
      if (closed || client.destroyed || upstream.destroyed) {
        close()
        return
      }
      try {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      } catch {
        close()
      }
    },
  }
}

export class BrowserEgressProxy {
  private readonly bindHost: string
  private readonly advertisedHost: string
  private readonly lookupAll: LookupAll
  private readonly dohUrl: URL | null
  private readonly dohBootstrapAddresses: ResolvedAddress[]
  private readonly dohRequest: DohRequest
  private readonly username = randomBytes(18).toString('base64url')
  private readonly password = randomBytes(32).toString('base64url')
  private server: Server | null = null

  constructor(options: {
    bindHost?: string
    advertisedHost?: string
    lookupAll?: LookupAll
    dohUrl?: string
    dohBootstrapAddresses?: string[]
    dohRequest?: DohRequest
  } = {}) {
    this.bindHost = String(options.bindHost || '127.0.0.1').trim()
    this.advertisedHost = String(options.advertisedHost || '127.0.0.1').trim()
    if (!this.bindHost || /[\s/@]/.test(this.bindHost) || (isIP(this.bindHost) === 0 && this.bindHost !== 'localhost')) {
      throw new Error('Invalid browser egress proxy bind host')
    }
    if (!this.advertisedHost || /[\s/@]/.test(this.advertisedHost)) throw new Error('Invalid browser egress proxy host')
    this.lookupAll = options.lookupAll || (async hostname => await lookup(hostname, { all: true, verbatim: true }))
    this.dohRequest = options.dohRequest || defaultDohRequest

    const rawDohUrl = String(options.dohUrl || '').trim()
    const rawBootstrapAddresses = options.dohBootstrapAddresses || []
    if (Boolean(rawDohUrl) !== Boolean(rawBootstrapAddresses.length)) {
      throw new Error('Browser DNS resolver URL and bootstrap addresses must be configured together')
    }
    if (rawDohUrl) {
      let parsed: URL
      try { parsed = new URL(rawDohUrl) } catch { throw new Error('Invalid browser DNS resolver URL') }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || isIP(parsed.hostname) !== 0) {
        throw new Error('Invalid browser DNS resolver URL')
      }
      const unique = new Map<string, ResolvedAddress>()
      for (const rawAddress of rawBootstrapAddresses) {
        const address = String(rawAddress || '').trim().toLowerCase().split('%')[0]
        const family = isIP(address)
        if (!family || !isPublicBrowserAddress(address)) throw new Error('Invalid browser DNS resolver bootstrap address')
        unique.set(`${family}:${address}`, { address, family })
      }
      if (!unique.size) throw new Error('Invalid browser DNS resolver bootstrap address')
      this.dohUrl = parsed
      this.dohBootstrapAddresses = [...unique.values()]
    } else {
      this.dohUrl = null
      this.dohBootstrapAddresses = []
    }
  }

  async start(): Promise<string> {
    if (this.server) return this.proxyUrl(this.server)
    const server = createServer((request, response) => { void this.handleHttp(request, response) })
    server.on('connect', (request, socket, head) => { void this.handleConnect(request, socket, head) })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, this.bindHost, () => resolve())
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
    let addresses = directFamily ? [{ address: normalized, family: directFamily }] : await this.lookupAll(normalized)
    if (!addresses.length) throw new Error('Private browser destination is not allowed')
    if (addresses.some(item => !isPublicBrowserAddress(item.address))) {
      const fakeIpMode = !directFamily
        && Boolean(this.dohUrl)
        && addresses.some(item => isBenchmarkingFakeIp(item.address))
        && addresses.every(item => isBenchmarkingFakeIp(item.address) || isPublicBrowserAddress(item.address))
      if (!fakeIpMode) throw new Error('Private browser destination is not allowed')
      addresses = await this.resolveWithDoh(normalized)
    }
    if (!addresses.length || addresses.some(item => !isPublicBrowserAddress(item.address))) throw new Error('Private browser destination is not allowed')
    return addresses[0]
  }

  private async resolveWithDoh(hostname: string): Promise<ResolvedAddress[]> {
    const resolver = this.dohUrl
    if (!resolver || !this.dohBootstrapAddresses.length) throw new Error('Private browser destination is not allowed')
    const query = async (type: 1 | 28): Promise<ResolvedAddress[]> => {
      const wireQuery = createDnsQuery(hostname, type)
      let lastError: unknown = new Error('Browser DNS resolver failed')
      for (const bootstrapAddress of this.dohBootstrapAddresses) {
        try {
          const response = await this.dohRequest({ resolver: new URL(resolver), bootstrapAddress, query: wireQuery })
          if (response.statusCode !== 200) throw new Error('Browser DNS resolver failed')
          const contentType = response.contentType.toLowerCase().split(';')[0].trim()
          if (contentType !== 'application/dns-message') throw new Error('Browser DNS resolver returned invalid content')
          return parseDnsResponse(wireQuery, response.body, hostname, type)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    }
    const [ipv4, ipv6] = await Promise.all([query(1), query(28)])
    const unique = new Map<string, ResolvedAddress>()
    for (const item of [...ipv4, ...ipv6]) unique.set(`${item.family}:${item.address}`, item)
    const addresses = [...unique.values()]
    if (!addresses.length || addresses.some(item => !isPublicBrowserAddress(item.address))) {
      throw new Error('Private browser destination is not allowed')
    }
    return addresses
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
    let clientGone = socket.destroyed === true
    const closeClient = () => {
      clientGone = true
      socket.destroy()
    }
    socket.once('error', closeClient)
    socket.once('close', closeClient)
    try {
      const target = new URL(`https://${request.url || ''}`)
      const destination = await this.resolvePublic(target.hostname)
      if (clientGone || socket.destroyed) return
      const upstream = tcpConnect({ host: destination.address, family: destination.family, port: target.port ? Number(target.port) : 443 })
      const tunnel = createConnectTunnel(socket, upstream, head)
      socket.off('error', closeClient)
      socket.off('close', closeClient)
      upstream.setTimeout(30_000, () => upstream.destroy())
      upstream.once('connect', () => tunnel.start())
      upstream.once('error', () => socket.destroy())
    } catch {
      if (!clientGone && !socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    }
  }
}
