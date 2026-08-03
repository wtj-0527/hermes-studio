import { request } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserEgressProxy, isPublicBrowserAddress } from '../../packages/server/src/services/browser/browser-egress-proxy'

const proxies: BrowserEgressProxy[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
})

async function proxyRequest(proxyUrl: string, targetUrl: string, authenticated = true): Promise<number> {
  const proxy = new URL(proxyUrl)
  return await new Promise<number>((resolve, reject) => {
    const req = request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'GET',
      path: targetUrl,
      headers: authenticated
        ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }
        : {},
    }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode || 0))
    })
    req.on('error', reject)
    req.end()
  })
}

async function proxyConnect(proxyUrl: string, authority: string): Promise<string> {
  const proxy = new URL(proxyUrl)
  const authorization = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) })
    let response = ''
    let settled = false
    const finish = () => {
      if (settled || !response.includes('\r\n\r\n')) return
      settled = true
      socket.destroy()
      resolve(response)
    }
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`)
    })
    socket.on('data', chunk => { response += chunk; finish() })
    socket.on('end', () => { if (!settled) { settled = true; resolve(response) } })
    socket.on('error', error => { if (!settled) reject(error) })
  })
}

describe('Studio-managed browser egress proxy', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '0.0.0.0', '224.0.0.1',
    '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff00::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1',
    '::ffff:0:7f00:1', '::ffff:0:a00:1', '::ffff:0:a9fe:a9fe',
    '::7f00:1', '::a9fe:a9fe',
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::7f00:1', '64:ff9b:1::a00:1', '64:ff9b:1::a9fe:a9fe',
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2002:7f00:1::', '2002:a00:1::', '2002:a9fe:a9fe::',
  ])('rejects non-public address %s', address => {
    expect(isPublicBrowserAddress(address)).toBe(false)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('accepts public address %s', address => {
    expect(isPublicBrowserAddress(address)).toBe(true)
  })

  it('requires proxy authentication before resolving a destination', async () => {
    let lookups = 0
    const proxy = new BrowserEgressProxy({ lookupAll: async () => { lookups += 1; return [{ address: '1.1.1.1', family: 4 }] } })
    proxies.push(proxy)
    const url = await proxy.start()
    expect(await proxyRequest(url, 'http://example.test/', false)).toBe(407)
    expect(lookups).toBe(0)
  })

  it('binds the authenticated proxy to an explicit private-network address while advertising the service hostname', async () => {
    const proxy = new BrowserEgressProxy({ bindHost: '0.0.0.0', advertisedHost: 'hermes-webui' })
    proxies.push(proxy)
    const url = new URL(await proxy.start())
    const address = (proxy as unknown as { server: { address(): unknown } }).server.address() as { address: string }
    expect(address.address).toBe('0.0.0.0')
    expect(url.hostname).toBe('hermes-webui')
    expect(url.username).toBeTruthy()
    expect(url.password).toBeTruthy()
  })

  it('binds the authenticated proxy only to IPv4 loopback by default', async () => {
    const proxy = new BrowserEgressProxy()
    proxies.push(proxy)
    await proxy.start()
    const address = (proxy as unknown as { server: { address(): unknown } }).server.address() as { address: string }
    expect(address.address).toBe('127.0.0.1')
  })

  it('rejects authenticated CONNECT tunnels to loopback before dialing', async () => {
    let lookups = 0
    const proxy = new BrowserEgressProxy({ lookupAll: async () => { lookups += 1; return [{ address: '1.1.1.1', family: 4 }] } })
    proxies.push(proxy)
    const url = await proxy.start()
    expect(await proxyConnect(url, '127.0.0.1:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[::1]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[::ffff:7f00:1]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[::ffff:a9fe:a9fe]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[::ffff:a00:1]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[64:ff9b::7f00:1]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[64:ff9b:1::a9fe:a9fe]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(await proxyConnect(url, '[2002:a00:1::]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/m)
    expect(lookups).toBe(0)
  })

  it('rejects IPv4-transition literals in absolute-form HTTP requests', async () => {
    const proxy = new BrowserEgressProxy({ lookupAll: async () => { throw new Error('literal addresses must not use DNS') } })
    proxies.push(proxy)
    const url = await proxy.start()
    for (const address of [
      '64:ff9b::7f00:1',
      '64:ff9b:1::a9fe:a9fe',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2002:a00:1::',
    ]) {
      expect(await proxyRequest(url, `http://[${address}]/`)).toBe(403)
    }
  })

  it.each(['localhost', 'sub.localhost'])('rejects reserved localhost hostname %s', async hostname => {
    let lookups = 0
    const proxy = new BrowserEgressProxy({ lookupAll: async () => { lookups += 1; return [{ address: '1.1.1.1', family: 4 }] } })
    proxies.push(proxy)
    const url = await proxy.start()
    expect(await proxyRequest(url, `http://${hostname}/`)).toBe(403)
    expect(lookups).toBe(0)
  })

  it('fails closed before dialing when any DNS result is private', async () => {
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })
    proxies.push(proxy)
    const url = await proxy.start()
    expect(await proxyRequest(url, 'http://rebinding.example/')).toBe(403)
  })
})
