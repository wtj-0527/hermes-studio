import { createHmac, randomBytes } from 'node:crypto'
import {
  REASONING_EFFORT_VALUES,
  normalizeReasoningEffort,
  type ReasoningEffort,
  type ReasoningEffortOverride,
} from '../../../shared/reasoning-effort'
import { providerModelsUrl, readConfigYamlForProfile, safeReadFile } from './config-helpers'
import { getProfileDir } from './hermes/hermes-profile'
import { getCompatibleCustomProviders } from './hermes/custom-providers-compat'

export interface ReasoningModelReference {
  provider: string
  model: string
  apiMode: string
}

export interface ReasoningCapability {
  // null means the authenticated provider catalog authoritatively declares
  // reasoning support but does not publish a finite effort-level enum.
  levels: ReasoningEffort[] | null
  source: 'profile_config' | 'live_model_catalog'
}

const EFFORTS = new Set<string>(REASONING_EFFORT_VALUES)
const LIVE_CAPABILITY_TTL_MS = 60 * 1000
const LIVE_CAPABILITY_CACHE_SECRET = randomBytes(32)
const liveCapabilityCache = new Map<string, { capability: ReasoningCapability; expiresAt: number }>()
const liveCapabilityPending = new Map<string, Promise<ReasoningCapability | null>>()

export function clearReasoningCapabilityCacheForTests(): void {
  liveCapabilityCache.clear()
  liveCapabilityPending.clear()
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedReference(reference: ReasoningModelReference): ReasoningModelReference {
  return {
    provider: String(reference.provider || '').trim(),
    model: String(reference.model || '').trim(),
    apiMode: String(reference.apiMode || '').trim(),
  }
}

function normalizeCapabilityLevels(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('supported_reasoning_levels must be a non-empty array')
  }
  const levels: ReasoningEffort[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string' || !EFFORTS.has(raw) || seen.has(raw)) {
      throw new Error(`supported_reasoning_levels must contain unique canonical values: ${REASONING_EFFORT_VALUES.join(', ')}`)
    }
    seen.add(raw)
    levels.push(raw as ReasoningEffort)
  }
  return levels
}

export function resolveReasoningCapabilityFromModelCatalog(
  catalog: unknown,
  inputReference: ReasoningModelReference,
): ReasoningCapability | null {
  const reference = normalizedReference(inputReference)
  if (!reference.model || reference.apiMode !== 'chat_completions') return null
  const root = record(catalog)
  const data = Array.isArray(root?.data) ? root.data : []
  const model = data.find(item => record(item)?.id === reference.model)
  const capabilities = record(record(model)?.capabilities)
  return capabilities?.reasoning === true
    ? { levels: null, source: 'live_model_catalog' }
    : null
}

function envValue(content: string, key: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index > 0 && trimmed.slice(0, index).trim() === key) {
      const raw = trimmed.slice(index + 1).trim()
      if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("\'") && raw.endsWith("\'"))) {
        return raw.slice(1, -1)
      }
      return raw
    }
  }
  return ''
}

async function resolveLiveCustomProviderCapability(
  config: unknown,
  reference: ReasoningModelReference,
  profile: string,
): Promise<ReasoningCapability | null> {
  if (!reference.provider.startsWith('custom:') || reference.apiMode !== 'chat_completions') return null
  const providerName = reference.provider.slice('custom:'.length)
  const providers = getCompatibleCustomProviders(config)
  const canonicalProviderName = providerName.toLowerCase()
  const provider = providers.find(item => {
    const keys = [item.name, item.provider_key]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim().toLowerCase().replace(/ /g, '-'))
    return keys.includes(canonicalProviderName)
  })
  if (!provider?.base_url || provider.api_mode !== reference.apiMode) return null
  let apiKey = provider.api_key || ''
  if (!apiKey && provider.key_env) {
    apiKey = envValue(await safeReadFile(`${getProfileDir(profile)}/.env`) || '', provider.key_env)
  }
  if (!apiKey) return null
  const url = providerModelsUrl(provider.base_url)
  const credentialFingerprint = createHmac('sha256', LIVE_CAPABILITY_CACHE_SECRET).update(apiKey).digest('hex')
  const cacheKey = [profile, reference.provider, url, reference.model, reference.apiMode, credentialFingerprint].join('\0')
  const cached = liveCapabilityCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.capability
  if (cached) liveCapabilityCache.delete(cacheKey)
  const existing = liveCapabilityPending.get(cacheKey)
  if (existing) return existing

  const pending = (async (): Promise<ReasoningCapability | null> => {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return null
      const capability = resolveReasoningCapabilityFromModelCatalog(await response.json(), reference)
      if (capability) {
        liveCapabilityCache.set(cacheKey, { capability, expiresAt: Date.now() + LIVE_CAPABILITY_TTL_MS })
      }
      return capability
    } catch {
      return null
    } finally {
      liveCapabilityPending.delete(cacheKey)
    }
  })()
  liveCapabilityPending.set(cacheKey, pending)
  return pending
}

export function resolveReasoningCapabilityFromConfig(
  config: unknown,
  inputReference: ReasoningModelReference,
): ReasoningCapability | null {
  const reference = normalizedReference(inputReference)
  if (!reference.provider || !reference.model || !reference.apiMode) return null
  const root = record(config)
  const providers = record(root?.providers)
  const providerKey = Object.hasOwn(providers || {}, reference.provider)
    ? reference.provider
    : reference.provider.startsWith('custom:') ? reference.provider.slice('custom:'.length) : reference.provider
  const provider = record(providers?.[providerKey])
  if (!provider) return null
  const providerApiMode = typeof provider.api_mode === 'string' ? provider.api_mode.trim() : ''
  if (!providerApiMode || (reference.apiMode && providerApiMode !== reference.apiMode)) return null
  const models = record(provider.models)
  const model = record(models?.[reference.model])
  if (!model || !Object.hasOwn(model, 'supported_reasoning_levels')) return null
  return {
    levels: normalizeCapabilityLevels(model.supported_reasoning_levels),
    source: 'profile_config',
  }
}

function capabilityError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`)
  ;(error as any).code = code
  ;(error as any).status = 400
  return error
}

export function assertReasoningEffortSupported(
  value: unknown,
  capability: ReasoningCapability | null,
  inputReference: ReasoningModelReference,
): ReasoningEffortOverride {
  const effort = normalizeReasoningEffort(value)
  if (!effort) return ''
  const reference = normalizedReference(inputReference)
  if (!capability) {
    throw capabilityError(
      'reasoning_capability_unknown',
      `no authoritative reasoning capability metadata for ${reference.provider}/${reference.model}/${reference.apiMode}`,
    )
  }
  if (capability.levels !== null && !capability.levels.includes(effort)) {
    throw capabilityError(
      'reasoning_effort_unsupported',
      `reasoning effort ${effort} is not supported by ${reference.provider}/${reference.model}/${reference.apiMode}`,
    )
  }
  return effort
}

export async function validateReasoningEffortForProfile(input: {
  profile: string
  provider: string
  model: string
  apiMode: string
  reasoningEffort: unknown
}): Promise<ReasoningEffortOverride> {
  const normalized = normalizeReasoningEffort(input.reasoningEffort)
  if (!normalized) return ''
  const config = await readConfigYamlForProfile(input.profile)
  const providerKey = String(input.provider || '').trim()
  const model = String(input.model || '').trim()
  const requestedApiMode = String(input.apiMode || '').trim()
  const providers = record(config)?.providers
  const providerMap = record(providers)
  const configKey = Object.hasOwn(providerMap || {}, providerKey)
    ? providerKey
    : providerKey.startsWith('custom:') ? providerKey.slice('custom:'.length) : providerKey
  const providerConfig = record(providerMap?.[configKey])
  const configuredApiMode = typeof providerConfig?.api_mode === 'string' ? providerConfig.api_mode.trim() : ''
  const reference = { provider: providerKey, model, apiMode: requestedApiMode || configuredApiMode }
  const configuredCapability = resolveReasoningCapabilityFromConfig(config, reference)
  const capability = configuredCapability || await resolveLiveCustomProviderCapability(config, reference, input.profile)
  return assertReasoningEffortSupported(normalized, capability, reference)
}
