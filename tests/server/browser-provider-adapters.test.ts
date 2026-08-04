import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ElectronBrowserControlProvider,
  ManagedBrowserControlProvider,
} from '../../packages/server/src/services/browser/provider-adapters'

let root = ''
let server: Server | null = null

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('browser control-plane provider adapters', () => {
  it('routes managed runtime operations through the existing runtime service without changing its runtime', async () => {
    const service = {
      configured: vi.fn(() => true),
      agentRequest: vi.fn(async (_owner, method, params) => ({ method, params })),
    }
    const provider = new ManagedBrowserControlProvider(service as any)
    const owner = { userId: 7, profile: 'work' }

    expect(await provider.available()).toBe(true)
    expect(provider.capabilities).toMatchObject({ profiles: false, downloads: false, annotations: false, htmlPreview: false })
    await expect(provider.agentRequest(owner, 'tabs.list', {})).resolves.toEqual({ method: 'tabs.list', params: {} })
    expect(service.agentRequest).toHaveBeenCalledWith(owner, 'tabs.list', {}, undefined)
  })

  it('controls the unchanged Electron Browser Broker through an authenticated provider adapter', async () => {
    root = await mkdtemp(join(tmpdir(), 'electron-browser-provider-'))
    const requests: any[] = []
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ url: request.url, headers: request.headers, body })
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') {
        response.end(JSON.stringify({ client_id: 'client-1', session_token: 'session-token' }))
        return
      }
      response.end(JSON.stringify({ operation_id: body.operation_id, result: { tabs: [{ id: 'tab-1' }] } }))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('broker fixture failed to bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await chmod(brokerRoot, 0o700)
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({
      schema: 1,
      desktopPid: process.pid,
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      token: 'broker-token',
      instanceId: 'desktop-instance-1',
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 })

    const provider = new ElectronBrowserControlProvider({ appHome: root, env: { HERMES_DESKTOP: 'true' } })
    const owner = { userId: 7, profile: 'work' }
    expect(await provider.available(owner)).toBe(true)
    await expect(provider.agentRequest(owner, 'tabs.list', {}, { operationId: 'operation-1' })).resolves.toEqual({ tabs: [{ id: 'tab-1' }] })
    await expect(provider.agentRequest({ userId: 7, profile: 'other' }, 'tabs.list', {}, { operationId: 'operation-2' })).rejects.toThrow('assigned to another authenticated owner')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ url: '/v1/session', body: { client_pid: process.pid } })
    expect(requests[1].headers['x-hermes-browser-client']).toBe('client-1')
    expect(requests[1].headers.authorization).toBe('Bearer session-token')
    expect(requests[1].body).toMatchObject({ method: 'tabs.list', params: {}, operation_id: 'operation-1' })

    await provider.deactivate(owner)
    expect(requests.slice(2).map(request => request.body.method)).toEqual(['state', 'lease.release'])
    await expect(provider.agentRequest({ userId: 8, profile: 'other' }, 'tabs.list', {}, { operationId: 'operation-3' })).resolves.toEqual({ tabs: [{ id: 'tab-1' }] })
    expect(requests.filter(request => request.url === '/v1/session')).toHaveLength(2)
  })

  it('reports Electron unavailable instead of weakening descriptor validation', async () => {
    root = await mkdtemp(join(tmpdir(), 'electron-browser-provider-invalid-'))
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o755 })
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({
      schema: 1,
      desktopPid: process.pid,
      endpoint: 'http://0.0.0.0:9999/v1',
      token: 'token',
      instanceId: 'invalid',
    }), { mode: 0o644 })
    const provider = new ElectronBrowserControlProvider({ appHome: root, env: { HERMES_DESKTOP: 'true' } })

    expect(await provider.available({ userId: 7, profile: 'work' })).toBe(false)
    await expect(provider.agentRequest({ userId: 7, profile: 'work' }, 'tabs.list', {})).rejects.toThrow(/Unsafe Electron Browser Broker|not running/)
  })

  it('does not permanently fence another owner when initial Broker session acquisition fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'electron-browser-provider-retry-'))
    let sessionAttempts = 0
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') {
        sessionAttempts += 1
        if (sessionAttempts === 1) { response.statusCode = 503; response.end(JSON.stringify({ error: 'not ready' })); return }
        response.end(JSON.stringify({ client_id: 'client-2', session_token: 'session-token-2' }))
        return
      }
      response.end(JSON.stringify({ operation_id: body.operation_id, result: { ok: true } }))
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('broker fixture failed to bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await chmod(brokerRoot, 0o700)
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({ schema: 1, desktopPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'broker-token', instanceId: 'desktop-instance-1' }), { mode: 0o600 })
    const provider = new ElectronBrowserControlProvider({ appHome: root, env: { HERMES_DESKTOP: 'true' } })

    await expect(provider.agentRequest({ userId: 7, profile: 'work' }, 'tabs.list', {}, { operationId: 'failed-op' })).rejects.toThrow('not ready')
    await expect(provider.agentRequest({ userId: 8, profile: 'work' }, 'tabs.list', {}, { operationId: 'retry-op' })).resolves.toEqual({ ok: true })
  })

  it('fails closed when the Electron Broker returns a different operation identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'electron-browser-provider-operation-'))
    server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') response.end(JSON.stringify({ client_id: 'client-1', session_token: 'session-token' }))
      else response.end(JSON.stringify({ operation_id: 'wrong-operation', result: { ok: true } }))
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('broker fixture failed to bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await chmod(brokerRoot, 0o700)
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({ schema: 1, desktopPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'broker-token', instanceId: 'desktop-instance-1' }), { mode: 0o600 })
    const provider = new ElectronBrowserControlProvider({ appHome: root, env: { HERMES_DESKTOP: 'true' } })

    await expect(provider.agentRequest({ userId: 7, profile: 'work' }, 'tabs.list', {}, { operationId: 'expected-operation' })).rejects.toThrow('identity mismatch')
  })

  it('atomically fences concurrent owners and waits for the complete accepted operation before deactivation', async () => {
    root = await mkdtemp(join(tmpdir(), 'electron-browser-provider-lifecycle-'))
    let operationReceived!: () => void
    let finishOperation!: () => void
    const received = new Promise<void>(resolve => { operationReceived = resolve })
    const finish = new Promise<void>(resolve => { finishOperation = resolve })
    const methods: string[] = []
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') {
        response.end(JSON.stringify({ client_id: 'client-1', session_token: 'session-token' }))
        return
      }
      methods.push(body.method)
      if (body.method === 'tabs.list') {
        operationReceived()
        await finish
        response.end(JSON.stringify({ operation_id: body.operation_id, result: { tabs: [] } }))
        return
      }
      response.end(JSON.stringify({ operation_id: body.operation_id, result: { tabs: [] } }))
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('broker fixture failed to bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await chmod(brokerRoot, 0o700)
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({ schema: 1, desktopPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'broker-token', instanceId: 'desktop-instance-1' }), { mode: 0o600 })
    const provider = new ElectronBrowserControlProvider({ appHome: root, env: { HERMES_DESKTOP: 'true' } })
    const owner = { userId: 7, profile: 'work' }

    const operation = provider.agentRequest(owner, 'tabs.list', {}, { operationId: 'slow-operation' })
    await expect(provider.agentRequest({ userId: 8, profile: 'work' }, 'tabs.list', {}, { operationId: 'other-operation' })).rejects.toThrow('assigned to another authenticated owner')
    await received
    let deactivated = false
    const deactivation = provider.deactivate(owner).then(() => { deactivated = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(deactivated).toBe(false)
    expect(methods).toEqual(['tabs.list'])

    finishOperation()
    await expect(operation).resolves.toEqual({ tabs: [] })
    await deactivation
    expect(methods).toEqual(['tabs.list', 'state'])
  })

  it('quarantines a partially released Electron lease set and retries only unfinished releases', async () => {
    root = await mkdtemp(join(tmpdir(), 'electron-browser-provider-release-'))
    const releaseAttempts: string[] = []
    let failSecond = true
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') {
        response.end(JSON.stringify({ client_id: 'client-1', session_token: 'session-token' }))
        return
      }
      if (body.method === 'state') {
        response.end(JSON.stringify({ operation_id: body.operation_id, result: { tabs: [{ id: 'tab-1' }, { id: 'tab-2' }] } }))
        return
      }
      if (body.method === 'lease.release') {
        releaseAttempts.push(body.params.tab_id)
        if (body.params.tab_id === 'tab-2' && failSecond) {
          failSecond = false
          response.statusCode = 503
          response.end(JSON.stringify({ error: 'release failed' }))
          return
        }
      }
      response.end(JSON.stringify({ operation_id: body.operation_id, result: { ok: true } }))
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('broker fixture failed to bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await chmod(brokerRoot, 0o700)
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({ schema: 1, desktopPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'broker-token', instanceId: 'desktop-instance-1' }), { mode: 0o600 })
    const provider = new ElectronBrowserControlProvider({ appHome: root, env: { HERMES_DESKTOP: 'true' } })
    const owner = { userId: 7, profile: 'work' }
    await provider.agentRequest(owner, 'tabs.list', {}, { operationId: 'initial' })

    await expect(provider.deactivate(owner)).rejects.toThrow('release failed')
    await expect(provider.agentRequest(owner, 'tabs.list', {}, { operationId: 'blocked' })).rejects.toThrow('quarantined')
    await expect(provider.agentRequest({ userId: 8, profile: 'other' }, 'tabs.list', {}, { operationId: 'blocked-other' })).rejects.toThrow('quarantined')

    await expect(provider.deactivate(owner)).resolves.toBeUndefined()
    expect(releaseAttempts).toEqual(['tab-1', 'tab-2', 'tab-2'])
    await expect(provider.agentRequest({ userId: 8, profile: 'other' }, 'tabs.list', {}, { operationId: 'next-owner' })).resolves.toEqual({ ok: true })
  })
})
