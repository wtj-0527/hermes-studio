export const REASONING_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number]
export type ReasoningEffortOverride = ReasoningEffort | ''

const REASONING_EFFORT_SET = new Set<unknown>(REASONING_EFFORT_VALUES)

export function normalizeReasoningEffort(value: unknown): ReasoningEffortOverride {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') throw new Error('reasoning effort must be a string')
  const effort = value.trim()
  if (!effort) return ''
  if (!REASONING_EFFORT_SET.has(effort)) {
    throw new Error(`reasoning effort must be one of: ${REASONING_EFFORT_VALUES.join(', ')}`)
  }
  return effort as ReasoningEffort
}
