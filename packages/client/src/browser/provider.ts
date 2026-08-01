import { request } from '@/api/client'
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

export type BrowserProviderKind = 'electron' | 'steel'
export type BrowserState = DesktopBrowserState
export type BrowserTab = DesktopBrowserTab
export type BrowserProfile = DesktopBrowserProfile
export type BrowserDownload = DesktopBrowserDownload
export type BrowserSelection = DesktopBrowserSelection
export type BrowserBounds = DesktopWindowBounds

export interface BrowserProvider extends DesktopBrowserBridge {
  readonly kind: BrowserProviderKind
  getViewUrl?: (tabId: string) => Promise<string>
  revokeViewUrl?: (url: string) => void
}

class ElectronBrowserProvider implements BrowserProvider {
  readonly kind = 'electron' as const
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

class SteelBrowserProvider implements BrowserProvider {
  readonly kind = 'steel' as const
  private readonly listeners = new Set<(state: BrowserState) => void>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  async getState(): Promise<BrowserState> {
    return await request<BrowserState>('/api/browser/state')
  }

  async getViewUrl(tabId: string): Promise<string> {
    const result = await request<{ html: string }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/view`)
    if (!result.html.includes('/api/browser/view/') || result.html.includes('127.0.0.1') || result.html.includes('ws://')) {
      throw new Error('Studio returned an invalid browser view document')
    }
    return URL.createObjectURL(new Blob([result.html], { type: 'text/html' }))
  }

  revokeViewUrl(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
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

  cancelAnnotation(): Promise<boolean> { return Promise.resolve(false) }
  updateAnnotationNote(): Promise<boolean> { return Promise.resolve(false) }
  captureAnnotations(): Promise<BrowserSelection['screenshot']> {
    return Promise.reject(new Error('Browser annotations are not yet supported on Web'))
  }
  clearAnnotations(): Promise<boolean> { return Promise.resolve(false) }
  onAnnotationRequest(): () => void { return () => undefined }

  onStateChange(callback: (state: BrowserState) => void): () => void {
    this.listeners.add(callback)
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.getState().then(state => {
          for (const listener of this.listeners) listener(state)
        }).catch(() => undefined)
      }, 2_000)
    }
    return () => {
      this.listeners.delete(callback)
      if (!this.listeners.size && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    }
  }

  private async mutate(path: string, body?: unknown, method = 'POST'): Promise<BrowserState> {
    const state = await request<BrowserState>(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const listener of this.listeners) listener(state)
    return state
  }
}

let cachedProvider: BrowserProvider | null = null

export function browserProvider(): BrowserProvider {
  if (cachedProvider) return cachedProvider
  if (hasDesktopBrowserBridge()) {
    cachedProvider = new ElectronBrowserProvider(desktopBridge()!.browser!)
  } else {
    cachedProvider = new SteelBrowserProvider()
  }
  return cachedProvider
}

export function hasBrowserProvider(): boolean {
  return hasDesktopBrowserBridge() || typeof window !== 'undefined'
}

export function resetBrowserProviderForTests(): void {
  cachedProvider = null
}
