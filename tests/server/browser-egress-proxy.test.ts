import { request } from 'node:http'
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

describe('Studio-managed browser egress proxy', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '0.0.0.0', '224.0.0.1',
    '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff00::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254',
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
