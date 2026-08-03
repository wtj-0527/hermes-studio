import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserControlProvider, BrowserOperationContext, BrowserProviderCapabilities } from './provider-registry'
import type { BrowserOwner, ManagedBrowserService } from './managed-browser-service'

const FULL_CAPABILITIES: BrowserProviderCapabilities = {
  tabs: true,
  navigation: true,
  snapshot: true,
  interaction: true,
  screenshot: true,
  console: true,
  liveView: true,
  takeover: true,
  profiles: true,
  downloads: true,
  annotations: true,
  htmlPreview: true,
}

const MANAGED_RUNTIME_CAPABILITIES: BrowserProviderCapabilities = {
  ...FULL_CAPABILITIES,
  profiles: false,
  downloads: false,
  annotations: false,
  htmlPreview: false,
}

interface ElectronBrokerDescriptor {
  schema: 1
  desktopPid: number
  endpoint: string
  token: string
  instanceId: string
}

interface ElectronBrokerSession {
  instanceId: string
  clientId: string
  token: string
}

function bearer(token: string): string {
  return `Bearer ${token}`
}

async function assertPrivateFile(path: string, label: string): Promise<void> {
  if (process.platform === 'win32') return
  const info = await stat(path)
  if ((info.mode & 0o077) !== 0) throw new Error(`Unsafe Electron Browser Broker ${label} permissions`)
}

export class ManagedBrowserControlProvider implements BrowserControlProvider {
  readonly id = 'managed-runtime'
  readonly kind = 'remote' as const
  readonly label = 'Managed'
  readonly capabilities = MANAGED_RUNTIME_CAPABILITIES

  constructor(private readonly service: Pick<ManagedBrowserService, 'configured' | 'acquired' | 'deactivate' | 'agentRequest'>) {}

  available(_owner?: BrowserOwner): boolean {
    return this.service.configured()
  }

  acquired(owner: BrowserOwner): boolean {
    return this.service.acquired(owner)
  }

  async deactivate(owner: BrowserOwner): Promise<void> {
    await this.service.deactivate(owner)
  }

  async agentRequest(owner: BrowserOwner, method: string, params: Record<string, unknown>, context?: BrowserOperationContext): Promise<unknown> {
    return await this.service.agentRequest(owner, method, params, context)
  }
}

export class ElectronBrowserControlProvider implements BrowserControlProvider {
  readonly id = 'electron-local'
  readonly kind = 'electron' as const
  readonly label = 'Electron'
  readonly capabilities = FULL_CAPABILITIES
  private session: ElectronBrokerSession | null = null
  private ownerKey: string | null = null
  private ownerAcquisition: { key: string; promise: Promise<ElectronBrokerSession> } | null = null
  private deactivation: Promise<void> | null = null
  private pendingReleaseTabIds: Set<string> | null = null
  private readonly activeRequests = new Set<Promise<unknown>>()
  private readonly appHome: string
  private readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>
  private readonly clientPid: number

  constructor(options: {
    appHome: string
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    clientPid?: number
  }) {
    this.appHome = options.appHome
    this.env = options.env || process.env
    this.clientPid = options.clientPid || process.pid
  }

  async available(_owner?: BrowserOwner): Promise<boolean> {
    if (String(this.env.HERMES_DESKTOP || '').trim().toLowerCase() !== 'true') return false
    try {
      await this.descriptor()
      return true
    } catch {
      return false
    }
  }

  acquired(owner: BrowserOwner): boolean {
    const key = `${Number(owner.userId)}:${String(owner.profile || '').trim()}`
    return this.ownerKey === key
  }

  async agentRequest(owner: BrowserOwner, method: string, params: Record<string, unknown>, context?: BrowserOperationContext): Promise<unknown> {
    if (this.pendingReleaseTabIds) throw new Error('Electron Browser provider is quarantined after an incomplete deactivation')
    if (this.deactivation) throw new Error('Electron Browser provider is being deactivated')
    // Register the complete operation before its first await. Otherwise deactivate()
    // can observe an empty set during owner/session acquisition and release the
    // provider before the late Broker request is dispatched.
    const request = this.performAgentRequest(owner, method, params, context)
    this.activeRequests.add(request)
    try {
      return await request
    } finally {
      this.activeRequests.delete(request)
    }
  }

  private async performAgentRequest(owner: BrowserOwner, method: string, params: Record<string, unknown>, context?: BrowserOperationContext): Promise<unknown> {
    const key = `${Number(owner.userId)}:${String(owner.profile || '').trim()}`
    if (this.ownerKey && this.ownerKey !== key) throw new Error('Electron Browser is assigned to another authenticated owner')
    const session = await this.acquireOwnerSession(key)
    const descriptor = await this.descriptor()
    if (session.instanceId !== descriptor.instanceId) throw new Error('Electron Browser Broker instance changed during the operation')
    const operationId = String(context?.operationId || randomUUID())
    return await this.brokerRequest(descriptor, session, method, params, operationId)
  }

  async deactivate(owner: BrowserOwner): Promise<void> {
    const key = `${Number(owner.userId)}:${String(owner.profile || '').trim()}`
    if (this.deactivation) {
      await this.deactivation
      return await this.deactivate(owner)
    }
    if (this.ownerAcquisition) {
      if (this.ownerAcquisition.key !== key) throw new Error('Electron Browser is assigned to another authenticated owner')
      try { await this.ownerAcquisition.promise } catch { return }
    }
    if (!this.ownerKey) return
    if (this.ownerKey !== key) throw new Error('Electron Browser is assigned to another authenticated owner')
    const deactivate = (async () => {
      await Promise.allSettled([...this.activeRequests])
      const descriptor = await this.descriptor()
      const session = await this.browserSession(descriptor)
      if (!this.pendingReleaseTabIds) {
        const state = await this.brokerRequest(descriptor, session, 'state', {}, randomUUID()) as { tabs?: Array<{ id?: unknown }> }
        this.pendingReleaseTabIds = new Set((Array.isArray(state?.tabs) ? state.tabs : [])
          .map(tab => typeof tab?.id === 'string' ? tab.id.trim() : '')
          .filter(Boolean))
      }
      for (const tabId of [...this.pendingReleaseTabIds]) {
        await this.brokerRequest(descriptor, session, 'lease.release', { tab_id: tabId }, randomUUID())
        this.pendingReleaseTabIds.delete(tabId)
      }
      this.pendingReleaseTabIds = null
      this.session = null
      this.ownerKey = null
    })()
    this.deactivation = deactivate
    try {
      await deactivate
    } finally {
      if (this.deactivation === deactivate) this.deactivation = null
    }
  }

  private async brokerRequest(
    descriptor: ElectronBrokerDescriptor,
    session: ElectronBrokerSession,
    method: string,
    params: Record<string, unknown>,
    operationId: string,
  ): Promise<unknown> {
    const response = await fetch(descriptor.endpoint, {
      method: 'POST',
      headers: {
        Authorization: bearer(session.token),
        'Content-Type': 'application/json',
        'X-Hermes-Browser-Client': session.clientId,
      },
      body: JSON.stringify({ method, params, operation_id: operationId }),
      signal: AbortSignal.timeout(45_000),
    })
    const payload = await response.json().catch(() => null) as { error?: string; operation_id?: string; result?: unknown } | null
    if (!response.ok) throw new Error(payload?.error || `Electron Browser Broker HTTP ${response.status}`)
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'result')) {
      throw new Error('Electron Browser Broker returned an invalid response')
    }
    if (payload.operation_id !== operationId) throw new Error('Electron Browser Broker operation identity mismatch')
    return payload.result
  }

  private async acquireOwnerSession(key: string): Promise<ElectronBrokerSession> {
    if (this.ownerKey) {
      if (this.ownerKey !== key) throw new Error('Electron Browser is assigned to another authenticated owner')
      const descriptor = await this.descriptor()
      return await this.browserSession(descriptor)
    }
    if (this.ownerAcquisition) {
      if (this.ownerAcquisition.key !== key) throw new Error('Electron Browser is assigned to another authenticated owner')
      return await this.ownerAcquisition.promise
    }
    const promise = (async () => {
      const descriptor = await this.descriptor()
      const session = await this.browserSession(descriptor)
      this.ownerKey = key
      return session
    })()
    this.ownerAcquisition = { key, promise }
    try {
      return await promise
    } catch (error) {
      if (this.ownerKey === key) this.ownerKey = null
      throw error
    } finally {
      if (this.ownerAcquisition?.promise === promise) this.ownerAcquisition = null
    }
  }

  private async descriptor(): Promise<ElectronBrokerDescriptor> {
    const directory = join(this.appHome, 'desktop-browser')
    const path = join(directory, 'broker.json')
    try {
      await assertPrivateFile(directory, 'directory')
      await assertPrivateFile(path, 'descriptor')
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<ElectronBrokerDescriptor>
      const endpoint = String(raw.endpoint || '')
      const parsed = new URL(endpoint)
      if (raw.schema !== 1 || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/v1') {
        throw new Error('Electron Browser Broker descriptor is invalid')
      }
      const token = String(raw.token || '')
      const instanceId = String(raw.instanceId || '')
      if (!token || !instanceId) throw new Error('Electron Browser Broker descriptor is invalid')
      if (!Number.isSafeInteger(raw.desktopPid) || Number(raw.desktopPid) <= 0) {
        throw new Error('Electron Browser Broker PID is invalid')
      }
      try {
        process.kill(Number(raw.desktopPid), 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('Electron Browser Broker is not running')
      }
      return {
        schema: 1,
        desktopPid: Number(raw.desktopPid),
        endpoint,
        token,
        instanceId,
      }
    } catch (error) {
      this.session = null
      if (error instanceof Error && /Electron Browser Broker/.test(error.message)) throw error
      throw new Error('Electron Browser Broker is not running')
    }
  }

  private async browserSession(descriptor: ElectronBrokerDescriptor): Promise<ElectronBrokerSession> {
    if (this.session?.instanceId === descriptor.instanceId) return this.session
    const sessionUrl = new URL(descriptor.endpoint)
    sessionUrl.pathname = '/v1/session'
    const response = await fetch(sessionUrl, {
      method: 'POST',
      headers: { Authorization: bearer(descriptor.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: `hermes-studio-control-plane:${this.clientPid}`, client_pid: this.clientPid }),
      signal: AbortSignal.timeout(10_000),
    })
    const payload = await response.json().catch(() => null) as { error?: string; client_id?: string; session_token?: string } | null
    if (!response.ok || !payload?.client_id || !payload.session_token) {
      throw new Error(payload?.error || 'Electron Browser Broker session failed')
    }
    this.session = {
      instanceId: descriptor.instanceId,
      clientId: payload.client_id,
      token: payload.session_token,
    }
    return this.session
  }
}
