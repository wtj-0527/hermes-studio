import type { BrowserOwner } from './managed-browser-service'

export type BrowserProviderKind = 'electron' | 'remote'

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

export interface BrowserOperationContext {
  operationId: string
}

export interface BrowserControlProvider {
  readonly id: string
  readonly kind: BrowserProviderKind
  readonly label: string
  readonly capabilities: BrowserProviderCapabilities
  available(owner: BrowserOwner): boolean | Promise<boolean>
  acquired?(owner: BrowserOwner): boolean
  deactivate?(owner: BrowserOwner): Promise<void>
  agentRequest(owner: BrowserOwner, method: string, params: Record<string, unknown>, context?: BrowserOperationContext): Promise<unknown>
}

export interface BrowserProviderStatus {
  id: string
  kind: BrowserProviderKind
  label: string
  capabilities: BrowserProviderCapabilities
  available: boolean
  selected: boolean
}

function ownerKey(owner: BrowserOwner): string {
  const userId = Number(owner.userId)
  const profile = String(owner.profile || '').trim()
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('Authenticated browser user is required')
  if (!profile || profile.length > 200) throw new Error('Browser profile is required')
  return `${userId}:${profile}`
}

export class BrowserProviderRegistry {
  private readonly providers = new Map<string, BrowserControlProvider>()
  private readonly selections = new Map<string, string>()
  private readonly acquisitions = new Map<string, string>()
  private readonly selectionQueues = new Map<string, Promise<void>>()
  private readonly revokingUsers = new Set<number>()
  private readonly revokingProfiles = new Set<string>()
  private readonly preferredProviderIds: string[]

  constructor(options: { preferredProviderIds?: string[] } = {}) {
    this.preferredProviderIds = [...(options.preferredProviderIds || [])]
  }

  register(provider: BrowserControlProvider): void {
    const id = String(provider.id || '').trim()
    if (!id) throw new Error('Browser provider id is required')
    if (this.providers.has(id)) throw new Error(`Browser provider is already registered: ${id}`)
    this.providers.set(id, provider)
  }

  async list(owner: BrowserOwner): Promise<BrowserProviderStatus[]> {
    const key = ownerKey(owner)
    this.assertOwnerAdmission(owner)
    return await this.serializedSelection(key, async () => {
      let selectedId = this.selections.get(key)
      if (!selectedId) {
        const selected = await this.defaultProvider(owner)
        if (selected) {
          selectedId = selected.id
          this.selections.set(key, selected.id)
        }
      }
      const statuses: BrowserProviderStatus[] = []
      for (const provider of this.providers.values()) {
        const available = await provider.available(owner)
        statuses.push({
          id: provider.id,
          kind: provider.kind,
          label: provider.label,
          capabilities: { ...provider.capabilities },
          available,
          selected: selectedId === provider.id,
        })
      }
      return statuses
    })
  }

  async select(owner: BrowserOwner, providerId: string): Promise<BrowserControlProvider> {
    const key = ownerKey(owner)
    this.assertOwnerAdmission(owner)
    return await this.serializedSelection(key, async () => {
      const id = String(providerId || '').trim()
      const provider = this.providers.get(id)
      if (!provider) throw new Error(`Browser provider is not registered: ${id}`)
      if (!await provider.available(owner)) throw new Error(`Browser provider is not available: ${id}`)
      const previousId = this.selections.get(key)
      const previous = previousId ? this.providers.get(previousId) : undefined
      if (previous && previous.id !== provider.id && this.acquisitions.get(key) === previous.id) {
        await previous.deactivate?.(owner)
        this.acquisitions.delete(key)
      }
      this.selections.set(key, id)
      return provider
    })
  }

  async resolve(owner: BrowserOwner): Promise<BrowserControlProvider | null> {
    const key = ownerKey(owner)
    this.assertOwnerAdmission(owner)
    return await this.serializedSelection(key, async () => await this.resolveUnlocked(owner, key))
  }

  async withSelectedProvider<T>(owner: BrowserOwner, providerId: string, operation: () => Promise<T>): Promise<T> {
    const key = ownerKey(owner)
    this.assertOwnerAdmission(owner)
    return await this.serializedSelection(key, async () => {
      const provider = await this.resolveUnlocked(owner, key)
      if (provider?.id !== providerId) throw new Error('The selected browser provider does not expose the requested control routes')
      try {
        const result = await operation()
        this.reconcileAcquisition(key, owner, provider, true)
        return result
      } catch (error) {
        this.reconcileAcquisition(key, owner, provider, false)
        throw error
      }
    })
  }

  private async resolveUnlocked(owner: BrowserOwner, key: string): Promise<BrowserControlProvider | null> {
    this.assertOwnerAdmission(owner)
    const selectedId = this.selections.get(key)
    if (selectedId) {
      const selected = this.providers.get(selectedId)
      if (!selected) throw new Error(`Selected browser provider is not registered: ${selectedId}`)
      if (!await selected.available(owner)) throw new Error(`Selected browser provider is not available: ${selectedId}`)
      return selected
    }
    const selected = await this.defaultProvider(owner)
    if (selected) this.selections.set(key, selected.id)
    return selected
  }

  async deactivateOwner(owner: BrowserOwner): Promise<void> {
    const key = ownerKey(owner)
    await this.serializedSelection(key, async () => {
      const acquiredId = this.acquisitions.get(key)
      const provider = acquiredId ? this.providers.get(acquiredId) : undefined
      await provider?.deactivate?.(owner)
      this.acquisitions.delete(key)
      this.selections.delete(key)
    })
  }

  private ownerKeys(): string[] {
    return [...new Set([
      ...this.selections.keys(),
      ...this.acquisitions.keys(),
      ...this.selectionQueues.keys(),
    ])]
  }

  async deactivateUser(userId: number): Promise<void> {
    const owners = this.ownerKeys()
      .filter(key => key.startsWith(`${userId}:`))
      .map(key => ({ userId, profile: key.slice(key.indexOf(':') + 1) }))
    for (const owner of owners) await this.deactivateOwner(owner)
  }

  async deactivateProfile(profile: string): Promise<void> {
    const owners = this.ownerKeys()
      .filter(key => key.slice(key.indexOf(':') + 1) === profile)
      .map(key => ({ userId: Number(key.slice(0, key.indexOf(':'))), profile }))
    for (const owner of owners) await this.deactivateOwner(owner)
  }

  async withUserAuthorityRevoked<T>(userId: number, mutation: () => Promise<T>): Promise<T> {
    if (this.revokingUsers.has(userId)) throw new Error('Browser user authority mutation is already in progress')
    this.revokingUsers.add(userId)
    try {
      await this.deactivateUser(userId)
      return await mutation()
    } finally {
      this.revokingUsers.delete(userId)
    }
  }

  async withProfileAuthorityRevoked<T>(profile: string, mutation: () => Promise<T>): Promise<T> {
    const normalized = String(profile || '').trim()
    if (!normalized) throw new Error('Browser profile is required')
    if (this.revokingProfiles.has(normalized)) throw new Error('Browser profile authority mutation is already in progress')
    this.revokingProfiles.add(normalized)
    try {
      await this.deactivateProfile(normalized)
      return await mutation()
    } finally {
      this.revokingProfiles.delete(normalized)
    }
  }

  private assertOwnerAdmission(owner: BrowserOwner): void {
    if (this.revokingUsers.has(owner.userId) || this.revokingProfiles.has(owner.profile)) {
      throw new Error('Browser authority mutation is in progress')
    }
  }

  private async defaultProvider(owner: BrowserOwner): Promise<BrowserControlProvider | null> {
    const orderedIds = [
      ...this.preferredProviderIds,
      ...[...this.providers.keys()].filter(id => !this.preferredProviderIds.includes(id)),
    ]
    for (const id of orderedIds) {
      const provider = this.providers.get(id)
      if (provider && await provider.available(owner)) return provider
    }
    return null
  }

  async agentRequest(owner: BrowserOwner, method: string, params: Record<string, unknown>, context?: BrowserOperationContext): Promise<unknown> {
    const key = ownerKey(owner)
    this.assertOwnerAdmission(owner)
    return await this.serializedSelection(key, async () => {
      const provider = await this.resolveUnlocked(owner, key)
      if (!provider) throw new Error('No browser provider is available')
      try {
        const result = await provider.agentRequest(owner, method, params, context)
        this.reconcileAcquisition(key, owner, provider, true)
        return result
      } catch (error) {
        this.reconcileAcquisition(key, owner, provider, false)
        throw error
      }
    })
  }

  private reconcileAcquisition(key: string, owner: BrowserOwner, provider: BrowserControlProvider, operationSucceeded: boolean): void {
    const acquired = provider.acquired ? provider.acquired(owner) : operationSucceeded
    if (acquired) this.acquisitions.set(key, provider.id)
    else if (this.acquisitions.get(key) === provider.id) this.acquisitions.delete(key)
  }

  private async serializedSelection<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.selectionQueues.get(key) || Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => gate)
    this.selectionQueues.set(key, queued)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.selectionQueues.get(key) === queued) this.selectionQueues.delete(key)
    }
  }
}
