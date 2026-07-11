import {
  REASONING_EFFORT_VALUES,
  normalizeReasoningEffort,
  type ReasoningEffort,
  type ReasoningEffortOverride,
} from '../../../shared/reasoning-effort'
import { readConfigYamlForProfile } from './config-helpers'

export interface ReasoningModelReference {
  provider: string
  model: string
  apiMode: string
}

export interface ReasoningCapability {
  levels: ReasoningEffort[]
  source: 'profile_config'
}

const EFFORTS = new Set<string>(REASONING_EFFORT_VALUES)

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
  if (!capability.levels.includes(effort)) {
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
  const capability = resolveReasoningCapabilityFromConfig(config, reference)
  return assertReasoningEffortSupported(normalized, capability, reference)
}
