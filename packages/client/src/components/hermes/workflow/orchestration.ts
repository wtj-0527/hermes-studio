export type WorkflowRoute = 'success' | 'failure' | 'always'
export type WorkflowConditionOperator = 'equals' | 'not_equals' | 'exists' | 'truthy' | 'contains'
export type WorkflowJoinMode = 'all' | 'any'
export type WorkflowEdgeEvidenceStatus = 'taken' | 'not_taken' | 'error'

export interface WorkflowEdgeCondition { path: string; operator: WorkflowConditionOperator; value?: unknown }
export interface WorkflowEdgeOrchestration { route: WorkflowRoute; condition?: WorkflowEdgeCondition }

const routes = new Set<WorkflowRoute>(['success', 'failure', 'always'])
const operators = new Set<WorkflowConditionOperator>(['equals', 'not_equals', 'exists', 'truthy', 'contains'])
const unsafePathSegments = new Set(['__proto__', 'prototype', 'constructor'])
export function normalizeWorkflowEdgeOrchestration(raw: unknown): WorkflowEdgeOrchestration {
  if (raw === undefined) return { route: 'success' }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('orchestration policy must be an object')
  const value = raw as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(value, 'route')) throw new Error('orchestration route is required')
  const route = value.route
  if (!routes.has(route as WorkflowRoute)) throw new Error('orchestration route must be success, failure, or always')
  const normalized: WorkflowEdgeOrchestration = { route: route as WorkflowRoute }
  if (Object.prototype.hasOwnProperty.call(value, 'condition')) {
    if (typeof value.condition !== 'object' || Array.isArray(value.condition)) throw new Error('orchestration condition must be an object')
    const condition = value.condition as Record<string, unknown>
    if (typeof condition.path !== 'string' || !condition.path.trim()) throw new Error('orchestration condition path must be a non-empty string')
    if (condition.path.trim().split('.').some(segment => !segment || unsafePathSegments.has(segment))) throw new Error('orchestration condition path contains an invalid segment')
    if (!operators.has(condition.operator as WorkflowConditionOperator)) throw new Error('orchestration condition operator is invalid')
    if (['equals', 'not_equals', 'contains'].includes(condition.operator as string) && !Object.prototype.hasOwnProperty.call(condition, 'value')) throw new Error('orchestration condition value is required')
    normalized.condition = { path: condition.path.trim(), operator: condition.operator as WorkflowConditionOperator, ...('value' in condition ? { value: condition.value } : {}) }
  }
  return normalized
}
export function withWorkflowEdgeOrchestration(data: unknown, orchestration: WorkflowEdgeOrchestration): Record<string, unknown> & { orchestration: WorkflowEdgeOrchestration } {
  const metadata = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
  return { ...metadata, orchestration }
}
export function normalizeWorkflowJoinMode(raw: unknown): WorkflowJoinMode {
  if (raw === undefined) return 'all'
  if (raw === 'all' || raw === 'any') return raw
  throw new Error('joinMode must be all or any')
}
export function edgeOrchestrationLabel(raw: unknown): string {
  const policy = normalizeWorkflowEdgeOrchestration(raw)
  if (!policy.condition) return policy.route
  const value = ['exists', 'truthy'].includes(policy.condition.operator) ? '' : ` ${JSON.stringify(policy.condition.value)}`
  return `${policy.route} · ${policy.condition.path} ${policy.condition.operator}${value}`
}
export function edgeEvidenceVisual(status?: WorkflowEdgeEvidenceStatus) {
  if (status === 'taken') return { animated: true, className: 'edge-taken' }
  if (status === 'error') return { animated: false, className: 'edge-error' }
  if (status === 'not_taken') return { animated: false, className: 'edge-not-taken' }
  return { animated: false, className: undefined }
}

export function legacyWorkflowEdgeId(source: string, target: string, index: number): string { return `${source}->${target}#${index}` }

export function buildWorkflowEdgeOrchestration(
  route: WorkflowRoute,
  conditionEnabled: boolean,
  path: string,
  operator: WorkflowConditionOperator,
  value: unknown,
): WorkflowEdgeOrchestration {
  if (!conditionEnabled) return normalizeWorkflowEdgeOrchestration({ route })
  const conditionPath = path.trim()
  if (!conditionPath) throw new Error('orchestration condition path must be a non-empty string')
  const condition: WorkflowEdgeCondition = ['equals', 'not_equals', 'contains'].includes(operator)
    ? { path: conditionPath, operator, value }
    : { path: conditionPath, operator }
  return normalizeWorkflowEdgeOrchestration({ route, condition })
}
