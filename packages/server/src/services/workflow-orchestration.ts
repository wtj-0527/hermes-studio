export type WorkflowEdgeRoute = 'success' | 'failure' | 'always'
export type WorkflowConditionOperator = 'equals' | 'not_equals' | 'exists' | 'truthy' | 'contains'
export type WorkflowJoinMode = 'all' | 'any'

export interface WorkflowEdgeCondition {
  path: string
  operator: WorkflowConditionOperator
  value?: unknown
}

export interface WorkflowEdgeOrchestration {
  route: WorkflowEdgeRoute
  condition?: WorkflowEdgeCondition
}

export interface WorkflowOrchestrationEdge {
  id?: string
  source: string
  target: string
  data?: {
    orchestration?: unknown
    [key: string]: unknown
  }
}

export interface WorkflowNodeOutcome {
  nodeId: string
  status: 'success' | 'failure'
  output: string
  error?: string | null
}

export interface WorkflowEdgeContext {
  nodeId: string
  status: 'success' | 'failure'
  output: string
  error: string | null
  json: unknown | null
  jsonParsed: boolean
}

export interface WorkflowEdgeEvaluation {
  status: 'taken' | 'not_taken' | 'error'
  reason: string
  context: WorkflowEdgeContext
}

const ROUTES = new Set<unknown>(['success', 'failure', 'always'])
const OPERATORS = new Set<unknown>(['equals', 'not_equals', 'exists', 'truthy', 'contains'])
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function normalizeWorkflowEdgeOrchestration(value: unknown): WorkflowEdgeOrchestration {
  if (value === undefined) return { route: 'success' }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('orchestration policy must be an object')
  const record = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'route')) throw new Error('orchestration route is required')
  const route = record.route
  if (!ROUTES.has(route)) throw new Error('orchestration route must be success, failure, or always')
  const normalized: WorkflowEdgeOrchestration = { route: route as WorkflowEdgeRoute }
  if (Object.prototype.hasOwnProperty.call(record, 'condition')) {
    const condition = asRecord(record.condition)
    if (typeof condition.path !== 'string' || !condition.path.trim()) {
      throw new Error('orchestration condition path must be a non-empty string')
    }
    if (condition.path.trim().split('.').some(segment => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) throw new Error('orchestration condition path contains an invalid segment')
    if (!OPERATORS.has(condition.operator)) {
      throw new Error('orchestration condition operator is invalid')
    }
    if (['equals', 'not_equals', 'contains'].includes(condition.operator as string) && !Object.prototype.hasOwnProperty.call(condition, 'value')) {
      throw new Error('orchestration condition value is required')
    }
    normalized.condition = {
      path: condition.path.trim(),
      operator: condition.operator as WorkflowConditionOperator,
      value: condition.value,
    }
  }
  return normalized
}

export function normalizeWorkflowJoinMode(value: unknown): WorkflowJoinMode {
  if (value === undefined) return 'all'
  if (value === 'all' || value === 'any') return value
  throw new Error('joinMode must be all or any')
}

function parseWorkflowJsonOutputResult(output: string): { parsed: boolean; value: unknown | null } {
  const trimmed = output.trim()
  if (!trimmed) return { parsed: false, value: null }
  try { return { parsed: true, value: JSON.parse(trimmed) } } catch { /* try fenced JSON */ }
  const fence = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed)
  if (!fence) return { parsed: false, value: null }
  try { return { parsed: true, value: JSON.parse(fence[1]) } } catch { return { parsed: false, value: null } }
}

export function parseWorkflowJsonOutput(output: string): unknown | null {
  return parseWorkflowJsonOutputResult(output).value
}

function readPath(context: WorkflowEdgeContext, path: string): unknown {
  const segments = path.split('.')
  if (segments.some(segment => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error('orchestration condition path contains an invalid segment')
  }
  const readsContext = Object.prototype.hasOwnProperty.call(context, segments[0]) && segments[0] !== 'json'
  if (!readsContext && !context.jsonParsed) throw new Error('orchestration condition requires valid JSON output')
  let current: unknown = readsContext ? context : context.json
  const pathSegments = readsContext || segments[0] !== 'json' ? segments : segments.slice(1)
  for (const segment of pathSegments) {
    if (current == null || typeof current !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      if (segment in Object(current)) throw new Error(`orchestration condition path segment ${segment} is inherited, not an own property`)
      return undefined
    }
    if (!Object.prototype.propertyIsEnumerable.call(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function equals(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  try {
    return JSON.stringify(actual) === JSON.stringify(expected)
  } catch {
    return false
  }
}

function evaluateCondition(condition: WorkflowEdgeCondition, context: WorkflowEdgeContext): boolean {
  const actual = readPath(context, condition.path)
  switch (condition.operator) {
    case 'equals': return equals(actual, condition.value)
    case 'not_equals': return !equals(actual, condition.value)
    case 'exists': return actual !== undefined
    case 'truthy': return Boolean(actual)
    case 'contains':
      if (Array.isArray(actual)) return actual.some(item => equals(item, condition.value))
      if (typeof actual === 'string') return actual.includes(String(condition.value ?? ''))
      return false
  }
}

export function evaluateWorkflowEdge(edge: WorkflowOrchestrationEdge, outcome: WorkflowNodeOutcome): WorkflowEdgeEvaluation {
  const parsedJson = parseWorkflowJsonOutputResult(outcome.output)
  const context: WorkflowEdgeContext = {
    nodeId: outcome.nodeId,
    status: outcome.status,
    output: outcome.output,
    error: outcome.error ?? null,
    json: parsedJson.value,
    jsonParsed: parsedJson.parsed,
  }
  try {
    const policy = normalizeWorkflowEdgeOrchestration(edge.data?.orchestration)
    if (policy.route !== 'always' && policy.route !== outcome.status) {
      return { status: 'not_taken', reason: `route ${policy.route} does not match ${outcome.status}`, context }
    }
    if (!policy.condition) return { status: 'taken', reason: 'route matched', context }
    const matched = evaluateCondition(policy.condition, context)
    return {
      status: matched ? 'taken' : 'not_taken',
      reason: matched ? 'condition matched' : 'condition did not match',
      context,
    }
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err), context }
  }
}

export interface CompiledWorkflowGraph { nodes: any[]; edges: Array<any & { id: string }> }
export function compileWorkflowGraph(rawNodes: unknown[], rawEdges: unknown[]): CompiledWorkflowGraph {
  const nodes = rawNodes.map((raw) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as any).id !== 'string' || !(raw as any).id.trim()) throw new Error('workflow node id is required')
    return { ...(raw as any), id: (raw as any).id.trim() }
  })
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`duplicate node id: ${node.id}`)
    nodeIds.add(node.id)
    if (node.data?.orchestration !== undefined && (node.data.orchestration === null || typeof node.data.orchestration !== 'object' || Array.isArray(node.data.orchestration))) throw new Error('node orchestration must be an object')
    normalizeWorkflowJoinMode(node.data?.orchestration?.joinMode)
  }
  const edgeIds = new Set<string>()
  const edges = rawEdges.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error('workflow edge must be an object')
    const edge = raw as any
    const source = typeof edge.source === 'string' ? edge.source.trim() : ''
    const target = typeof edge.target === 'string' ? edge.target.trim() : ''
    if (!nodeIds.has(source)) throw new Error(`edge has missing source: ${source}`)
    if (!nodeIds.has(target)) throw new Error(`edge has missing target: ${target}`)
    if (source === target) throw new Error(`workflow graph contains self-loop: ${source}`)
    normalizeWorkflowEdgeOrchestration(edge.data?.orchestration)
    const id = typeof edge.id === 'string' && edge.id.trim() ? edge.id.trim() : `${source}->${target}#${index}`
    if (edgeIds.has(id)) throw new Error(`duplicate edge id: ${id}`)
    edgeIds.add(id)
    return { ...edge, id, source, target }
  })
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of edges) { indegree.set(edge.target, indegree.get(edge.target)! + 1); outgoing.get(edge.source)!.push(edge.target) }
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  let visited = 0
  while (queue.length) { const id = queue.shift()!; visited++; for (const target of outgoing.get(id)!) { const next = indegree.get(target)! - 1; indegree.set(target, next); if (next === 0) queue.push(target) } }
  if (visited !== nodes.length) throw new Error('workflow graph contains a cycle')
  return { nodes, edges }
}

export function hasNonLegacyWorkflowOrchestration(rawNodes: unknown[], rawEdges: unknown[]): boolean {
  try {
    for (const raw of rawEdges) {
      const edge = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
      const policy = edge.data?.orchestration
      if (policy === undefined || policy === null) continue
      const normalized = normalizeWorkflowEdgeOrchestration(policy)
      if (normalized.route !== 'success' || normalized.condition !== undefined) return true
    }
    for (const raw of rawNodes) {
      const node = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
      const orchestration = node.data?.orchestration
      if (orchestration === undefined || orchestration === null) continue
      if (typeof orchestration !== 'object' || Array.isArray(orchestration)) return true
      if (normalizeWorkflowJoinMode(orchestration.joinMode) !== 'all') return true
    }
    return false
  } catch {
    return true
  }
}
