import { randomBytes, randomUUID } from 'crypto'
import { isIP } from 'node:net'

export interface BrowserOwner {
  userId: number
  profile: string
}

export interface BrowserPageState {
  id: string
  title: string
  url: string
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed?: boolean
}

export interface BrowserRuntimeSession {
  id: string
  listPages(): Promise<BrowserPageState[]>
  createPage(url: string): Promise<BrowserPageState>
  closePage(pageId: string): Promise<void>
  activatePage(pageId: string): Promise<void>
  navigate(pageId: string, url: string): Promise<BrowserPageState>
  navigationAction(pageId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserPageState>
  snapshot(pageId: string): Promise<unknown>
  readText(pageId: string, input: Record<string, unknown>): Promise<unknown>
  interact(pageId: string, action: Record<string, unknown>): Promise<BrowserPageState>
  screenshot(pageId: string, fullPage: boolean): Promise<unknown>
  consoleEntries(pageId: string): Promise<unknown[]>
  clearConsole(pageId: string): Promise<void>
  cancelAgentOperation(pageId: string): Promise<void>
  liveViewWebSocketUrl(pageId: string): string
  liveViewWebSocketHeaders?(): Record<string, string>
  release(): Promise<void>
}

export interface BrowserRuntimeAdapter {
  startSession(input: { ownerKey: string; profile: string }): Promise<BrowserRuntimeSession>
}

interface OwnerRuntime {
  owner: BrowserOwner
  ownerKey: string
  session: BrowserRuntimeSession
  managedTabIds: Set<string>
  activeTabId?: string
  visible: boolean
  agentControls: Map<string, {
    state: 'idle' | 'active' | 'waiting-for-user'
    label?: string
    action?: string
  }>
  queues: Map<string, Promise<void>>
  tabGenerations: Map<string, number>
  takingOver: Set<string>
  releaseRetryOnly: boolean
}

interface ViewGrant {
  token: string
  ownerKey: string
  pageId: string
  expiresAt: number
}

export interface PortableBrowserState {
  available: boolean
  activeProfileId: string
  activeTabId?: string
  tabs: Array<BrowserPageState & {
    profileId: string
    crashed: boolean
    agentControl: 'idle' | 'active' | 'waiting-for-user'
    agentLabel?: string
    agentAction?: string
  }>
  profiles: Array<{
    id: string
    name: string
    rootPath: string
    sessionPath: string
    downloadPath: string
    proxyMode: 'direct'
    proxyRules: string
    askBeforeDownload: boolean
    downloadConflictPolicy: 'uniquify'
    createdAt: string
    lastUsedAt: string
    tabs: string[]
  }>
  downloads: []
  permissions: []
  visible: boolean
  maxTabs: number
}

const MAX_MANAGED_TABS = 8

function ownerKey(owner: BrowserOwner): string {
  const userId = Number(owner.userId)
  const profile = String(owner.profile || '').trim()
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('Authenticated browser user is required')
  if (!profile || profile.length > 200) throw new Error('Browser profile is required')
  return `${userId}:${profile}`
}

function isPrivateRuntimeHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number)
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00
  }
  return !host.includes('.') || host.endsWith('.internal') || host.endsWith('.local')
}

function configuredRuntimeUrl(env: NodeJS.ProcessEnv | Record<string, string | undefined>): URL | null {
  const raw = String(env.HERMES_BROWSER_RUNTIME_URL || '').trim()
  if (!raw) return null
  const url = new URL(raw)
  if (url.username || url.password) throw new Error('Managed Browser URL must not contain credentials')
  if (url.protocol !== 'http:') throw new Error('Managed Browser runtime must use a private HTTP endpoint')
  const host = url.hostname.toLowerCase()
  if (!isPrivateRuntimeHost(host)) throw new Error('Managed Browser runtime must use a private loopback or internal endpoint')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url
}

export class ManagedBrowserService {
  private readonly runtime: BrowserRuntimeAdapter
  private readonly configuredUrl: URL | null
  private readonly owners = new Map<string, OwnerRuntime>()
  private readonly grants = new Map<string, ViewGrant>()
  private readonly socketGrants = new Map<string, ViewGrant>()
  private readonly viewConnections = new Map<string, Set<() => void>>()
  private readonly ownerQueues = new Map<string, Promise<void>>()
  private readonly operations = new Map<string, { fingerprint: string; promise: Promise<unknown> }>()
  private runtimeOwnerKey: string | null = null
  private ownerAcquisition: { key: string; promise: Promise<OwnerRuntime> } | null = null
  private ownerRelease: { key: string; promise: Promise<void> } | null = null
  private readonly ownerAuthorized: (owner: BrowserOwner) => boolean

  constructor(options: { runtime: BrowserRuntimeAdapter; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; ownerAuthorized?: (owner: BrowserOwner) => boolean }) {
    this.runtime = options.runtime
    this.configuredUrl = configuredRuntimeUrl(options.env || process.env)
    this.ownerAuthorized = options.ownerAuthorized || (() => true)
  }

  configured(): boolean {
    return this.configuredUrl !== null
  }

  acquired(owner: BrowserOwner): boolean {
    return this.runtimeOwnerKey === ownerKey(owner)
  }

  runtimeUrl(): URL {
    if (!this.configuredUrl) throw new Error('Managed Browser is not configured')
    return new URL(this.configuredUrl)
  }

  async state(owner: BrowserOwner): Promise<PortableBrowserState> {
    if (!this.configured()) return this.emptyState(owner.profile)
    const key = ownerKey(owner)
    if (this.runtimeOwnerKey && this.runtimeOwnerKey !== key) {
      throw new Error('Managed Browser runtime is already assigned to another authenticated user')
    }
    const existing = this.owners.get(key)
    if (!existing) return this.emptyState(owner.profile, true)
    if (existing.releaseRetryOnly) {
      await this.releaseOwner(existing)
      return this.emptyState(owner.profile, true)
    }
    return await this.stateForRuntime(existing)
  }

  async createTab(owner: BrowserOwner, url = 'about:blank', activate = true): Promise<PortableBrowserState['tabs'][number]> {
    return await this.queuedOwner(ownerKey(owner), () => this.createTabUnlocked(owner, url, activate))
  }

  private async createTabUnlocked(owner: BrowserOwner, url = 'about:blank', activate = true): Promise<PortableBrowserState['tabs'][number]> {
    const runtime = await this.ensureOwner(owner)
    try {
      if (runtime.managedTabIds.size >= MAX_MANAGED_TABS) throw new Error(`Managed Browser tab limit is ${MAX_MANAGED_TABS}`)
      const page = await runtime.session.createPage(url)
      if (this.owners.get(runtime.ownerKey) !== runtime || runtime.releaseRetryOnly) {
        throw new Error('Browser operation was cancelled by owner release')
      }
      runtime.managedTabIds.add(page.id)
      if (activate || !runtime.activeTabId) runtime.activeTabId = page.id
      return this.publicPage(runtime, page)
    } catch (error) {
      if (!runtime.managedTabIds.size && this.owners.get(runtime.ownerKey) === runtime && !runtime.releaseRetryOnly) await this.releaseOwner(runtime)
      throw error
    }
  }

  async userCreateTab(owner: BrowserOwner, url = 'about:blank', activate = true): Promise<PortableBrowserState['tabs'][number]> {
    const runtime = this.owners.get(ownerKey(owner))
    if (runtime) {
      for (const tabId of [...runtime.managedTabIds]) await this.prepareUserMutation(owner, tabId)
    }
    return await this.createTab(owner, url, activate)
  }

  async closeTab(owner: BrowserOwner, tabId: string): Promise<PortableBrowserState> {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    await runtime.session.closePage(tabId)
    runtime.managedTabIds.delete(tabId)
    runtime.agentControls.delete(tabId)
    this.revokeViewGrants(runtime.ownerKey, tabId)
    this.revokeViewConnections(runtime.ownerKey, tabId)
    runtime.tabGenerations.set(tabId, (runtime.tabGenerations.get(tabId) || 0) + 1)
    const pages = (await runtime.session.listPages()).filter(page => runtime.managedTabIds.has(page.id))
    if (runtime.activeTabId === tabId) runtime.activeTabId = pages[0]?.id
    if (!runtime.managedTabIds.size) await this.releaseOwner(runtime)
    return runtime.managedTabIds.size ? await this.stateForRuntime(runtime) : this.emptyState(owner.profile, true)
  }

  async userCloseTab(owner: BrowserOwner, tabId: string): Promise<PortableBrowserState> {
    await this.prepareUserMutation(owner, tabId)
    return await this.closeTab(owner, tabId)
  }

  async activateTab(owner: BrowserOwner, tabId: string): Promise<PortableBrowserState> {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    await runtime.session.activatePage(tabId)
    runtime.activeTabId = tabId
    return await this.stateForRuntime(runtime)
  }

  async userActivateTab(owner: BrowserOwner, tabId: string): Promise<PortableBrowserState> {
    await this.prepareUserMutation(owner, tabId)
    return await this.activateTab(owner, tabId)
  }

  async navigate(owner: BrowserOwner, tabId: string, url: string): Promise<PortableBrowserState['tabs'][number]> {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    return this.publicPage(runtime, await runtime.session.navigate(tabId, url))
  }

  async userNavigate(owner: BrowserOwner, tabId: string, url: string): Promise<PortableBrowserState['tabs'][number]> {
    await this.prepareUserMutation(owner, tabId)
    return await this.navigate(owner, tabId, url)
  }

  async navigationAction(owner: BrowserOwner, tabId: string, action: 'back' | 'forward' | 'reload' | 'stop') {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    return this.publicPage(runtime, await runtime.session.navigationAction(tabId, action))
  }

  async userNavigationAction(owner: BrowserOwner, tabId: string, action: 'back' | 'forward' | 'reload' | 'stop') {
    await this.prepareUserMutation(owner, tabId)
    return await this.navigationAction(owner, tabId, action)
  }

  async setViewport(owner: BrowserOwner, visible: boolean): Promise<PortableBrowserState> {
    const runtime = this.requireOwner(owner)
    runtime.visible = visible
    return await this.stateForRuntime(runtime)
  }

  async takeOver(owner: BrowserOwner, tabId: string): Promise<PortableBrowserState> {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    if (runtime.takingOver.has(tabId)) throw new Error('Browser user takeover is already in progress')
    runtime.takingOver.add(tabId)
    runtime.tabGenerations.set(tabId, (runtime.tabGenerations.get(tabId) || 0) + 1)
    this.revokeViewGrants(runtime.ownerKey, tabId)
    this.revokeViewConnections(runtime.ownerKey, tabId)
    try {
      await runtime.session.cancelAgentOperation(tabId)
      await runtime.queues.get(tabId)?.catch(() => undefined)
      runtime.agentControls.set(tabId, { state: 'idle' })
      return await this.stateForRuntime(runtime)
    } finally {
      runtime.takingOver.delete(tabId)
    }
  }

  async deactivate(owner: BrowserOwner): Promise<void> {
    const key = ownerKey(owner)
    await this.ownerQueues.get(key)?.catch(() => undefined)
    const runtime = this.owners.get(key)
    if (!runtime) return
    if (runtime.releaseRetryOnly) return await this.releaseOwner(runtime)
    for (const tabId of runtime.managedTabIds) {
      if (runtime.takingOver.has(tabId)) throw new Error('Browser user takeover is already in progress')
      runtime.takingOver.add(tabId)
      runtime.tabGenerations.set(tabId, (runtime.tabGenerations.get(tabId) || 0) + 1)
      this.revokeViewGrants(runtime.ownerKey, tabId)
      this.revokeViewConnections(runtime.ownerKey, tabId)
    }
    try {
      await Promise.all([...runtime.managedTabIds].map(async tabId => {
        await runtime.session.cancelAgentOperation(tabId)
        await runtime.queues.get(tabId)?.catch(() => undefined)
      }))
      await this.releaseOwner(runtime)
    } finally {
      runtime.takingOver.clear()
    }
  }

  async issueView(owner: BrowserOwner, tabId: string): Promise<{ token: string; url: string }> {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    const token = randomBytes(32).toString('base64url')
    this.grants.set(token, { token, ownerKey: runtime.ownerKey, pageId: tabId, expiresAt: Date.now() + 5 * 60_000 })
    return { token, url: `/api/browser/view/${token}` }
  }

  resolveView(token: string, owner: BrowserOwner): ViewGrant {
    const grant = this.grants.get(token)
    if (!grant || grant.expiresAt <= Date.now() || grant.ownerKey !== ownerKey(owner)) {
      if (grant) this.grants.delete(token)
      throw new Error('Browser view not found')
    }
    return { ...grant }
  }

  consumeViewBootstrap(token: string): { socketPath: string } {
    const grant = this.grants.get(token)
    if (!grant || grant.expiresAt <= Date.now() || !this.isOwnerAuthorized(grant.ownerKey)) {
      if (grant) this.grants.delete(token)
      throw new Error('Browser view not found')
    }
    this.grants.delete(token)
    const socketToken = randomBytes(32).toString('base64url')
    this.socketGrants.set(socketToken, { ...grant, token: socketToken, expiresAt: Date.now() + 60_000 })
    return { socketPath: `/api/browser/view/${socketToken}/socket` }
  }

  private resolveSocketCapability(token: string): ViewGrant {
    const grant = this.socketGrants.get(token)
    if (!grant || grant.expiresAt <= Date.now() || !this.isOwnerAuthorized(grant.ownerKey)) {
      if (grant) this.socketGrants.delete(token)
      throw new Error('Browser view not found')
    }
    return { ...grant }
  }

  consumeViewCapabilityWebSocket(token: string): { url: string; headers: Record<string, string>; ownerKey: string; pageId: string } {
    const grant = this.resolveSocketCapability(token)
    this.socketGrants.delete(token)
    const runtime = this.owners.get(grant.ownerKey)
    if (!runtime) throw new Error('Browser view not found')
    if (!runtime.managedTabIds.has(grant.pageId) || runtime.takingOver.has(grant.pageId)) throw new Error('Browser view not found')
    return { url: runtime.session.liveViewWebSocketUrl(grant.pageId), headers: runtime.session.liveViewWebSocketHeaders?.() || {}, ownerKey: grant.ownerKey, pageId: grant.pageId }
  }

  attachViewConnection(owner: string, pageId: string, close: () => void): () => void {
    const key = `${owner}\0${pageId}`
    const connections = this.viewConnections.get(key) || new Set<() => void>()
    connections.add(close)
    this.viewConnections.set(key, connections)
    return () => {
      const current = this.viewConnections.get(key)
      current?.delete(close)
      if (!current?.size) this.viewConnections.delete(key)
    }
  }

  allowsViewInput(owner: string, pageId: string): boolean {
    if (!this.allowsViewAccess(owner, pageId)) return false
    const runtime = this.owners.get(owner)
    return Boolean(runtime
      && (runtime.agentControls.get(pageId)?.state || 'idle') === 'idle')
  }

  allowsViewAccess(owner: string, pageId: string): boolean {
    const runtime = this.owners.get(owner)
    return Boolean(runtime
      && this.ownerAuthorized(runtime.owner)
      && runtime.managedTabIds.has(pageId)
      && !runtime.takingOver.has(pageId))
  }

  resolveAgentOwner(profile: string): BrowserOwner {
    const matches = [...this.owners.values()].filter(item => item.owner.profile === profile)
    if (matches.length !== 1) throw new Error(matches.length ? 'Browser owner is ambiguous for this profile' : 'No Web browser is active for this profile')
    return { ...matches[0].owner }
  }

  async agentState(owner: BrowserOwner): Promise<PortableBrowserState> {
    return await this.stateForRuntime(this.requireOwner(owner))
  }

  async agentRequest(owner: BrowserOwner, method: string, params: Record<string, unknown>, context?: { operationId: string }): Promise<unknown> {
    const key = ownerKey(owner)
    const operationId = String(context?.operationId || randomUUID()).trim()
    const operationKey = `${key}\0${operationId}`
    const fingerprint = `${method}\0${JSON.stringify(params)}`
    const existing = this.operations.get(operationKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Browser operation identity conflicts with a different request')
      return await existing.promise
    }
    const execute = async () => {
      if (method === 'state' || method === 'tabs.list') return await this.state(owner)
      const runtime = method === 'tabs.create' ? await this.ensureOwner(owner) : this.requireOwner(owner)
      const tabId = String(params.tab_id || '').trim()
      if (!tabId) return await this.executeAgentRequest(owner, runtime, method, params, '', 0)
      if (runtime.takingOver.has(tabId)) throw new Error('Browser user takeover is in progress')
      const generation = runtime.tabGenerations.get(tabId) || 0
      return await this.queued(runtime, tabId, () => this.executeAgentRequest(owner, runtime, method, params, tabId, generation))
    }
    const promise = method === 'tabs.create' ? this.queuedOwner(key, execute) : execute()
    this.operations.set(operationKey, { fingerprint, promise })
    while (this.operations.size > 256) this.operations.delete(this.operations.keys().next().value as string)
    return await promise
  }

  private async executeAgentRequest(owner: BrowserOwner, runtime: OwnerRuntime, method: string, params: Record<string, unknown>, tabId: string, generation: number): Promise<unknown> {
    if (tabId && (runtime.tabGenerations.get(tabId) || 0) !== generation) throw new Error('Browser operation was cancelled by user takeover')
    let result: unknown
    if (method === 'state' || method === 'tabs.list') return await this.stateForRuntime(runtime)
    if (method === 'tabs.create') return await this.createTabUnlocked(owner, String(params.url || 'about:blank'), params.activate !== false)
    if (method === 'tabs.activate') return await this.activateTab(owner, tabId)
    if (method === 'tabs.close') return await this.closeTab(owner, tabId)
    if (method === 'navigate') return await this.navigate(owner, tabId, String(params.url || ''))
    if (method === 'navigation.action') {
      const action = String(params.action || '')
      if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') throw new Error('Invalid browser navigation action')
      return await this.navigationAction(owner, tabId, action)
    }
    await this.requirePage(runtime, tabId)
    runtime.agentControls.set(tabId, { state: 'active', label: 'Hermes Agent', action: method })
    if (method === 'snapshot') result = await runtime.session.snapshot(tabId)
    else if (method === 'text.read') result = await runtime.session.readText(tabId, params)
    else if (method === 'interact') result = await runtime.session.interact(tabId, (params.action || {}) as Record<string, unknown>)
    else if (method === 'screenshot') result = await runtime.session.screenshot(tabId, params.full_page === true)
    else if (method === 'console.read') result = await runtime.session.consoleEntries(tabId)
    else if (method === 'console.clear') { await runtime.session.clearConsole(tabId); result = { ok: true } }
    else if (method === 'lease.release') { runtime.agentControls.set(tabId, { state: 'idle' }); result = { ok: true } }
    else throw new Error(`Unknown browser method: ${method}`)
    if ((runtime.tabGenerations.get(tabId) || 0) !== generation) throw new Error('Browser operation was cancelled by user takeover')
    return result
  }

  async shutdown(): Promise<void> {
    let failure: unknown
    for (const item of [...this.owners.values()]) {
      try {
        await item.session.release()
        this.owners.delete(item.ownerKey)
        if (this.runtimeOwnerKey === item.ownerKey) this.runtimeOwnerKey = null
      } catch (error) {
        failure ??= error
      }
    }
    this.grants.clear()
    this.socketGrants.clear()
    for (const connections of this.viewConnections.values()) {
      for (const close of connections) {
        try { close() } catch { /* best-effort socket revocation */ }
      }
    }
    this.viewConnections.clear()
    if (!failure) this.runtimeOwnerKey = null
    if (failure) throw failure
  }

  private isOwnerAuthorized(key: string): boolean {
    const runtime = this.owners.get(key)
    return Boolean(runtime && this.ownerAuthorized(runtime.owner))
  }

  private async prepareUserMutation(owner: BrowserOwner, tabId: string): Promise<void> {
    const runtime = this.requireOwner(owner)
    await this.requirePage(runtime, tabId)
    if (runtime.takingOver.has(tabId)) throw new Error('Browser user takeover is already in progress')
    const control = runtime.agentControls.get(tabId)?.state || 'idle'
    if (control === 'idle' && !runtime.queues.has(tabId)) return
    runtime.takingOver.add(tabId)
    runtime.tabGenerations.set(tabId, (runtime.tabGenerations.get(tabId) || 0) + 1)
    this.revokeViewGrants(runtime.ownerKey, tabId)
    this.revokeViewConnections(runtime.ownerKey, tabId)
    try {
      await runtime.session.cancelAgentOperation(tabId)
      await runtime.queues.get(tabId)?.catch(() => undefined)
      runtime.agentControls.set(tabId, { state: 'idle' })
    } finally {
      runtime.takingOver.delete(tabId)
    }
  }

  private async ensureOwner(owner: BrowserOwner): Promise<OwnerRuntime> {
    if (!this.configured()) throw new Error('Managed Browser is not configured')
    const key = ownerKey(owner)
    if (this.runtimeOwnerKey && this.runtimeOwnerKey !== key) {
      throw new Error('Managed Browser runtime is already assigned to another authenticated user')
    }
    if (this.ownerRelease) throw new Error('Managed Browser runtime is being released')
    const existing = this.owners.get(key)
    if (existing?.releaseRetryOnly) {
      await this.releaseOwner(existing)
      return await this.ensureOwner(owner)
    }
    if (existing) return existing
    if (this.ownerAcquisition) {
      if (this.ownerAcquisition.key !== key) throw new Error('Managed Browser runtime is already assigned to another authenticated user')
      return await this.ownerAcquisition.promise
    }
    this.runtimeOwnerKey = key
    const promise = (async () => {
      const session = await this.runtime.startSession({ ownerKey: key, profile: owner.profile })
      try {
        const runtime: OwnerRuntime = {
          owner: { userId: owner.userId, profile: owner.profile },
          ownerKey: key,
          session,
          managedTabIds: new Set(),
          visible: false,
          agentControls: new Map(),
          queues: new Map(),
          tabGenerations: new Map(),
          takingOver: new Set(),
          releaseRetryOnly: false,
        }
        this.owners.set(key, runtime)
        return runtime
      } catch (error) {
        await session.release().catch(() => undefined)
        throw error
      }
    })()
    this.ownerAcquisition = { key, promise }
    try {
      return await promise
    } catch (error) {
      const retainOwnerFence = typeof error === 'object' && error !== null && (error as { retainRuntimeOwnerFence?: unknown }).retainRuntimeOwnerFence === true
      if (!retainOwnerFence && this.runtimeOwnerKey === key) this.runtimeOwnerKey = null
      throw error
    } finally {
      if (this.ownerAcquisition?.promise === promise) this.ownerAcquisition = null
    }
  }

  private requireOwner(owner: BrowserOwner): OwnerRuntime {
    const runtime = this.owners.get(ownerKey(owner))
    if (!runtime) throw new Error('Browser session not found for this user and profile')
    return runtime
  }

  private async requirePage(runtime: OwnerRuntime, pageId: string): Promise<BrowserPageState> {
    if (!runtime.managedTabIds.has(pageId)) throw new Error('Browser tab not found')
    const page = (await runtime.session.listPages()).find(item => item.id === pageId)
    if (!page) throw new Error('Browser tab not found')
    return page
  }

  private revokeViewGrants(owner: string, pageId: string): void {
    for (const grants of [this.grants, this.socketGrants]) {
      for (const [token, grant] of grants) {
        if (grant.ownerKey === owner && grant.pageId === pageId) grants.delete(token)
      }
    }
  }

  private revokeViewConnections(owner: string, pageId: string): void {
    const key = `${owner}\0${pageId}`
    const connections = this.viewConnections.get(key)
    this.viewConnections.delete(key)
    for (const close of connections || []) {
      try { close() } catch { /* best-effort socket revocation */ }
    }
  }

  private async releaseOwner(runtime: OwnerRuntime): Promise<void> {
    if (this.ownerRelease) {
      if (this.ownerRelease.key !== runtime.ownerKey) throw new Error('Managed Browser runtime is already releasing another owner')
      return await this.ownerRelease.promise
    }
    const promise = (async () => {
      runtime.releaseRetryOnly = true
      await runtime.session.release()
      this.owners.delete(runtime.ownerKey)
      if (this.runtimeOwnerKey === runtime.ownerKey) this.runtimeOwnerKey = null
      for (const grants of [this.grants, this.socketGrants]) {
        for (const [token, grant] of grants) {
          if (grant.ownerKey === runtime.ownerKey) grants.delete(token)
        }
      }
      for (const key of [...this.viewConnections.keys()]) {
        if (key.startsWith(`${runtime.ownerKey}\0`)) this.revokeViewConnections(runtime.ownerKey, key.slice(runtime.ownerKey.length + 1))
      }
    })()
    this.ownerRelease = { key: runtime.ownerKey, promise }
    try {
      await promise
    } finally {
      if (this.ownerRelease?.promise === promise) this.ownerRelease = null
    }
  }

  private async queuedOwner<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.ownerQueues.get(key) || Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => next)
    this.ownerQueues.set(key, queued)
    await previous.catch(() => undefined)
    try { return await operation() } finally {
      release()
      if (this.ownerQueues.get(key) === queued) this.ownerQueues.delete(key)
    }
  }

  private async queued<T>(runtime: OwnerRuntime, tabId: string, operation: () => Promise<T>): Promise<T> {
    const previous = runtime.queues.get(tabId) || Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => next)
    runtime.queues.set(tabId, queued)
    await previous.catch(() => undefined)
    try { return await operation() } finally {
      release()
      if (runtime.queues.get(tabId) === queued) runtime.queues.delete(tabId)
    }
  }

  private publicPage(runtime: OwnerRuntime, page: BrowserPageState): PortableBrowserState['tabs'][number] {
    const control = runtime.agentControls.get(page.id) || { state: 'idle' as const }
    return {
      ...page,
      profileId: runtime.owner.profile,
      crashed: page.crashed === true,
      agentControl: control.state,
      ...(control.label ? { agentLabel: control.label } : {}),
      ...(control.action ? { agentAction: control.action } : {}),
    }
  }

  private async stateForRuntime(runtime: OwnerRuntime): Promise<PortableBrowserState> {
    const pages = (await runtime.session.listPages()).filter(page => runtime.managedTabIds.has(page.id))
    for (const tabId of [...runtime.managedTabIds]) {
      if (!pages.some(page => page.id === tabId)) runtime.managedTabIds.delete(tabId)
    }
    if (!runtime.managedTabIds.size) {
      if (this.ownerQueues.has(runtime.ownerKey)) return this.emptyState(runtime.owner.profile, true)
      await this.releaseOwner(runtime)
      return this.emptyState(runtime.owner.profile, true)
    }
    if (runtime.activeTabId && !pages.some(page => page.id === runtime.activeTabId)) runtime.activeTabId = pages[0]?.id
    const now = new Date().toISOString()
    return {
      available: true,
      activeProfileId: runtime.owner.profile,
      ...(runtime.activeTabId ? { activeTabId: runtime.activeTabId } : {}),
      tabs: pages.map(page => this.publicPage(runtime, page)),
      profiles: [{
        id: runtime.owner.profile,
        name: runtime.owner.profile,
        rootPath: '',
        sessionPath: '',
        downloadPath: '',
        proxyMode: 'direct',
        proxyRules: '',
        askBeforeDownload: false,
        downloadConflictPolicy: 'uniquify',
        createdAt: now,
        lastUsedAt: now,
        tabs: pages.map(page => page.id),
      }],
      downloads: [],
      permissions: [],
      visible: runtime.visible,
      maxTabs: MAX_MANAGED_TABS,
    }
  }

  private emptyState(profile: string, available = false): PortableBrowserState {
    return {
      available,
      activeProfileId: profile,
      tabs: [],
      profiles: [],
      downloads: [],
      permissions: [],
      visible: false,
      maxTabs: MAX_MANAGED_TABS,
    }
  }
}
