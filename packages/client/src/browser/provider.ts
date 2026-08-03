import { getActiveProfileName, request } from '@/api/client'
import {
  desktopBridge,
  hasDesktopBrowserBridge,
  type DesktopBrowserBridge,
  type DesktopBrowserDownload,
  type DesktopBrowserProfile,
  type DesktopBrowserSelection,
  type DesktopBrowserState,
  type DesktopBrowserTab,
  type DesktopWindowBounds,
} from '@/utils/desktop-bridge'

export type BrowserProviderKind = 'electron' | 'remote'
export type BrowserState = DesktopBrowserState
export type BrowserTab = DesktopBrowserTab
export type BrowserProfile = DesktopBrowserProfile
export type BrowserDownload = DesktopBrowserDownload
export type BrowserSelection = DesktopBrowserSelection
export type BrowserBounds = DesktopWindowBounds

export interface BrowserProviderCapabilities {
  tabs: boolean
  navigation: boolean
  snapshot: boolean
  interaction: boolean
  screenshot: boolean
  console: boolean
  liveView: boolean
  takeover: boolean
  profiles: boolean
  downloads: boolean
  annotations: boolean
  htmlPreview: boolean
}

export interface BrowserProviderDescriptor {
  id: string
  kind: BrowserProviderKind
  label: string
  available: boolean
  selected: boolean
  capabilities?: BrowserProviderCapabilities
}

export interface BrowserProvider extends DesktopBrowserBridge {
  readonly id: string
  readonly kind: BrowserProviderKind
  readonly label: string
  readonly capabilities: BrowserProviderCapabilities
  getViewUrl?: (tabId: string) => Promise<string>
  revokeViewUrl?: (url: string) => void
}

export async function navigateBrowserAddress(
  provider: BrowserProvider,
  activeTabId: string | undefined,
  input: string,
): Promise<BrowserTab | undefined> {
  const url = input.trim()
  if (!url) return undefined
  return activeTabId
    ? await provider.navigate(activeTabId, url)
    : await provider.createTab(url, true)
}

const FULL_PROVIDER_CAPABILITIES: BrowserProviderCapabilities = {
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

const MANAGED_RUNTIME_PROVIDER_CAPABILITIES: BrowserProviderCapabilities = {
  ...FULL_PROVIDER_CAPABILITIES,
  profiles: false,
  downloads: false,
  annotations: false,
  htmlPreview: false,
}

class ElectronBrowserProvider implements BrowserProvider {
  readonly id = 'electron-local'
  readonly kind = 'electron' as const
  readonly label = 'Electron'
  readonly capabilities = FULL_PROVIDER_CAPABILITIES
  private readonly bridge: DesktopBrowserBridge

  constructor(bridge: DesktopBrowserBridge) {
    this.bridge = bridge
  }

  getState = () => this.bridge.getState()
  setViewport = (bounds: BrowserBounds, visible: boolean) => this.bridge.setViewport(bounds, visible)
  createTab = (url?: string, activate?: boolean) => this.bridge.createTab(url, activate)
  createHtmlPreviewTab = (html: string, title: string, activate?: boolean) => {
    if (!this.bridge.createHtmlPreviewTab) throw new Error('HTML preview is not supported by this browser provider')
    return this.bridge.createHtmlPreviewTab(html, title, activate)
  }
  closeTab = (tabId: string) => this.bridge.closeTab(tabId)
  activateTab = (tabId: string) => this.bridge.activateTab(tabId)
  navigate = (tabId: string, url: string) => this.bridge.navigate(tabId, url)
  navigationAction = (tabId: string, action: 'back' | 'forward' | 'reload' | 'stop') => this.bridge.navigationAction(tabId, action)
  createProfile = (input: Parameters<DesktopBrowserBridge['createProfile']>[0]) => this.bridge.createProfile(input)
  chooseProfileRootDirectory = (defaultPath?: string) => this.bridge.chooseProfileRootDirectory(defaultPath)
  renameProfile = (profileId: string, name: string) => this.bridge.renameProfile(profileId, name)
  profileSwitchImpact = () => this.bridge.profileSwitchImpact()
  switchProfile = (profileId: string, force?: boolean) => this.bridge.switchProfile(profileId, force)
  updateProfile = (profileId: string, input: Parameters<DesktopBrowserBridge['updateProfile']>[1]) => this.bridge.updateProfile(profileId, input)
  deleteProfile = (profileId: string) => this.bridge.deleteProfile(profileId)
  clearProfileData = (profileId: string, kind: 'cache' | 'site-data' | 'permission-audit') => this.bridge.clearProfileData(profileId, kind)
  cancelDownload = (downloadId: string) => this.bridge.cancelDownload(downloadId)
  takeOver = (tabId: string) => this.bridge.takeOver(tabId)
  annotate = (tabId: string, mode: 'element' | 'region') => this.bridge.annotate(tabId, mode)
  cancelAnnotation = (tabId: string) => this.bridge.cancelAnnotation(tabId)
  updateAnnotationNote = (tabId: string, marker: number, note: string) => this.bridge.updateAnnotationNote(tabId, marker, note)
  captureAnnotations = (tabId: string) => this.bridge.captureAnnotations(tabId)
  clearAnnotations = (tabId: string) => this.bridge.clearAnnotations(tabId)
  onAnnotationRequest = (callback: Parameters<DesktopBrowserBridge['onAnnotationRequest']>[0]) => this.bridge.onAnnotationRequest(callback)
  onStateChange = (callback: Parameters<DesktopBrowserBridge['onStateChange']>[0]) => this.bridge.onStateChange(callback)
}

class ManagedBrowserProvider implements BrowserProvider {
  readonly id = 'managed-runtime'
  readonly kind = 'remote' as const
  readonly label = 'Managed'
  readonly capabilities = MANAGED_RUNTIME_PROVIDER_CAPABILITIES
  private readonly listeners = new Set<(state: BrowserState) => void>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollGeneration = 0

  invalidateContext(): void {
    this.pollGeneration += 1
  }

  async getState(): Promise<BrowserState> {
    return await request<BrowserState>('/api/browser/state')
  }

  async getViewUrl(tabId: string): Promise<string> {
    const result = await request<{ url: string }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/view`)
    if (!/^\/api\/browser\/view\/[A-Za-z0-9_-]+$/.test(result.url)) {
      throw new Error('Studio returned an invalid browser view URL')
    }
    return result.url
  }

  revokeViewUrl(): void {
    // Same-origin bootstrap capabilities expire server-side and are single-use.
  }

  setViewport(bounds: BrowserBounds, visible: boolean): Promise<BrowserState> {
    return this.mutate('/api/browser/viewport', { bounds, visible })
  }

  createTab(url = 'about:blank', activate = true): Promise<BrowserTab> {
    return request('/api/browser/tabs', { method: 'POST', body: JSON.stringify({ url, activate }) })
  }

  createHtmlPreviewTab(): Promise<BrowserTab> {
    return Promise.reject(new Error('HTML preview is not supported by the Web browser provider'))
  }

  closeTab(tabId: string): Promise<BrowserState> {
    return this.mutate(`/api/browser/tabs/${encodeURIComponent(tabId)}`, undefined, 'DELETE')
  }

  activateTab(tabId: string): Promise<BrowserState> {
    return this.mutate(`/api/browser/tabs/${encodeURIComponent(tabId)}/activate`)
  }

  navigate(tabId: string, url: string): Promise<BrowserTab> {
    return request(`/api/browser/tabs/${encodeURIComponent(tabId)}/navigate`, { method: 'POST', body: JSON.stringify({ url }) })
  }

  navigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserTab> {
    return request(`/api/browser/tabs/${encodeURIComponent(tabId)}/navigation`, { method: 'POST', body: JSON.stringify({ action }) })
  }

  createProfile(): Promise<BrowserProfile> {
    return Promise.reject(new Error('Browser profiles are managed by Hermes Studio on Web'))
  }

  chooseProfileRootDirectory(): Promise<string | null> {
    return Promise.resolve(null)
  }

  renameProfile(): Promise<BrowserProfile> {
    return Promise.reject(new Error('Browser profiles are managed by Hermes Studio on Web'))
  }

  async profileSwitchImpact() {
    const state = await this.getState()
    return {
      activeAgentRuns: state.tabs.filter(tab => tab.agentControl !== 'idle').length,
      activeDownloads: state.downloads.filter(download => download.state === 'progressing').length,
      pendingAnnotations: 0,
      openTabs: state.tabs.length,
      requiresConfirmation: state.tabs.some(tab => tab.agentControl !== 'idle') || state.downloads.some(download => download.state === 'progressing'),
    }
  }

  switchProfile(): Promise<BrowserState> {
    return Promise.reject(new Error('The Web browser follows the active Hermes profile'))
  }

  updateProfile(): Promise<BrowserProfile> {
    return Promise.reject(new Error('Browser profiles are managed by Hermes Studio on Web'))
  }

  deleteProfile(): Promise<BrowserState> {
    return Promise.reject(new Error('Browser profiles are managed by Hermes Studio on Web'))
  }

  clearProfileData(profileId: string, kind: 'cache' | 'site-data' | 'permission-audit'): Promise<BrowserState> {
    return this.mutate('/api/browser/profile-data', { profileId, kind }, 'DELETE')
  }

  cancelDownload(downloadId: string): Promise<BrowserState> {
    return this.mutate(`/api/browser/downloads/${encodeURIComponent(downloadId)}/cancel`)
  }

  takeOver(tabId: string): Promise<boolean> {
    return request(`/api/browser/tabs/${encodeURIComponent(tabId)}/takeover`, { method: 'POST' }).then(() => true)
  }

  annotate(): Promise<BrowserSelection> {
    return Promise.reject(new Error('Browser annotations are not yet supported on Web'))
  }

  cancelAnnotation(): Promise<boolean> { return Promise.reject(new Error('Browser annotations are not supported on Web')) }
  updateAnnotationNote(): Promise<boolean> { return Promise.reject(new Error('Browser annotations are not supported on Web')) }
  captureAnnotations(): Promise<BrowserSelection['screenshot']> {
    return Promise.reject(new Error('Browser annotations are not yet supported on Web'))
  }
  clearAnnotations(): Promise<boolean> { return Promise.reject(new Error('Browser annotations are not supported on Web')) }
  onAnnotationRequest(): () => void { return () => undefined }

  onStateChange(callback: (state: BrowserState) => void): () => void {
    this.pollGeneration += 1
    this.listeners.add(callback)
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        const generation = this.pollGeneration
        const profile = getActiveProfileName()
        void this.getState().then(state => {
          if (generation !== this.pollGeneration || profile !== getActiveProfileName()) return
          for (const listener of this.listeners) listener(state)
        }).catch(() => undefined)
      }, 2_000)
    }
    return () => {
      this.listeners.delete(callback)
      this.pollGeneration += 1
      if (!this.listeners.size && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    }
  }

  private async mutate(path: string, body?: unknown, method = 'POST'): Promise<BrowserState> {
    const generation = this.pollGeneration
    const profile = getActiveProfileName()
    const state = await request<BrowserState>(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (generation === this.pollGeneration && profile === getActiveProfileName()) {
      for (const listener of this.listeners) listener(state)
    }
    return state
  }
}

class BrowserProviderRegistry {
  private readonly providers = new Map<string, BrowserProvider>()
  private selectedProviderId = ''

  register(provider: BrowserProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Browser provider already registered: ${provider.id}`)
    this.providers.set(provider.id, provider)
  }

  list(): BrowserProviderDescriptor[] {
    return [...this.providers.values()].map(provider => ({
      id: provider.id,
      kind: provider.kind,
      label: provider.label,
      available: true,
      selected: provider.id === this.selectedProviderId,
      capabilities: { ...provider.capabilities },
    }))
  }

  select(providerId: string): BrowserProvider {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Browser provider is not available: ${providerId}`)
    this.selectedProviderId = provider.id
    return provider
  }

  active(): BrowserProvider {
    const provider = this.providers.get(this.selectedProviderId)
    if (!provider) throw new Error('No browser provider is available')
    return provider
  }
}

let registry: BrowserProviderRegistry | null = null
let profileTransitionQueue: Promise<void> = Promise.resolve()
let selectionGeneration = 0

function providerRegistry(): BrowserProviderRegistry {
  if (registry) return registry
  registry = new BrowserProviderRegistry()
  if (hasDesktopBrowserBridge()) {
    registry.register(new ElectronBrowserProvider(desktopBridge()!.browser!))
  }
  registry.register(new ManagedBrowserProvider())
  registry.select(hasDesktopBrowserBridge() ? 'electron-local' : 'managed-runtime')
  return registry
}

export async function browserProviders(options: { syncLocalSelection?: boolean } = {}): Promise<BrowserProviderDescriptor[]> {
  const local = providerRegistry()
  const generation = selectionGeneration
  const result = await request<{ providers: BrowserProviderDescriptor[] }>('/api/browser/providers')
  if (options.syncLocalSelection !== false && generation === selectionGeneration) {
    const availableIds = new Set(local.list().map(provider => provider.id))
    const selected = result.providers.find(provider => provider.selected && provider.available && availableIds.has(provider.id))
    if (selected) local.select(selected.id)
  }
  return result.providers
}

export async function selectBrowserProvider(providerId: string, options: { syncLocalSelection?: boolean } = {}): Promise<BrowserProvider> {
  selectionGeneration += 1
  await request(`/api/browser/providers/${encodeURIComponent(providerId)}/select`, { method: 'POST' })
  return options.syncLocalSelection === false ? providerRegistry().active() : providerRegistry().select(providerId)
}

export function activateBrowserProvider(providerId: string): BrowserProvider {
  return providerRegistry().select(providerId)
}

export function invalidateBrowserProviderContext(): void {
  const provider = providerRegistry().active()
  if (provider.kind === 'remote') (provider as ManagedBrowserProvider).invalidateContext()
}

export async function transitionBrowserProfile(previousProfile: string): Promise<void> {
  const transition = profileTransitionQueue.catch(() => undefined).then(async () => {
    await request('/api/browser/profile-transition', {
      method: 'POST',
      body: JSON.stringify({ previous_profile: previousProfile }),
    })
  })
  profileTransitionQueue = transition
  await transition
}

export function browserProvider(): BrowserProvider {
  return providerRegistry().active()
}

export function hasBrowserProvider(): boolean {
  return typeof window !== 'undefined'
}

export function resetBrowserProviderForTests(): void {
  registry = null
  profileTransitionQueue = Promise.resolve()
  selectionGeneration = 0
}
