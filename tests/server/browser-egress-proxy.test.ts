import { request } from 'node:http'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserEgressProxy, createConnectTunnel, isPublicBrowserAddress, parseBrowserDohBootstrapAddresses } from '../../packages/server/src/services/browser/browser-egress-proxy'

const proxies: BrowserEgressProxy[] = []

function dnsQuestionType(query: Uint8Array): number {
  return (query[query.length - 4] << 8) | query[query.length - 3]
}

function dnsResponse(
  query: Uint8Array,
  answers: Array<{ type: 1 | 28; data: Uint8Array }> = [],
  options: { question?: Uint8Array; flags?: number } = {},
): Uint8Array {
  const question = options.question || query.slice(12)
  const answerBytes = answers.map(answer => {
    const record = Buffer.alloc(12 + answer.data.length)
    record.writeUInt16BE(0xc00c, 0)
    record.writeUInt16BE(answer.type, 2)
    record.writeUInt16BE(1, 4)
    record.writeUInt32BE(60, 6)
    record.writeUInt16BE(answer.data.length, 10)
    Buffer.from(answer.data).copy(record, 12)
    return record
  })
  const header = Buffer.alloc(12)
  header.writeUInt16BE((query[0] << 8) | query[1], 0)
  header.writeUInt16BE(options.flags ?? 0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answers.length, 6)
  return Buffer.concat([header, Buffer.from(question), ...answerBytes])
}

function dnsResponseWithRootOpt(
  query: Uint8Array,
  answers: Array<{ type: 1 | 28; data: Uint8Array }> = [],
): Uint8Array {
  const response = Buffer.from(dnsResponse(query, answers))
  response.writeUInt16BE(1, 10)
  const opt = Buffer.alloc(11)
  opt[0] = 0
  opt.writeUInt16BE(41, 1)
  opt.writeUInt16BE(4096, 3)
  return Buffer.concat([response, opt])
}

function dnsName(name: string): Buffer {
  if (name === '.') return Buffer.from([0])
  return Buffer.concat([...name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])])
}

function dnsRecord(options: {
  owner?: Buffer
  type: number
  recordClass?: number
  ttl?: number
  data: Uint8Array
}): Buffer {
  const owner = options.owner || Buffer.from([0xc0, 0x0c])
  const record = Buffer.alloc(10 + options.data.length)
  record.writeUInt16BE(options.type, 0)
  record.writeUInt16BE(options.recordClass ?? 1, 2)
  record.writeUInt32BE(options.ttl ?? 60, 4)
  record.writeUInt16BE(options.data.length, 8)
  Buffer.from(options.data).copy(record, 10)
  return Buffer.concat([owner, record])
}

function dnsSectionedResponse(
  query: Uint8Array,
  options: {
    flags?: number
    answers?: Buffer[]
    authority?: Buffer[]
    additional?: Buffer[]
    padding?: Buffer
  } = {},
): Uint8Array {
  const answers = options.answers || []
  const authority = options.authority || []
  const additional = options.additional || []
  const header = Buffer.alloc(12)
  header.writeUInt16BE((query[0] << 8) | query[1], 0)
  header.writeUInt16BE(options.flags ?? 0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(authority.length, 8)
  header.writeUInt16BE(additional.length, 10)
  return Buffer.concat([header, Buffer.from(query.slice(12)), ...answers, ...authority, ...additional, options.padding || Buffer.alloc(0)])
}

async function resolveThroughDoh(
  responseFor: (query: Uint8Array) => Uint8Array,
): Promise<unknown> {
  const proxy = new BrowserEgressProxy({
    lookupAll: async () => [{ address: '198.19.0.35', family: 4 }],
    dohUrl: 'https://resolver.example/dns-query',
    dohBootstrapAddresses: ['1.1.1.1'],
    dohRequest: async request => ({
      statusCode: 200,
      contentType: 'application/dns-message',
      body: responseFor(request.query),
    }),
  })
  return await (proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('example.com')
}

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
  it('contains a CONNECT client reset while destination DNS is still pending', async () => {
    let lookupStartedResolve!: () => void
    const lookupStarted = new Promise<void>(resolve => { lookupStartedResolve = resolve })
    let lookupResolve!: (addresses: Array<{ address: string; family: number }>) => void
    const lookupPending = new Promise<Array<{ address: string; family: number }>>(resolve => { lookupResolve = resolve })
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => {
        lookupStartedResolve()
        return await lookupPending
      },
    })
    proxies.push(proxy)
    const proxyUrl = new URL(await proxy.start())
    const authorization = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')
    const client = new PassThrough()
    const handling = (proxy as unknown as {
      handleConnect(request: { url: string; headers: Record<string, string> }, socket: PassThrough, head: Buffer): Promise<void>
    }).handleConnect({
      url: 'example.test:443',
      headers: { 'proxy-authorization': `Basic ${authorization}` },
    }, client, Buffer.alloc(0))
    await lookupStarted

    try {
      expect(() => client.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow()
    } finally {
      lookupResolve([{ address: '1.1.1.1', family: 4 }])
      await handling
    }

    expect(client.destroyed).toBe(true)
  })

  it('closes the upstream immediately when the CONNECT client already disappeared', async () => {
    const client = new PassThrough()
    const upstream = new PassThrough()
    client.destroy()
    await new Promise(resolve => setImmediate(resolve))

    createConnectTunnel(client, upstream)

    expect(upstream.destroyed).toBe(true)
  })

  it('contains a client-side EPIPE and closes both CONNECT tunnel directions', async () => {
    const client = new PassThrough()
    const upstream = new PassThrough()
    const tunnel = createConnectTunnel(client, upstream)
    tunnel.start()

    client.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await new Promise(resolve => setImmediate(resolve))

    expect(client.destroyed).toBe(true)
    expect(upstream.destroyed).toBe(true)
  })

  it('closes the client when the CONNECT upstream fails', async () => {
    const client = new PassThrough()
    const upstream = new PassThrough()
    const tunnel = createConnectTunnel(client, upstream)
    tunnel.start()

    upstream.destroy(new Error('upstream reset'))
    await new Promise(resolve => setImmediate(resolve))

    expect(client.destroyed).toBe(true)
    expect(upstream.destroyed).toBe(true)
  })

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

  it('uses an explicit public bootstrap IP and RFC 8484 wire queries when system DNS returns Fake-IP answers', async () => {
    const requests: Array<{ resolver: URL; bootstrapAddress: { address: string; family: number }; query: Uint8Array }> = []
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [
        { address: '198.19.0.35', family: 4 },
        { address: '2001:480:abcd::22', family: 6 },
      ],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async request => {
        requests.push(request)
        const type = dnsQuestionType(request.query)
        const answers = type === 1
          ? [{ type: 1 as const, data: Uint8Array.from([104, 20, 23, 154]) }]
          : []
        return {
          statusCode: 200,
          contentType: 'application/dns-message',
          body: dnsResponse(request.query, answers),
        }
      },
    })

    const resolved = await (proxy as unknown as { resolvePublic(hostname: string): Promise<{ address: string; family: number }> }).resolvePublic('example.com')

    expect(resolved).toEqual({ address: '104.20.23.154', family: 4 })
    expect(requests).toHaveLength(2)
    expect(requests.every(item => item.resolver.href === 'https://resolver.example/dns-query')).toBe(true)
    expect(requests.every(item => item.bootstrapAddress.address === '1.1.1.1')).toBe(true)
    expect(requests.map(item => dnsQuestionType(item.query)).sort((a, b) => a - b)).toEqual([1, 28])
  })

  it('keeps the HTTPS resolver disabled when system DNS is already public', async () => {
    let requests = 0
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [{ address: '1.1.1.1', family: 4 }],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async () => { requests += 1; throw new Error('unexpected resolver call') },
    })

    await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('example.com'))
      .resolves.toEqual({ address: '1.1.1.1', family: 4 })
    expect(requests).toBe(0)
  })

  it('does not use DoH to wash a non-Fake-IP private system answer', async () => {
    let requests = 0
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [
        { address: '198.19.0.35', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async () => { requests += 1; throw new Error('unexpected resolver call') },
    })

    await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('rebinding.example'))
      .rejects.toThrow('Private browser destination')
    expect(requests).toBe(0)
  })

  it('accepts a standard wire response with a root-owner OPT additional record', async () => {
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [{ address: '198.19.0.35', family: 4 }],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async request => ({
        statusCode: 200,
        contentType: 'application/dns-message',
        body: dnsResponseWithRootOpt(request.query, dnsQuestionType(request.query) === 1
          ? [{ type: 1, data: Uint8Array.from([104, 20, 23, 154]) }]
          : []),
      }),
    })

    await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('example.com'))
      .resolves.toEqual({ address: '104.20.23.154', family: 4 })
  })

  it('fails closed when a wire resolver response contains any private address', async () => {
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [{ address: '198.19.0.35', family: 4 }],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async request => ({
        statusCode: 200,
        contentType: 'application/dns-message',
        body: dnsResponse(request.query, dnsQuestionType(request.query) === 1 ? [
          { type: 1, data: Uint8Array.from([104, 20, 23, 154]) },
          { type: 1, data: Uint8Array.from([127, 0, 0, 1]) },
        ] : []),
      }),
    })

    await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('rebinding.example'))
      .rejects.toThrow('Private browser destination')
  })

  it('fails closed on a mismatched DNS question', async () => {
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [{ address: '198.19.0.35', family: 4 }],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async request => {
        const wrongQuestion = request.query.slice(12)
        wrongQuestion[1] = wrongQuestion[1] === 101 ? 120 : 101
        return {
          statusCode: 200,
          contentType: 'application/dns-message',
          body: dnsResponse(request.query, [], { question: wrongQuestion }),
        }
      },
    })

    await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('example.com'))
      .rejects.toThrow('DNS resolver')
  })

  it('fails closed when a wire resolver returns an oversized body', async () => {
    const proxy = new BrowserEgressProxy({
      lookupAll: async () => [{ address: '198.19.0.35', family: 4 }],
      dohUrl: 'https://resolver.example/dns-query',
      dohBootstrapAddresses: ['1.1.1.1'],
      dohRequest: async () => ({
        statusCode: 200,
        contentType: 'application/dns-message',
        body: new Uint8Array(65 * 1024),
      }),
    })

    await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('example.com'))
      .rejects.toThrow('too large')
  })

  it('fails closed on redirects and non-wire resolver content', async () => {
    for (const response of [
      { statusCode: 302, contentType: 'application/dns-message', body: new Uint8Array() },
      { statusCode: 200, contentType: 'application/json', body: new Uint8Array() },
    ]) {
      const proxy = new BrowserEgressProxy({
        lookupAll: async () => [{ address: '198.19.0.35', family: 4 }],
        dohUrl: 'https://resolver.example/dns-query',
        dohBootstrapAddresses: ['1.1.1.1'],
        dohRequest: async () => response,
      })
      await expect((proxy as unknown as { resolvePublic(hostname: string): Promise<unknown> }).resolvePublic('example.com'))
        .rejects.toThrow('DNS resolver')
    }
  })

  it('parses and deduplicates configured resolver bootstrap IPs', () => {
    expect(parseBrowserDohBootstrapAddresses(' 1.1.1.1, 2606:4700:4700::1111,1.1.1.1 '))
      .toEqual(['1.1.1.1', '2606:4700:4700::1111'])
    expect(parseBrowserDohBootstrapAddresses('')).toEqual([])
  })

  it.each([
    { dohUrl: 'http://resolver.example/dns-query', dohBootstrapAddresses: ['1.1.1.1'] },
    { dohUrl: 'https://user:password@resolver.example/dns-query', dohBootstrapAddresses: ['1.1.1.1'] },
    { dohUrl: 'https://resolver.example/dns-query#fragment', dohBootstrapAddresses: ['1.1.1.1'] },
    { dohUrl: 'https://resolver.example/dns-query', dohBootstrapAddresses: [] },
    { dohBootstrapAddresses: ['1.1.1.1'] },
    { dohUrl: 'https://resolver.example/dns-query', dohBootstrapAddresses: ['127.0.0.1'] },
  ])('rejects unsafe or incomplete resolver configuration %#', (options) => {
    expect(() => new BrowserEgressProxy(options)).toThrow('DNS resolver')
  })

  it('rejects deprecated IPv6 site-local space across direct and DoH resolution', async () => {
    expect(isPublicBrowserAddress('fec0::1')).toBe(false)
    const siteLocal = Uint8Array.from([0xfe, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    await expect(resolveThroughDoh(query => dnsQuestionType(query) === 28
      ? dnsResponse(query, [{ type: 28, data: siteLocal }])
      : dnsResponse(query)))
      .rejects.toThrow('Private browser destination')
  })

  it('rejects a DNS response whose exact size is 65536 bytes', async () => {
    await expect(resolveThroughDoh(query => {
      const valid = dnsResponse(query, dnsQuestionType(query) === 1
        ? [{ type: 1, data: Uint8Array.from([104, 20, 23, 154]) }]
        : [])
      return Buffer.concat([valid, Buffer.alloc(65536 - valid.byteLength)])
    })).rejects.toThrow('too large')
  })

  it.each([
    ['non-query opcode', 0x8980],
    ['reserved Z bit', 0x81c0],
    ['authenticated-data Z bit', 0x81a0],
    ['checking-disabled Z bit', 0x8190],
    ['basic response error code', 0x8183],
  ])('rejects a DNS response with %s', async (_label, flags) => {
    await expect(resolveThroughDoh(query => dnsResponse(query,
      dnsQuestionType(query) === 1 ? [{ type: 1, data: Uint8Array.from([104, 20, 23, 154]) }] : [],
      { flags },
    ))).rejects.toThrow('DNS resolver')
  })

  it('rejects an EDNS extended error response', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      answers: dnsQuestionType(query) === 1
        ? [dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) })]
        : [],
      additional: [dnsRecord({ owner: dnsName('.'), type: 41, recordClass: 4096, ttl: 0x01000000, data: new Uint8Array() })],
    }))).rejects.toThrow('DNS resolver')
  })

  it('does not accept a CNAME and address supplied only in Additional', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      additional: dnsQuestionType(query) === 1 ? [
        dnsRecord({ type: 5, data: dnsName('alias.example') }),
        dnsRecord({ owner: dnsName('alias.example'), type: 1, data: Uint8Array.from([104, 20, 23, 154]) }),
      ] : [],
    }))).rejects.toThrow('Private browser destination')
  })

  it('rejects a non-root EDNS OPT owner', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      answers: dnsQuestionType(query) === 1
        ? [dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) })]
        : [],
      additional: [dnsRecord({ type: 41, recordClass: 4096, data: new Uint8Array() })],
    }))).rejects.toThrow('DNS resolver')
  })

  it('rejects a compressed-pointer EDNS OPT root owner', async () => {
    await expect(resolveThroughDoh(query => {
      const questionRootOffset = query.length - 5
      return dnsSectionedResponse(query, {
        answers: dnsQuestionType(query) === 1
          ? [dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) })]
          : [],
        additional: [dnsRecord({
          owner: Buffer.from([0xc0 | (questionRootOffset >> 8), questionRootOffset & 0xff]),
          type: 41,
          recordClass: 4096,
          ttl: 0,
          data: new Uint8Array(),
        })],
      })
    })).rejects.toThrow('DNS resolver')
  })

  it('rejects a truncated EDNS option TLV', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      answers: dnsQuestionType(query) === 1
        ? [dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) })]
        : [],
      additional: [dnsRecord({
        owner: dnsName('.'),
        type: 41,
        recordClass: 4096,
        ttl: 0,
        data: Uint8Array.from([0, 1, 0, 2, 0]),
      })],
    }))).rejects.toThrow('DNS resolver')
  })

  it('rejects reserved EDNS OPT flags', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      answers: dnsQuestionType(query) === 1
        ? [dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) })]
        : [],
      additional: [dnsRecord({ owner: dnsName('.'), type: 41, recordClass: 4096, ttl: 1, data: new Uint8Array() })],
    }))).rejects.toThrow('DNS resolver')
  })

  it('rejects malformed A and AAAA record lengths even when another answer is valid', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      answers: dnsQuestionType(query) === 1 ? [
        dnsRecord({ type: 1, data: Uint8Array.from([127, 0, 0, 1, 0]) }),
        dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) }),
      ] : [dnsRecord({ type: 28, data: new Uint8Array(15) })],
    }))).rejects.toThrow('DNS resolver')
  })

  it('rejects malformed A and AAAA record lengths even for non-IN classes', async () => {
    await expect(resolveThroughDoh(query => dnsSectionedResponse(query, {
      answers: dnsQuestionType(query) === 1 ? [
        dnsRecord({ type: 1, recordClass: 3, data: Uint8Array.from([104, 20, 23, 154, 0]) }),
        dnsRecord({ type: 1, data: Uint8Array.from([104, 20, 23, 154]) }),
      ] : [
        dnsRecord({ type: 28, recordClass: 3, data: new Uint8Array(15) }),
      ],
    }))).rejects.toThrow('DNS resolver')
  })

  it('rejects forward DNS compression pointers', async () => {
    await expect(resolveThroughDoh(query => {
      if (dnsQuestionType(query) !== 1) return dnsResponse(query)
      const question = Buffer.from(query.slice(12))
      const header = Buffer.alloc(12)
      header.writeUInt16BE((query[0] << 8) | query[1], 0)
      header.writeUInt16BE(0x8180, 2)
      header.writeUInt16BE(1, 4)
      header.writeUInt16BE(2, 6)
      const firstOwnerOffset = 12 + question.length
      const futureNameOffset = firstOwnerOffset + 2 + 10 + 4 + 2 + 10
      const pointer = Buffer.from([0xc0 | (futureNameOffset >> 8), futureNameOffset & 0xff])
      return Buffer.concat([
        header,
        question,
        dnsRecord({ owner: pointer, type: 1, data: Uint8Array.from([104, 20, 23, 154]) }),
        dnsRecord({ owner: Buffer.from([0xc0, 0x0c]), type: 16, data: dnsName('example.com') }),
      ])
    })).rejects.toThrow('DNS resolver')
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
