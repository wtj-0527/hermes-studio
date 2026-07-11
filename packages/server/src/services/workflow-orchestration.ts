import { normalizeReasoningEffort } from '../../../shared/reasoning-effort'

export type WorkflowEdgeRoute = 'success' | 'failure' | 'always'
export type WorkflowConditionOperator = 'equals' | 'not_equals' | 'exists' | 'truthy' | 'contains'
export type WorkflowJoinMode = 'all' | 'any'

export interface WorkflowEdgeCondition {
  path: string
  operator: WorkflowConditionOperator
  value?: unknown
}

export const MAX_WORKFLOW_LOOP_ITERATIONS = 100

export interface WorkflowLoopPolicy {
  maxIterations: number
}

export interface WorkflowEdgeOrchestration {
  route: WorkflowEdgeRoute
  condition?: WorkflowEdgeCondition
  loop?: WorkflowLoopPolicy
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
      ...(Object.prototype.hasOwnProperty.call(condition, 'value') ? { value: condition.value } : {}),
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, 'loop')) {
    if (!normalized.condition) throw new Error('feedback loop edge requires an explicit condition')
    if (!record.loop || typeof record.loop !== 'object' || Array.isArray(record.loop)) {
      throw new Error('feedback loop policy must be an object')
    }
    const loop = record.loop as Record<string, unknown>
    const unknown = Object.keys(loop).filter(key => key !== 'maxIterations')
    if (unknown.length) throw new Error(`feedback loop policy contains unknown field: ${unknown.join(', ')}`)
    if (!Number.isInteger(loop.maxIterations) || (loop.maxIterations as number) < 1 || (loop.maxIterations as number) > MAX_WORKFLOW_LOOP_ITERATIONS) {
      throw new Error(`feedback loop maxIterations must be an integer between 1 and ${MAX_WORKFLOW_LOOP_ITERATIONS}`)
    }
    normalized.loop = { maxIterations: loop.maxIterations as number }
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

export interface CompiledWorkflowLoop {
  id: string
  headerNodeId: string
  latchNodeId: string
  feedbackEdgeId: string
  nodeIds: string[]
  maxIterations: number
  parentLoopId: string | null
}

export interface CompiledWorkflowEdgeClassification {
  kind: 'forward' | 'internal' | 'enter' | 'exit' | 'cross' | 'feedback'
  enterLoopIds: string[]
  exitLoopIds: string[]
  loopId?: string
}

export interface CompiledWorkflowGraph {
  nodes: any[]
  edges: Array<any & { id: string }>
  forwardEdges: Array<any & { id: string }>
  feedbackEdges: Array<any & { id: string }>
  topologicalOrder: string[]
  loops: CompiledWorkflowLoop[]
  nodeLoopStacks: Record<string, string[]>
  edgeClassifications: Record<string, CompiledWorkflowEdgeClassification>
}

interface LoopCandidate extends CompiledWorkflowLoop {
  nodeSet: Set<string>
}

function stableTopologicalOrder(nodes: any[], edges: Array<any & { id: string }>): string[] {
  const definitionIndex = new Map(nodes.map((node, index) => [node.id, index]))
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of edges) {
    indegree.set(edge.target, indegree.get(edge.target)! + 1)
    outgoing.get(edge.source)!.push(edge.target)
  }
  const ready = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  const order: string[] = []
  while (ready.length) {
    ready.sort((a, b) => definitionIndex.get(a)! - definitionIndex.get(b)!)
    const id = ready.shift()!
    order.push(id)
    for (const target of outgoing.get(id)!) {
      const next = indegree.get(target)! - 1
      indegree.set(target, next)
      if (next === 0) ready.push(target)
    }
  }
  if (order.length !== nodes.length) throw new Error('workflow graph contains an unmarked cycle')
  return order
}

function reachable(start: string, target: string, outgoing: Map<string, string[]>): boolean {
  if (start === target) return true
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) || []) {
      if (next === target) return true
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return false
}

function intersectSets(values: Set<string>[]): Set<string> {
  if (values.length === 0) return new Set()
  const result = new Set(values[0])
  for (const item of [...result]) {
    if (values.slice(1).some(value => !value.has(item))) result.delete(item)
  }
  return result
}

function setIsStrictSubset(left: Set<string>, right: Set<string>): boolean {
  return left.size < right.size && [...left].every(value => right.has(value))
}

export function compileWorkflowGraph(rawNodes: unknown[], rawEdges: unknown[]): CompiledWorkflowGraph {
  const nodes = rawNodes.map((raw) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as any).id !== 'string' || !(raw as any).id.trim()) throw new Error('workflow node id is required')
    const record = raw as Record<string, any>
    if (record.type !== undefined && record.type !== 'agent') throw new Error('workflow nodes must use the Agent node type')
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? { ...record.data }
      : {}
    const reasoningEffort = normalizeReasoningEffort(data.reasoningEffort)
    delete data.reasoningEffort
    if (reasoningEffort) data.reasoningEffort = reasoningEffort
    return { ...record, id: record.id.trim(), type: 'agent', data }
  })
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`duplicate node id: ${node.id}`)
    nodeIds.add(node.id)
    if (node.data?.orchestration !== undefined && (node.data.orchestration === null || typeof node.data.orchestration !== 'object' || Array.isArray(node.data.orchestration))) throw new Error('node orchestration must be an object')
    normalizeWorkflowJoinMode(node.data?.orchestration?.joinMode)
  }

  const edgeIds = new Set<string>()
  const policies = new Map<string, WorkflowEdgeOrchestration>()
  const edges = rawEdges.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error('workflow edge must be an object')
    const edge = raw as any
    const source = typeof edge.source === 'string' ? edge.source.trim() : ''
    const target = typeof edge.target === 'string' ? edge.target.trim() : ''
    if (!nodeIds.has(source)) throw new Error(`edge has missing source: ${source}`)
    if (!nodeIds.has(target)) throw new Error(`edge has missing target: ${target}`)
    const policy = normalizeWorkflowEdgeOrchestration(edge.data?.orchestration)
    if (source === target && !policy.loop) throw new Error(`workflow graph contains self-loop: ${source}`)
    if (policy.loop && (typeof edge.id !== 'string' || !edge.id.trim())) throw new Error('feedback edge id is required')
    const id = typeof edge.id === 'string' && edge.id.trim() ? edge.id.trim() : `${source}->${target}#${index}`
    if (edgeIds.has(id)) throw new Error(`duplicate edge id: ${id}`)
    edgeIds.add(id)
    policies.set(id, policy)
    const hasData = edge.data && typeof edge.data === 'object' && !Array.isArray(edge.data)
    const hasExplicitOrchestration = hasData && Object.prototype.hasOwnProperty.call(edge.data, 'orchestration')
    const data = hasData
      ? { ...edge.data, ...(hasExplicitOrchestration ? { orchestration: policy } : {}) }
      : undefined
    return { ...edge, id, source, target, ...(data === undefined ? {} : { data }) }
  })

  const feedbackEdges = edges.filter(edge => policies.get(edge.id)!.loop)
  const forwardEdges = edges.filter(edge => !policies.get(edge.id)!.loop)
  const topologicalOrder = stableTopologicalOrder(nodes, forwardEdges)
  const topoIndex = new Map(topologicalOrder.map((id, index) => [id, index]))
  const forwardPredecessors = new Map(nodes.map(node => [node.id, [] as string[]]))
  const forwardOutgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of forwardEdges) {
    forwardPredecessors.get(edge.target)!.push(edge.source)
    forwardOutgoing.get(edge.source)!.push(edge.target)
  }

  // A DAG permits a single stable dominator pass in topological order. Roots
  // are treated as children of one virtual super-root so disconnected graphs
  // remain deterministic without inventing cross-component dominance.
  const virtualRoot = '__workflow_super_root__'
  const dominators = new Map<string, Set<string>>([[virtualRoot, new Set([virtualRoot])]])
  for (const nodeId of topologicalOrder) {
    const predecessors = forwardPredecessors.get(nodeId)!
    const predecessorDominators = predecessors.length
      ? predecessors.map(id => dominators.get(id)!)
      : [dominators.get(virtualRoot)!]
    const value = intersectSets(predecessorDominators)
    value.add(nodeId)
    dominators.set(nodeId, value)
  }

  const candidates: LoopCandidate[] = feedbackEdges.map((edge) => {
    const policy = policies.get(edge.id)!
    const header = edge.target
    const latch = edge.source
    if (!reachable(header, latch, forwardOutgoing)) {
      throw new Error(`feedback edge ${edge.id} target ${header} cannot reach source ${latch} in the forward graph`)
    }
    if (!dominators.get(latch)?.has(header)) {
      throw new Error(`feedback edge ${edge.id} is not a single-entry reducible loop because header ${header} does not dominate latch ${latch}`)
    }
    const region = new Set<string>([header, latch])
    const work = latch === header ? [] : [latch]
    while (work.length) {
      const current = work.pop()!
      for (const predecessor of forwardPredecessors.get(current) || []) {
        if (region.has(predecessor)) continue
        region.add(predecessor)
        if (predecessor !== header) work.push(predecessor)
      }
    }
    for (const nodeId of region) {
      if (!dominators.get(nodeId)?.has(header) || !reachable(header, nodeId, forwardOutgoing)) {
        throw new Error(`feedback edge ${edge.id} defines a multi-entry or irreducible loop region`)
      }
    }
    for (const candidateEdge of forwardEdges) {
      if (!region.has(candidateEdge.source) && region.has(candidateEdge.target) && candidateEdge.target !== header) {
        throw new Error(`feedback edge ${edge.id} defines a multi-entry loop at ${candidateEdge.target}`)
      }
    }
    const nodeIdsInOrder = topologicalOrder.filter(id => region.has(id))
    return {
      id: `loop:${edge.id}`,
      headerNodeId: header,
      latchNodeId: latch,
      feedbackEdgeId: edge.id,
      nodeIds: nodeIdsInOrder,
      maxIterations: policy.loop!.maxIterations,
      parentLoopId: null,
      nodeSet: region,
    }
  })

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex]
      const right = candidates[rightIndex]
      const intersection = [...left.nodeSet].filter(id => right.nodeSet.has(id))
      if (intersection.length === 0) continue
      const equal = left.nodeSet.size === right.nodeSet.size && intersection.length === left.nodeSet.size
      if (equal) throw new Error(`ambiguous feedback ownership: loop regions ${left.id} and ${right.id} are equal`)
      const nested = setIsStrictSubset(left.nodeSet, right.nodeSet) || setIsStrictSubset(right.nodeSet, left.nodeSet)
      if (!nested) throw new Error(`feedback loop regions ${left.id} and ${right.id} partially overlap and are not laminar`)
      if (left.headerNodeId === right.headerNodeId) {
        throw new Error(`ambiguous feedback ownership: nested loops ${left.id} and ${right.id} share header ${left.headerNodeId}`)
      }
    }
  }

  for (const candidate of candidates) {
    const containers = candidates
      .filter(other => setIsStrictSubset(candidate.nodeSet, other.nodeSet))
      .sort((a, b) => a.nodeSet.size - b.nodeSet.size || a.id.localeCompare(b.id))
    candidate.parentLoopId = containers[0]?.id || null
  }
  const depth = (candidate: LoopCandidate): number => {
    let value = 0
    let parentId = candidate.parentLoopId
    while (parentId) {
      value += 1
      parentId = candidates.find(item => item.id === parentId)?.parentLoopId || null
    }
    return value
  }
  candidates.sort((a, b) => (
    (topoIndex.get(a.headerNodeId)! - topoIndex.get(b.headerNodeId)!) ||
    (depth(a) - depth(b)) ||
    (b.nodeSet.size - a.nodeSet.size) ||
    a.id.localeCompare(b.id)
  ))
  const loops: CompiledWorkflowLoop[] = candidates.map(({ nodeSet: _nodeSet, ...loop }) => loop)

  const nodeLoopStacks: Record<string, string[]> = Object.create(null)
  for (const node of nodes) {
    nodeLoopStacks[node.id] = candidates
      .filter(loop => loop.nodeSet.has(node.id))
      .sort((a, b) => depth(a) - depth(b) || b.nodeSet.size - a.nodeSet.size || a.id.localeCompare(b.id))
      .map(loop => loop.id)
  }

  const edgeClassifications: Record<string, CompiledWorkflowEdgeClassification> = Object.create(null)
  const feedbackLoopByEdge = new Map(candidates.map(loop => [loop.feedbackEdgeId, loop]))
  for (const edge of edges) {
    const feedbackLoop = feedbackLoopByEdge.get(edge.id)
    if (feedbackLoop) {
      edgeClassifications[edge.id] = {
        kind: 'feedback', enterLoopIds: [], exitLoopIds: [], loopId: feedbackLoop.id,
      }
      continue
    }
    const sourceStack = nodeLoopStacks[edge.source] || []
    const targetStack = nodeLoopStacks[edge.target] || []
    let common = 0
    while (common < sourceStack.length && common < targetStack.length && sourceStack[common] === targetStack[common]) common += 1
    const exitLoopIds = sourceStack.slice(common).reverse()
    const enterLoopIds = targetStack.slice(common)
    const kind: CompiledWorkflowEdgeClassification['kind'] = exitLoopIds.length && enterLoopIds.length
      ? 'cross'
      : exitLoopIds.length ? 'exit'
        : enterLoopIds.length ? 'enter'
          : sourceStack.length ? 'internal'
            : 'forward'
    edgeClassifications[edge.id] = { kind, enterLoopIds, exitLoopIds }
  }

  return {
    nodes, edges, forwardEdges, feedbackEdges, topologicalOrder, loops, nodeLoopStacks, edgeClassifications,
  }
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
