import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowCreateInput,
  type WorkflowRecord,
  type WorkflowUpdateInput,
} from '../db/hermes/workflow-store'
import { getExactSessionDetailFromDbWithProfile } from '../db/hermes/sessions-db'
import {
  canonicalIterationPath,
  createSkippedWorkflowNodeExecution,
  createWorkflowEdgeEvaluation,
  createWorkflowLoopIteration,
  createWorkflowRun,
  createWorkflowRunEdgeResult,
  createWorkflowRunNodeSession,
  deleteWorkflowRun,
  deleteWorkflowRunNodeSessions,
  getWorkflowRun,
  listWorkflowRunEdgeEvaluations,
  listWorkflowRunEdgeResults,
  listWorkflowRunLoopIterations,
  listWorkflowRunNodeExecutions,
  listWorkflowRunNodeSessions,
  listAllWorkflowRuns,
  listOrphanedV2WorkflowRuns,
  listWorkflowRuns,
  reserveWorkflowNodeExecution,
  updateWorkflowEdgeEvaluation,
  updateWorkflowLoopIteration,
  updateWorkflowRun,
  updateWorkflowRunNodeExecution,
  updateWorkflowRunNodeState,
  updateWorkflowRunNodeSession,
  type WorkflowIterationPath,
  type WorkflowRunEdgeEvaluationRecord,
  type WorkflowRunEdgeResultRecord,
  type WorkflowRunLoopIterationRecord,
  type WorkflowRunNodeExecutionRecord,
  type WorkflowRunNodeSessionRecord,
  type WorkflowRunRecord,
} from '../db/hermes/workflow-run-store'
import { deleteSession, getSession, getSessionDetail } from '../db/hermes/session-store'
import { deleteUsage } from '../db/hermes/usage-store'
import { getChatRunServer } from '../routes/hermes/chat-run'
import type { ContentBlock } from './hermes/run-chat'
import type { AuthenticatedUser } from '../middleware/user-auth'
import { resolveWorkflowSkillContent } from './workflow-skill-resolver'
import { codingAgentRunManager } from './agent-runner/coding-agent-run-manager'
import { deleteSessionForProfile } from './hermes/hermes-cli'
import { listProfileNamesFromDisk } from './hermes/hermes-profile'
import { logger } from './logger'
import {
  compileWorkflowGraph,
  evaluateWorkflowEdge,
  hasNonLegacyWorkflowOrchestration,
  normalizeWorkflowEdgeOrchestration,
  normalizeWorkflowJoinMode,
  type CompiledWorkflowGraph,
  type CompiledWorkflowLoop,
} from './workflow-orchestration'
import { normalizeReasoningEffort, type ReasoningEffort } from '../../../shared/reasoning-effort'
import { validateReasoningEffortForProfile } from './reasoning-capability'

export type { WorkflowCreateInput, WorkflowRecord, WorkflowUpdateInput }

export type WorkflowRuntimeState = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'canceled'
export type WorkflowRunType = 'workflow'
export type WorkflowNodeAgent = 'hermes' | 'claude-code' | 'codex'

export interface WorkflowNodeRunTarget {
  type: WorkflowRunType
  source: 'workflow'
  agent: 'hermes' | 'claude' | 'codex'
  codingAgentId?: 'claude-code' | 'codex'
}

export interface WorkflowRuntimeStatus {
  workflowId: string
  status: WorkflowRuntimeState
  runId: string | null
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  error: string | null
  nodeStatuses: Record<string, WorkflowRuntimeState>
}

export interface WorkflowRunNowInput {
  profile?: string | null
  startNodeIds?: string[]
  input?: string | null
  user?: AuthenticatedUser
  timeoutMs?: number
  totalTimeoutMs?: number
  executionBudget?: number
}

export interface WorkflowRerunFromNodeInput {
  profile?: string | null
  preserveStartNode?: boolean
  user?: AuthenticatedUser
  timeoutMs?: number
}

export interface WorkflowRunNowResult {
  run: WorkflowRunRecord
  nodeSessions: WorkflowRunNodeSessionRecord[]
  edgeResults: WorkflowRunEdgeResultRecord[]
  nodeExecutions?: WorkflowRunNodeExecutionRecord[]
  edgeEvaluations?: WorkflowRunEdgeEvaluationRecord[]
  loopIterations?: WorkflowRunLoopIterationRecord[]
}

interface WorkflowNodeSnapshot {
  id: string
  type: string
  data: {
    title: string
    agent: string
    provider: string
    model: string
    apiMode: string
    reasoningEffort?: ReasoningEffort
    input: string
    skills: string[]
    images: string[]
    orchestration?: { joinMode?: unknown }
  }
}

interface WorkflowEdgeSnapshot {
  id?: string
  source: string
  target: string
  data?: { orchestration?: unknown; [key: string]: unknown }
}

type WorkflowManagerEvents = {
  status: [WorkflowRuntimeStatus]
}

type WorkflowStatusListener = (status: WorkflowRuntimeStatus) => void

function idleStatus(workflowId: string): WorkflowRuntimeStatus {
  return {
    workflowId,
    status: 'idle',
    runId: null,
    startedAt: null,
    updatedAt: Date.now(),
    completedAt: null,
    error: null,
    nodeStatuses: {},
  }
}

export function resolveWorkflowNodeRunTarget(agent?: string | null): WorkflowNodeRunTarget {
  if (agent === 'claude-code') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    }
  }
  if (agent === 'codex') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    }
  }
  return {
    type: 'workflow',
    source: 'workflow',
    agent: 'hermes',
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []
}

function normalizeNode(raw: unknown): WorkflowNodeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : ''
  if (!id) return null
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : {}
  const reasoningEffort = normalizeReasoningEffort(data.reasoningEffort)
  return {
    id,
    type: typeof record.type === 'string' && record.type ? record.type : 'agent',
    data: {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id,
      agent: typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : 'hermes',
      provider: typeof data.provider === 'string' ? data.provider.trim() : '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
      apiMode: typeof data.apiMode === 'string' ? data.apiMode.trim() : '',
      ...(reasoningEffort ? { reasoningEffort } : {}),
      input: typeof data.input === 'string' ? data.input : '',
      skills: stringArray(data.skills),
      images: stringArray(data.images),
      orchestration: data.orchestration && typeof data.orchestration === 'object' ? data.orchestration : undefined,
    },
  }
}

function normalizeEdge(raw: unknown): WorkflowEdgeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const source = typeof record.source === 'string' && record.source.trim() ? record.source.trim() : ''
  const target = typeof record.target === 'string' && record.target.trim() ? record.target.trim() : ''
  if (!source || !target) return null
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    source,
    target,
    data: record.data && typeof record.data === 'object' ? record.data as WorkflowEdgeSnapshot['data'] : undefined,
  }
}

function imageMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

function lastAssistantOutput(sessionId: string, fallback?: string | null): string {
  const detail = getSessionDetail(sessionId)
  const messages = detail?.messages || []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && String(message.content || '').trim()) return String(message.content || '')
  }
  return String(fallback || '')
}

function isWorkflowCodingAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  const agent = String(session?.agent || '').trim()
  return agent === 'claude' || agent === 'codex' || Boolean(session?.agent_session_id)
}

async function deleteHermesSessionIfPresent(sessionId: string, profile: string): Promise<void> {
  const targetProfile = profile || 'default'
  if (!listProfileNamesFromDisk().includes(targetProfile)) return
  try {
    const hermesSession = await getExactSessionDetailFromDbWithProfile(sessionId, targetProfile)
    if (!hermesSession) return
    const deleted = await deleteSessionForProfile(sessionId, targetProfile)
    if (!deleted) {
      logger.warn({ sessionId, profile: targetProfile }, '[workflow] failed to delete Hermes session for workflow run node')
    }
  } catch (err) {
    logger.warn({ err, sessionId, profile: targetProfile }, '[workflow] skipped Hermes session delete for workflow run node')
  }
}

function reachableFrom(startIds: string[], outgoing: Map<string, WorkflowEdgeSnapshot[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [...startIds]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of outgoing.get(id) || []) stack.push(edge.target)
  }
  return visited
}

export const DEFAULT_WORKFLOW_EXECUTION_BUDGET = 1_000
export const MAX_WORKFLOW_EXECUTION_BUDGET = 10_000
export const DEFAULT_WORKFLOW_TOTAL_TIMEOUT_MS = 60 * 60 * 1_000
export const MAX_WORKFLOW_TOTAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000
export const WORKFLOW_ORCHESTRATION_COMPILER_VERSION = 'workflow-orchestration-v2'

export function validateWorkflowRunSafetyLimits(input: Pick<WorkflowRunNowInput, 'totalTimeoutMs' | 'executionBudget'>): {
  totalTimeoutMs: number
  executionBudget: number
} {
  const totalTimeoutMs = input.totalTimeoutMs ?? DEFAULT_WORKFLOW_TOTAL_TIMEOUT_MS
  if (!Number.isFinite(totalTimeoutMs) || !Number.isInteger(totalTimeoutMs) || totalTimeoutMs <= 0 || totalTimeoutMs > MAX_WORKFLOW_TOTAL_TIMEOUT_MS) {
    const err = new Error(`totalTimeoutMs must be an integer between 1 and ${MAX_WORKFLOW_TOTAL_TIMEOUT_MS}`)
    ;(err as any).status = 400
    throw err
  }
  const executionBudget = input.executionBudget ?? DEFAULT_WORKFLOW_EXECUTION_BUDGET
  if (!Number.isFinite(executionBudget) || !Number.isInteger(executionBudget) || executionBudget <= 0 || executionBudget > MAX_WORKFLOW_EXECUTION_BUDGET) {
    const err = new Error(`executionBudget must be an integer between 1 and ${MAX_WORKFLOW_EXECUTION_BUDGET}`)
    ;(err as any).status = 400
    throw err
  }
  return { totalTimeoutMs, executionBudget }
}

interface WorkflowV2Instance {
  key: string
  node: WorkflowNodeSnapshot
  path: WorkflowIterationPath
  status: WorkflowRuntimeState
  trigger: 'root' | 'feedback' | null
  incoming: Map<string, WorkflowRunEdgeEvaluationRecord>
  execution: WorkflowRunNodeExecutionRecord | null
  output: string
  outcome: { nodeId: string; status: 'success' | 'failure'; output: string; error?: string | null } | null
}

interface WorkflowV2HeldEvaluation {
  evaluationId: string
  edge: WorkflowEdgeSnapshot
  sourcePath: WorkflowIterationPath
  targetPath: WorkflowIterationPath
  remainingBarriers: string[]
}

export class WorkflowManager extends EventEmitter<WorkflowManagerEvents> {
  private readonly runtimeStatuses = new Map<string, WorkflowRuntimeStatus>()
  private readonly canceledRunIds = new Set<string>()
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()

  list(profile?: string | null): WorkflowRecord[] {
    return listWorkflows(profile)
  }

  get(id: string): WorkflowRecord | null {
    return getWorkflow(id)
  }

  create(input: WorkflowCreateInput): WorkflowRecord {
    return createWorkflow(input)
  }

  update(id: string, input: WorkflowUpdateInput): WorkflowRecord | null {
    return updateWorkflow(id, input)
  }

  async delete(id: string): Promise<boolean> {
    const workflow = getWorkflow(id)
    if (!workflow) return false
    const runs = listAllWorkflowRuns(id)
    for (const run of runs) {
      await this.deleteRun(id, run.id)
    }
    const deleted = deleteWorkflow(id)
    if (deleted) this.runtimeStatuses.delete(id)
    return deleted
  }

  async recoverOrphanedV2Runs(): Promise<{ runs: number; sessions: number }> {
    const orphaned = listOrphanedV2WorkflowRuns()
    if (orphaned.length === 0) return { runs: 0, sessions: 0 }
    const reason = 'Workflow runtime cannot safely resume because the server restarted'
    const sessionIds = new Set<string>()
    const finishedAt = Date.now()
    for (const run of orphaned) {
      // Persist fail-closed terminal evidence before asking any owner to abort.
      // Abort callbacks may resolve stale waiters synchronously.
      updateWorkflowRun(run.id, {
        status: 'failed', finished_at: finishedAt, error: reason, terminal_code: 'runtime_restarted',
      })
      for (const execution of listWorkflowRunNodeExecutions(run.id)) {
        if (execution.status !== 'queued' && execution.status !== 'running') continue
        updateWorkflowRunNodeExecution(execution.execution_id, {
          status: 'failed', finished_at: finishedAt, error: reason,
        })
        if (execution.session_id) sessionIds.add(execution.session_id)
      }
      for (const iteration of listWorkflowRunLoopIterations(run.id)) {
        if (iteration.status !== 'running') continue
        updateWorkflowLoopIteration(iteration.id, {
          status: 'failed', finished_at: finishedAt, error: reason,
        })
      }
      this.setRuntimeStatus(run.workflow_id, {
        status: 'failed', runId: run.id, startedAt: run.started_at,
        completedAt: finishedAt, error: reason, nodeStatuses: {},
      })
    }
    const chatRun = getChatRunServer()
    await Promise.allSettled([...sessionIds].map(sessionId => chatRun?.abortSession?.(sessionId, reason)))
    return { runs: orphaned.length, sessions: sessionIds.size }
  }

  async stopRun(workflowId: string, runId: string, reason = 'Workflow run canceled'): Promise<WorkflowRunRecord | null> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return null
    this.canceledRunIds.add(runId)
    const finishedAt = Date.now()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    const sessionIdsToAbort = new Set<string>()
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const session of nodeSessions) {
      const status = session.status === 'completed' || session.status === 'failed' || session.status === 'skipped'
        ? session.status
        : 'canceled'
      nodeStatuses[session.node_id] = status
      if (status === 'canceled') {
        updateWorkflowRunNodeSession(session.id, {
          status: 'canceled',
          finished_at: finishedAt,
          error: reason,
        })
      }
      if ((session.status === 'queued' || session.status === 'running') && session.session_id) {
        sessionIdsToAbort.add(session.session_id)
      }
    }
    if (run.orchestration_version === 2) {
      for (const execution of listWorkflowRunNodeExecutions(runId)) {
        const status = execution.status === 'completed' || execution.status === 'failed' || execution.status === 'skipped'
          ? execution.status
          : 'canceled'
        nodeStatuses[execution.node_id] = status
        if (status === 'canceled') {
          updateWorkflowRunNodeExecution(execution.execution_id, {
            status: 'canceled', finished_at: finishedAt, error: reason,
          })
        }
        if ((execution.status === 'queued' || execution.status === 'running') && execution.session_id) {
          sessionIdsToAbort.add(execution.session_id)
        }
      }
      for (const iteration of listWorkflowRunLoopIterations(runId)) {
        if (iteration.status !== 'running') continue
        updateWorkflowLoopIteration(iteration.id, {
          status: 'canceled', finished_at: finishedAt, error: reason,
        })
      }
    }
    // Persist terminal intent before aborting the owning runtimes. An abort may
    // resolve runAndWait synchronously; the scheduler must observe the exact
    // operator reason rather than racing against a still-running run record.
    const stopped = updateWorkflowRun(runId, {
      status: 'canceled',
      finished_at: finishedAt,
      error: reason,
      terminal_code: run.orchestration_version === 2 ? 'workflow_canceled' : run.terminal_code,
    }) || run
    await Promise.allSettled([...sessionIdsToAbort].map(sessionId => getChatRunServer()?.abortSession?.(sessionId, reason)))
    this.setRuntimeStatus(workflowId, {
      status: 'canceled',
      runId,
      completedAt: finishedAt,
      error: reason,
      nodeStatuses,
    })
    return stopped
  }

  async deleteRun(workflowId: string, runId: string): Promise<boolean> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    if (run.status === 'queued' || run.status === 'running') {
      await this.stopRun(workflowId, runId, 'Workflow run deleted')
    }
    const sessionArtifacts = new Map<string, { profile: string; agent: string }>()
    for (const nodeSession of listWorkflowRunNodeSessions(runId)) {
      if (nodeSession.session_id) sessionArtifacts.set(nodeSession.session_id, { profile: nodeSession.profile, agent: nodeSession.agent })
    }
    if (run.orchestration_version === 2) {
      for (const execution of listWorkflowRunNodeExecutions(runId)) {
        if (execution.session_id) sessionArtifacts.set(execution.session_id, { profile: execution.profile, agent: execution.agent })
      }
    }
    for (const [sessionId, artifact] of sessionArtifacts) {
      await this.deleteNodeSessionArtifacts(sessionId, artifact.profile, artifact.agent)
    }
    this.canceledRunIds.delete(runId)
    return deleteWorkflowRun(runId)
  }

  private async deleteNodeSessionArtifacts(sessionId: string, profile: string, agent: string): Promise<void> {
    if (!sessionId) return
    const existing = getSession(sessionId)
    if (isWorkflowCodingAgentSession(existing)) {
      codingAgentRunManager.stop(sessionId, { reportClosed: false })
    } else if (agent === 'hermes') {
      await deleteHermesSessionIfPresent(sessionId, profile || existing?.profile || 'default')
    }
    if (existing) {
      deleteSession(sessionId)
      deleteUsage(sessionId)
    }
  }

  getRuntimeStatus(workflowId: string): WorkflowRuntimeStatus {
    return this.runtimeStatuses.get(workflowId) || idleStatus(workflowId)
  }

  listRuntimeStatuses(): WorkflowRuntimeStatus[] {
    return [...this.runtimeStatuses.values()]
  }

  setRuntimeStatus(
    workflowId: string,
    patch: Partial<Omit<WorkflowRuntimeStatus, 'workflowId' | 'updatedAt'>>,
  ): WorkflowRuntimeStatus {
    const previous = this.getRuntimeStatus(workflowId)
    const status: WorkflowRuntimeStatus = {
      ...previous,
      ...patch,
      nodeStatuses: patch.nodeStatuses || previous.nodeStatuses || {},
      workflowId,
      updatedAt: Date.now(),
    }
    this.runtimeStatuses.set(workflowId, status)
    this.emit('status', status)
    return status
  }

  onRuntimeStatus(listener: WorkflowStatusListener): () => void {
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  prepareRun(workflowId: string, requestedStartNodeIds?: string[]): { workflow: WorkflowRecord; compiled: ReturnType<typeof compileWorkflowGraph>; startNodeIds: string[] } {
    const workflow = this.get(workflowId)
    if (!workflow) { const err = new Error('workflow not found'); (err as any).status = 404; throw err }
    try {
      const compiled = compileWorkflowGraph(workflow.nodes, workflow.edges)
      if (compiled.nodes.length === 0) throw new Error('workflow has no nodes')
      const nodeIds = new Set(compiled.nodes.map(node => node.id))
      const explicitStartNodeIds = requestedStartNodeIds?.length ? requestedStartNodeIds : undefined
      const unknownStartNodeIds = explicitStartNodeIds?.filter(id => !nodeIds.has(id)) || []
      if (unknownStartNodeIds.length) throw new Error(`unknown start node ids: ${unknownStartNodeIds.join(', ')}`)
      const incomingNodeIds = new Set(compiled.forwardEdges.map(edge => edge.target))
      const startNodeIds = explicitStartNodeIds || compiled.nodes.filter(node => !incomingNodeIds.has(node.id)).map(node => node.id)
      if (startNodeIds.length === 0) throw new Error('workflow has no start nodes')
      return { workflow, compiled, startNodeIds }
    } catch (cause) {
      const err = new Error(cause instanceof Error ? cause.message : String(cause)); (err as any).status = 400; throw err
    }
  }

  async preflightPreparedRun(
    prepared: { workflow: WorkflowRecord; compiled: ReturnType<typeof compileWorkflowGraph>; startNodeIds: string[] },
    input: WorkflowRunNowInput = {},
  ): Promise<void> {
    const { workflow, compiled, startNodeIds } = prepared
    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available'); (err as any).status = 503; throw err
    }
    const profile = input.profile?.trim() || workflow.profile || 'default'
    const nodes = compiled.nodes.map(normalizeNode) as WorkflowNodeSnapshot[]
    const outgoing = new Map(nodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    const reachabilityEdges = compiled.loops.length > 0 ? compiled.forwardEdges : compiled.edges
    for (const edge of reachabilityEdges as WorkflowEdgeSnapshot[]) outgoing.get(edge.source)?.push(edge)
    const activeIds = reachableFrom(startNodeIds, outgoing)
    const activeNodes = nodes.filter(node => activeIds.has(node.id))

    if (compiled.loops.length > 0) {
      validateWorkflowRunSafetyLimits(input)
      const loopById = new Map(compiled.loops.map(loop => [loop.id, loop]))
      for (const startNodeId of startNodeIds) {
        const stack = compiled.nodeLoopStacks[startNodeId] || []
        if (stack.length > 0 && stack.some(loopId => loopById.get(loopId)?.headerNodeId !== startNodeId)) {
          const err = new Error(`explicit start node ${startNodeId} is inside a loop but is not every containing loop header`)
          ;(err as any).status = 400
          throw err
        }
      }
    }
    await this.preflightWorkflowNodes(profile, activeNodes)
  }

  private async preflightWorkflowNodes(profile: string, nodes: WorkflowNodeSnapshot[]): Promise<void> {
    const { getAvailableModelReferencesForProfile } = await import('../controllers/hermes/models')
    const available = await getAvailableModelReferencesForProfile(profile)
    const keys = new Set(available.map(reference => `${reference.provider}\0${reference.model}\0${reference.apiMode}`))
    for (const node of nodes) {
      const provider = String(node.data.provider || '').trim()
      const model = String(node.data.model || '').trim()
      const apiMode = String(node.data.apiMode || '').trim()
      const hasExplicitTarget = Boolean(provider || model || apiMode)
      if (hasExplicitTarget && (!provider || !model || !apiMode || !keys.has(`${provider}\0${model}\0${apiMode}`))) {
        const err = new Error(`workflow_model_unavailable: ${provider || '(missing)'}/${model || '(missing)'}/${apiMode || '(missing)'}`)
        ;(err as any).code = 'workflow_model_unavailable'
        ;(err as any).status = 400
        throw err
      }
      if (!node.data.reasoningEffort) continue
      await validateReasoningEffortForProfile({
        profile, provider, model, apiMode, reasoningEffort: node.data.reasoningEffort,
      })
    }
  }

  async runNow(workflowId: string, input: WorkflowRunNowInput = {}): Promise<WorkflowRunNowResult> {
    return this.runPrepared(this.prepareRun(workflowId, input.startNodeIds), input)
  }

  async runPrepared(prepared: { workflow: WorkflowRecord; compiled: ReturnType<typeof compileWorkflowGraph>; startNodeIds: string[] }, input: WorkflowRunNowInput = {}): Promise<WorkflowRunNowResult> {
    const { workflow, compiled } = prepared
    const workflowId = workflow.id
    if (!workflow) {
      const err = new Error('workflow not found'); (err as any).status = 404; throw err
    }
    await this.preflightPreparedRun(prepared, input)
    if (compiled.loops.length > 0) return this.runPreparedV2(prepared, input)
    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available'); (err as any).status = 503; throw err
    }

    const profile = input.profile?.trim() || workflow.profile || 'default'
    const nodes = compiled.nodes.map(normalizeNode) as WorkflowNodeSnapshot[]
    const edges = compiled.edges.map(normalizeEdge) as WorkflowEdgeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    if (nodes.length === 0) {
      const err = new Error('workflow has no nodes'); (err as any).status = 400; throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) { incoming.set(node.id, []); outgoing.set(node.id, []) }
    for (const edge of edges) { incoming.get(edge.target)!.push(edge); outgoing.get(edge.source)!.push(edge) }
    const startNodeIds = prepared.startNodeIds
    const activeIds = reachableFrom(startNodeIds, outgoing)
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = edges.filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const activeIncoming = new Map(activeNodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    const activeOutgoing = new Map(activeNodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    for (const edge of activeEdges) { activeIncoming.get(edge.target)!.push(edge); activeOutgoing.get(edge.source)!.push(edge) }

    const startedAt = Date.now()
    const run = createWorkflowRun({
      workflow_id: workflow.id, profile, workspace: workflow.workspace, start_node_ids: startNodeIds,
      status: 'running', snapshot_nodes: compiled.nodes, snapshot_edges: compiled.edges, started_at: startedAt,
    })
    this.canceledRunIds.delete(run.id)
    const nodeStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const]))
    this.setRuntimeStatus(workflow.id, {
      status: 'running', runId: run.id, startedAt, completedAt: null, error: null, nodeStatuses: { ...nodeStatuses },
    })

    const terminal = new Set<string>()
    const outcomes = new Map<string, { nodeId: string; status: 'success' | 'failure'; output: string; error?: string | null }>()
    const outputs = new Map<string, string>()
    const edgeResults = new Map<string, WorkflowRunEdgeResultRecord>()
    const consumedIncomingEdgeIds = new Map<string, Set<string>>()
    const nodeSessionRecordIds = new Map<string, string>()
    let nodeSequence = 0
    let edgeSequence = 0
    const running = new Map<string, Promise<any>>()

    const result = (finalRun: WorkflowRunRecord): WorkflowRunNowResult => ({
      run: finalRun,
      nodeSessions: listWorkflowRunNodeSessions(run.id),
      edgeResults: listWorkflowRunEdgeResults(run.id),
    })
    const finishRun = (status: 'completed' | 'failed' | 'canceled', error: string | null) => {
      const finishedAt = Date.now()
      const finalRun = updateWorkflowRun(run.id, { status, finished_at: finishedAt, error }) || run
      this.setRuntimeStatus(workflow.id, {
        status, runId: run.id, completedAt: finishedAt, error, nodeStatuses: { ...nodeStatuses },
      })
      return finalRun
    }
    const persistEdge = (edge: WorkflowEdgeSnapshot, status: 'taken' | 'not_taken' | 'error', reason: string, context: Record<string, unknown>) => {
      const edgeId = edge.id!
      const stored = createWorkflowRunEdgeResult({
        run_id: run.id, workflow_id: workflow.id, edge_id: edgeId,
        source_node_id: edge.source, target_node_id: edge.target,
        status, reason, context, sequence: edgeSequence++,
      })
      edgeResults.set(edgeId, stored)
    }
    const skipNode = (node: WorkflowNodeSnapshot, reason: string) => {
      const now = Date.now()
      updateWorkflowRunNodeState(run.id, node.id, { status: 'skipped', reason, started_at: now, finished_at: now })
      nodeStatuses[node.id] = 'skipped'
      terminal.add(node.id)
    }

    try {
      while (terminal.size < activeNodes.length) {
        if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
          await Promise.allSettled(running.values())
          running.clear()
          for (const node of activeNodes) if (!terminal.has(node.id)) nodeStatuses[node.id] = 'canceled'
          return result(finishRun('canceled', 'Workflow run canceled'))
        }

        for (const edge of activeEdges) {
          if (edgeResults.has(edge.id!) || !terminal.has(edge.source)) continue
          const outcome = outcomes.get(edge.source)
          if (!outcome) {
            persistEdge(edge, 'not_taken', 'source node was skipped', { nodeId: edge.source, status: 'skipped' })
            continue
          }
          const evaluation = evaluateWorkflowEdge(edge, outcome)
          persistEdge(edge, evaluation.status, evaluation.reason, evaluation.context as unknown as Record<string, unknown>)
        }

        const ready: WorkflowNodeSnapshot[] = []
        let madeProgress = false
        for (const node of activeNodes) {
          if (nodeStatuses[node.id] !== 'queued') continue
          if (startNodeIds.includes(node.id) || activeIncoming.get(node.id)!.length === 0) { ready.push(node); continue }
          const inbound = activeIncoming.get(node.id)!
          const evaluated = inbound.map(edge => edgeResults.get(edge.id!))
          const joinMode = normalizeWorkflowJoinMode(node.data.orchestration?.joinMode)
          if (joinMode === 'any' && evaluated.some(item => item?.status === 'taken')) { ready.push(node); continue }
          if (evaluated.some(item => !item)) continue
          const shouldRun = joinMode === 'all'
            ? evaluated.every(item => item!.status === 'taken')
            : evaluated.some(item => item!.status === 'taken')
          if (shouldRun) ready.push(node)
          else { skipNode(node, `join ${joinMode} was not satisfied`); madeProgress = true }
        }

        if (ready.length === 0 && running.size === 0) {
          if (madeProgress) continue
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        for (const node of ready) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflow.id, { status: 'running', runId: run.id, nodeStatuses: { ...nodeStatuses } })

        for (const node of ready) running.set(node.id, (async () => {
          const nodeSessionId = randomUUID()
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id, workflow_id: workflow.id, node_id: node.id, session_id: nodeSessionId, profile,
            agent: target.agent, agent_mode: node.data.agent === 'hermes' ? '' : 'scoped', status: 'running',
            sequence: nodeSequence++, started_at: Date.now(),
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const takenIncoming = activeIncoming.get(node.id)!.filter(edge => edgeResults.get(edge.id!)?.status === 'taken')
          consumedIncomingEdgeIds.set(node.id, new Set(takenIncoming.map(edge => edge.id!)))
          const assembledInput = await this.buildNodeUserMessage({
            node, incomingEdges: takenIncoming, nodeById, outputs,
            overrideInput: startNodeIds.includes(node.id) ? input.input : undefined, profile,
          })
          const runResult = await chatRun.runAndWait({
            session_id: nodeSessionId, source: 'workflow', session_source: 'workflow', input: assembledInput,
            profile, workspace: workflow.workspace, model: node.data.model || undefined,
            provider: node.data.provider || undefined, mode: node.data.agent === 'hermes' ? undefined : 'scoped',
            coding_agent_id: target.codingAgentId, agent_id: target.codingAgentId, apiMode: node.data.apiMode || undefined,
            ...(node.data.reasoningEffort ? { reasoning_effort: node.data.reasoningEffort } : {}),
          }, { profile, user: input.user, timeoutMs: input.timeoutMs, approvalChoice: 'once' })
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
            updateWorkflowRunNodeSession(nodeSession.id, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error })
            return { node, status: canceled ? 'canceled' as const : 'failure' as const, output, error }
          }
          const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
          updateWorkflowRunNodeSession(nodeSession.id, { status: canceled ? 'canceled' : 'completed', finished_at: Date.now(), error: canceled ? 'Workflow run canceled' : null })
          return { node, status: canceled ? 'canceled' as const : 'success' as const, output, error: null }
        })())

        if (running.size === 0) continue
        const execution = await Promise.race(running.values())
        running.delete(execution.node.id)
        {
          if (execution.status === 'canceled') {
            nodeStatuses[execution.node.id] = 'canceled'
            await Promise.allSettled(running.values())
            running.clear()
            for (const node of activeNodes) if (!terminal.has(node.id)) nodeStatuses[node.id] = 'canceled'
            return result(finishRun('canceled', execution.error))
          }
          nodeStatuses[execution.node.id] = execution.status === 'success' ? 'completed' : 'failed'
          outputs.set(execution.node.id, execution.output || execution.error || '')
          outcomes.set(execution.node.id, {
            nodeId: execution.node.id, status: execution.status, output: execution.output, error: execution.error,
          })
          terminal.add(execution.node.id)
        }
        this.setRuntimeStatus(workflow.id, { status: 'running', runId: run.id, nodeStatuses: { ...nodeStatuses } })
      }

      for (const edge of activeEdges) {
        if (edgeResults.has(edge.id!) || !terminal.has(edge.source)) continue
        const outcome = outcomes.get(edge.source)
        if (!outcome) {
          persistEdge(edge, 'not_taken', 'source node was skipped', { nodeId: edge.source, status: 'skipped' })
          continue
        }
        const evaluation = evaluateWorkflowEdge(edge, outcome)
        persistEdge(edge, evaluation.status, evaluation.reason, evaluation.context as unknown as Record<string, unknown>)
      }

      const unhandled = [...outcomes.values()].filter(outcome => outcome.status === 'failure').filter(outcome =>
        !(activeOutgoing.get(outcome.nodeId) || []).some(edge => {
          const edgeResult = edgeResults.get(edge.id!)
          if (edgeResult?.status !== 'taken' || !consumedIncomingEdgeIds.get(edge.target)?.has(edge.id!)) return false
          try { return normalizeWorkflowEdgeOrchestration(edge.data?.orchestration).route !== 'success' } catch { return false }
        }),
      )
      if (unhandled.length > 0) {
        const message = unhandled.map(outcome => `Node ${nodeById.get(outcome.nodeId)?.data.title || outcome.nodeId} failed: ${outcome.error}`).join('; ')
        return result(finishRun('failed', message))
      }
      return result(finishRun('completed', null))
    } catch (err) {
      await Promise.allSettled(running.values())
      running.clear()
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [nodeId, recordId] of nodeSessionRecordIds) {
        if (!terminal.has(nodeId) && nodeStatuses[nodeId] !== 'skipped') {
          nodeStatuses[nodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
      return result(finishRun(canceled ? 'canceled' : 'failed', message))
    }
  }

  private async runPreparedV2(
    prepared: { workflow: WorkflowRecord; compiled: CompiledWorkflowGraph; startNodeIds: string[] },
    input: WorkflowRunNowInput,
  ): Promise<WorkflowRunNowResult> {
    const { workflow, compiled, startNodeIds } = prepared
    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available'); (err as any).status = 503; throw err
    }
    const profile = input.profile?.trim() || workflow.profile || 'default'
    const nodes = compiled.nodes.map(normalizeNode) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const edgeById = new Map((compiled.edges as WorkflowEdgeSnapshot[]).map(edge => [edge.id!, edge]))
    const loopById = new Map(compiled.loops.map(loop => [loop.id, loop]))
    const topoIndex = new Map(compiled.topologicalOrder.map((id, index) => [id, index]))

    const { totalTimeoutMs, executionBudget } = validateWorkflowRunSafetyLimits(input)

    const forwardOutgoingForReachability = new Map(nodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    for (const edge of compiled.forwardEdges as WorkflowEdgeSnapshot[]) forwardOutgoingForReachability.get(edge.source)!.push(edge)
    const activeIds = reachableFrom(startNodeIds, forwardOutgoingForReachability)
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = (compiled.edges as WorkflowEdgeSnapshot[]).filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const activeForwardEdges = (compiled.forwardEdges as WorkflowEdgeSnapshot[]).filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const incoming = new Map(activeNodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    const outgoing = new Map(activeNodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    for (const edge of activeForwardEdges) incoming.get(edge.target)!.push(edge)
    for (const edge of activeEdges) outgoing.get(edge.source)!.push(edge)

    const startedAt = Date.now()
    const deadlineAt = startedAt + totalTimeoutMs
    const compiledPlan = {
      topologicalOrder: compiled.topologicalOrder,
      loops: compiled.loops,
      nodeLoopStacks: compiled.nodeLoopStacks,
      edgeClassifications: compiled.edgeClassifications,
    }
    const run = createWorkflowRun({
      workflow_id: workflow.id, profile, workspace: workflow.workspace, start_node_ids: startNodeIds,
      status: 'running', snapshot_nodes: compiled.nodes, snapshot_edges: compiled.edges, started_at: startedAt,
      orchestration_version: 2, compiler_version: WORKFLOW_ORCHESTRATION_COMPILER_VERSION,
      compiled_plan: compiledPlan, deadline_at: deadlineAt, execution_budget: executionBudget,
    })
    this.canceledRunIds.delete(run.id)
    const nodeStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const]))
    this.setRuntimeStatus(workflow.id, {
      status: 'running', runId: run.id, startedAt, completedAt: null, error: null, nodeStatuses: { ...nodeStatuses },
    })

    const pathKey = (path: WorkflowIterationPath) => canonicalIterationPath(path)
    const instanceKey = (nodeId: string, path: WorkflowIterationPath) => `${nodeId}\u0000${pathKey(path)}`
    const samePrefix = (path: WorkflowIterationPath, prefix: WorkflowIterationPath) => (
      path.length >= prefix.length && prefix.every((entry, index) => path[index]?.loopId === entry.loopId && path[index]?.iteration === entry.iteration)
    )
    const loopPrefix = (path: WorkflowIterationPath, loopId: string): WorkflowIterationPath => {
      const index = path.findIndex(entry => entry.loopId === loopId)
      if (index < 0) throw new Error(`iteration path does not contain ${loopId}`)
      return path.slice(0, index + 1)
    }
    const targetPathForEdge = (edge: WorkflowEdgeSnapshot, sourcePath: WorkflowIterationPath): WorkflowIterationPath => {
      const sourceStack = compiled.nodeLoopStacks[edge.source] || []
      const targetStack = compiled.nodeLoopStacks[edge.target] || []
      if (sourceStack.length !== sourcePath.length || sourceStack.some((loopId, index) => sourcePath[index]?.loopId !== loopId)) {
        throw new Error(`source iteration path does not match loop stack for ${edge.source}`)
      }
      let common = 0
      while (common < sourceStack.length && common < targetStack.length && sourceStack[common] === targetStack[common]) common += 1
      return [
        ...sourcePath.slice(0, common),
        ...targetStack.slice(common).map(loopId => ({ loopId, iteration: 1 })),
      ]
    }

    const instances = new Map<string, WorkflowV2Instance>()
    const executionInstanceById = new Map<string, WorkflowV2Instance>()
    const propagated = new Set<string>()
    const handledFailureExecutionIds = new Set<string>()
    const feedbackInputByInstance = new Map<string, { edge: WorkflowEdgeSnapshot; source: WorkflowV2Instance }>()
    const heldEvaluations: WorkflowV2HeldEvaluation[] = []
    const loopEpochs = new Map<string, {
      loop: CompiledWorkflowLoop
      path: WorkflowIterationPath
      record: WorkflowRunLoopIterationRecord
      feedback: WorkflowRunEdgeEvaluationRecord | null
    }>()
    const running = new Map<string, Promise<{ instance: WorkflowV2Instance; ok: boolean; canceled: boolean; output: string; error: string | null }>>()
    let executionSequence = 0
    let edgeSequence = 0
    let loopSequence = 0
    let terminalFailure: { code: string; message: string } | null = null

    const result = (finalRun: WorkflowRunRecord): WorkflowRunNowResult => ({
      run: finalRun,
      nodeSessions: [], edgeResults: [],
      nodeExecutions: listWorkflowRunNodeExecutions(run.id),
      edgeEvaluations: listWorkflowRunEdgeEvaluations(run.id),
      loopIterations: listWorkflowRunLoopIterations(run.id),
    })
    const finishRun = (status: 'completed' | 'failed' | 'canceled', error: string | null, terminalCode: string | null) => {
      const finishedAt = Date.now()
      const finalRun = updateWorkflowRun(run.id, { status, finished_at: finishedAt, error, terminal_code: terminalCode }) || run
      this.setRuntimeStatus(workflow.id, {
        status, runId: run.id, completedAt: finishedAt, error, nodeStatuses: { ...nodeStatuses },
      })
      return finalRun
    }
    const ensureLoopEpochs = (path: WorkflowIterationPath) => {
      for (let index = 0; index < path.length; index += 1) {
        const entry = path[index]
        const loop = loopById.get(entry.loopId)
        if (!loop) throw new Error(`unknown loop in iteration path: ${entry.loopId}`)
        const prefix = path.slice(0, index + 1)
        const key = `${entry.loopId}\u0000${pathKey(prefix)}`
        if (loopEpochs.has(key)) continue
        const record = createWorkflowLoopIteration({
          run_id: run.id, workflow_id: workflow.id, loop_id: entry.loopId,
          iteration_path: prefix, iteration: entry.iteration, sequence: loopSequence++, status: 'running',
        })
        loopEpochs.set(key, { loop, path: prefix, record, feedback: null })
      }
    }
    const ensureInstance = (nodeId: string, path: WorkflowIterationPath, trigger: 'root' | 'feedback' | null = null): WorkflowV2Instance => {
      const node = nodeById.get(nodeId)
      if (!node || !activeIds.has(nodeId)) throw new Error(`cannot schedule inactive node ${nodeId}`)
      const expectedStack = compiled.nodeLoopStacks[nodeId] || []
      if (expectedStack.length !== path.length || expectedStack.some((loopId, index) => path[index]?.loopId !== loopId)) {
        throw new Error(`iteration path does not match loop stack for ${nodeId}`)
      }
      ensureLoopEpochs(path)
      const key = instanceKey(nodeId, path)
      const existing = instances.get(key)
      if (existing) {
        if (trigger && !existing.trigger) existing.trigger = trigger
        return existing
      }
      const created: WorkflowV2Instance = {
        key, node, path: JSON.parse(pathKey(path)), status: 'queued', trigger,
        incoming: new Map(), execution: null, output: '', outcome: null,
      }
      instances.set(key, created)
      return created
    }
    const persistProjection = (instance: WorkflowV2Instance, reason = '') => {
      const evidence = instance.execution
      updateWorkflowRunNodeState(run.id, instance.node.id, {
        status: instance.status === 'idle' ? 'queued' : instance.status,
        ...(reason ? { reason } : {}),
        started_at: evidence?.started_at ?? null,
        finished_at: evidence?.finished_at ?? null,
      })
      nodeStatuses[instance.node.id] = instance.status
    }
    const deliverEvaluation = (evaluation: WorkflowRunEdgeEvaluationRecord, edge: WorkflowEdgeSnapshot, targetPath: WorkflowIterationPath) => {
      updateWorkflowEdgeEvaluation(evaluation.id, { delivery_status: 'delivered' })
      const target = ensureInstance(edge.target, targetPath)
      if (!target.incoming.has(edge.id!)) target.incoming.set(edge.id!, { ...evaluation, delivery_status: 'delivered' })
    }
    const persistEvaluation = (
      edge: WorkflowEdgeSnapshot,
      source: WorkflowV2Instance,
      status: 'taken' | 'not_taken' | 'error',
      reason: string,
      context: Record<string, unknown>,
      deliveryStatus: 'pending' | 'delivered' | 'suppressed',
      loopId: string | null,
    ) => createWorkflowEdgeEvaluation({
      run_id: run.id, workflow_id: workflow.id, source_execution_id: source.execution?.execution_id || null,
      edge_id: edge.id!, source_node_id: edge.source, target_node_id: edge.target,
      iteration_path: source.path, loop_id: loopId, status, delivery_status: deliveryStatus,
      reason, context, sequence: edgeSequence++,
    })
    const evaluateSource = (instance: WorkflowV2Instance) => {
      if (propagated.has(instance.key)) return
      propagated.add(instance.key)
      for (const edge of outgoing.get(instance.node.id) || []) {
        const classification = compiled.edgeClassifications[edge.id!]
        let evaluation: { status: 'taken' | 'not_taken' | 'error'; reason: string; context: Record<string, unknown> }
        if (instance.status === 'skipped') {
          evaluation = {
            status: 'not_taken', reason: 'source node was skipped',
            context: { nodeId: instance.node.id, status: 'skipped' },
          }
        } else if (instance.outcome) {
          const result = evaluateWorkflowEdge(edge, instance.outcome)
          evaluation = { status: result.status, reason: result.reason, context: result.context as unknown as Record<string, unknown> }
        } else {
          evaluation = {
            status: 'not_taken', reason: `source node was ${instance.status}`,
            context: { nodeId: instance.node.id, status: instance.status },
          }
        }

        if (classification.kind === 'feedback') {
          const loopId = classification.loopId!
          const prefix = loopPrefix(instance.path, loopId)
          const epoch = loopEpochs.get(`${loopId}\u0000${pathKey(prefix)}`)
          if (!epoch) throw new Error(`loop epoch was not initialized for ${loopId}`)
          const stored = persistEvaluation(edge, instance, evaluation.status, evaluation.reason, evaluation.context, 'pending', loopId)
          if (epoch.feedback) throw new Error(`loop ${loopId} has multiple feedback evaluations in one iteration`)
          epoch.feedback = stored
          continue
        }

        const targetPath = targetPathForEdge(edge, instance.path)
        if (classification.exitLoopIds.length > 0) {
          const stored = persistEvaluation(edge, instance, evaluation.status, evaluation.reason, evaluation.context, 'pending', null)
          heldEvaluations.push({
            evaluationId: stored.id, edge, sourcePath: instance.path, targetPath,
            remainingBarriers: [...classification.exitLoopIds],
          })
        } else {
          const stored = persistEvaluation(edge, instance, evaluation.status, evaluation.reason, evaluation.context, 'delivered', null)
          deliverEvaluation(stored, edge, targetPath)
        }
      }
    }
    const loopIsSettled = (epoch: { loop: CompiledWorkflowLoop; path: WorkflowIterationPath; feedback: WorkflowRunEdgeEvaluationRecord | null }) => {
      if (!epoch.feedback) return false
      return [...instances.values()].filter(instance => (
        epoch.loop.nodeIds.includes(instance.node.id) && samePrefix(instance.path, epoch.path)
      )).every(instance => ['completed', 'failed', 'skipped', 'canceled'].includes(instance.status))
    }
    const releaseBarrier = (epoch: { loop: CompiledWorkflowLoop; path: WorkflowIterationPath }, suppress: boolean) => {
      for (const held of heldEvaluations) {
        if (held.remainingBarriers[0] !== epoch.loop.id || !samePrefix(held.sourcePath, epoch.path)) continue
        if (suppress) {
          held.remainingBarriers.splice(0)
          updateWorkflowEdgeEvaluation(held.evaluationId, { delivery_status: 'suppressed' })
          continue
        }
        held.remainingBarriers.shift()
        if (held.remainingBarriers.length === 0) {
          const stored = listWorkflowRunEdgeEvaluations(run.id).find(item => item.id === held.evaluationId)
          if (!stored) throw new Error(`held edge evaluation ${held.evaluationId} is missing`)
          deliverEvaluation(stored, held.edge, held.targetPath)
        }
      }
    }
    const processSettledLoops = (): boolean => {
      let progress = false
      const candidates = [...loopEpochs.values()]
        .filter(epoch => epoch.record.status === 'running' && loopIsSettled(epoch))
        .sort((left, right) => right.path.length - left.path.length || left.record.sequence - right.record.sequence)
      for (const epoch of candidates) {
        // A deeper loop settled earlier in this pass may have created a fresh
        // child iteration, invalidating a parent candidate collected above.
        if (epoch.record.status !== 'running' || !loopIsSettled(epoch)) continue
        const feedback = epoch.feedback!
        const feedbackEdge = edgeById.get(epoch.loop.feedbackEdgeId)!
        const now = Date.now()
        if (feedback.status === 'error') {
          updateWorkflowEdgeEvaluation(feedback.id, { delivery_status: 'suppressed' })
          releaseBarrier(epoch, true)
          epoch.record = updateWorkflowLoopIteration(epoch.record.id, { status: 'failed', feedback_evaluation_id: feedback.id, finished_at: now, error: feedback.reason }) || epoch.record
          terminalFailure = { code: 'loop_condition_error', message: `Loop ${epoch.loop.id} condition failed: ${feedback.reason}` }
          return true
        }
        if (feedback.status === 'taken') {
          updateWorkflowEdgeEvaluation(feedback.id, { delivery_status: 'delivered' })
          releaseBarrier(epoch, true)
          const currentEntry = epoch.path[epoch.path.length - 1]
          if (currentEntry.iteration >= epoch.loop.maxIterations) {
            epoch.record = updateWorkflowLoopIteration(epoch.record.id, { status: 'failed', feedback_evaluation_id: feedback.id, finished_at: now, error: 'loop limit exceeded' }) || epoch.record
            terminalFailure = {
              code: 'loop_limit_exceeded',
              message: `Loop ${epoch.loop.id} requested another iteration after maxIterations=${epoch.loop.maxIterations}`,
            }
            return true
          }
          epoch.record = updateWorkflowLoopIteration(epoch.record.id, { status: 'retrying', feedback_evaluation_id: feedback.id, finished_at: now, error: null }) || epoch.record
          const nextPath = [
            ...epoch.path.slice(0, -1),
            { loopId: epoch.loop.id, iteration: currentEntry.iteration + 1 },
          ]
          const header = ensureInstance(epoch.loop.headerNodeId, nextPath, 'feedback')
          const source = feedback.source_execution_id ? executionInstanceById.get(feedback.source_execution_id) : undefined
          if (source) feedbackInputByInstance.set(header.key, { edge: feedbackEdge, source })
          if (source?.outcome?.status === 'failure' && source.execution) handledFailureExecutionIds.add(source.execution.execution_id)
          progress = true
          continue
        }
        updateWorkflowEdgeEvaluation(feedback.id, { delivery_status: 'delivered' })
        releaseBarrier(epoch, false)
        epoch.record = updateWorkflowLoopIteration(epoch.record.id, { status: 'completed', feedback_evaluation_id: feedback.id, finished_at: now, error: null }) || epoch.record
        progress = true
      }
      return progress
    }
    const readiness = (instance: WorkflowV2Instance): 'ready' | 'wait' | 'skip' => {
      if (instance.trigger) return 'ready'
      const expected = incoming.get(instance.node.id) || []
      if (expected.length === 0) return 'ready'
      const evaluations = expected.map(edge => instance.incoming.get(edge.id!))
      const joinMode = normalizeWorkflowJoinMode(instance.node.data.orchestration?.joinMode)
      if (joinMode === 'any' && evaluations.some(item => item?.status === 'taken')) return 'ready'
      if (evaluations.some(item => !item)) return 'wait'
      const shouldRun = joinMode === 'all'
        ? evaluations.every(item => item!.status === 'taken')
        : evaluations.some(item => item!.status === 'taken')
      return shouldRun ? 'ready' : 'skip'
    }
    const skipInstance = (instance: WorkflowV2Instance, reason: string) => {
      const evidence = createSkippedWorkflowNodeExecution({
        run_id: run.id, workflow_id: workflow.id, node_id: instance.node.id,
        profile, agent: resolveWorkflowNodeRunTarget(instance.node.data.agent).agent,
        agent_mode: instance.node.data.agent === 'hermes' ? '' : 'scoped',
        iteration_path: instance.path, sequence: executionSequence++, reason,
      })
      instance.execution = evidence
      executionInstanceById.set(evidence.execution_id, instance)
      instance.status = 'skipped'
      persistProjection(instance, reason)
      evaluateSource(instance)
    }
    const dispatchInstance = (instance: WorkflowV2Instance) => {
      if (Date.now() >= deadlineAt) {
        terminalFailure = { code: 'workflow_timeout', message: `Workflow run exceeded total timeout of ${totalTimeoutMs}ms` }
        return
      }
      const sessionId = randomUUID()
      const target = resolveWorkflowNodeRunTarget(instance.node.data.agent)
      const reservation = reserveWorkflowNodeExecution({
        run_id: run.id, workflow_id: workflow.id, node_id: instance.node.id, session_id: sessionId,
        profile, agent: target.agent, agent_mode: instance.node.data.agent === 'hermes' ? '' : 'scoped',
        iteration_path: instance.path, sequence: executionSequence++,
      })
      if (!reservation.ok) {
        terminalFailure = { code: reservation.code, message: `Workflow execution budget ${executionBudget} was exhausted` }
        return
      }
      instance.execution = reservation.execution
      executionInstanceById.set(reservation.execution.execution_id, instance)
      instance.status = 'running'
      updateWorkflowRunNodeExecution(reservation.execution.execution_id, { status: 'running', started_at: Date.now() })
      persistProjection(instance)
      for (const evaluation of instance.incoming.values()) {
        if (evaluation.status !== 'taken') continue
        updateWorkflowEdgeEvaluation(evaluation.id, { consumed_by_execution_id: reservation.execution.execution_id })
        if (evaluation.source_execution_id) {
          const source = executionInstanceById.get(evaluation.source_execution_id)
          if (source?.outcome?.status === 'failure') handledFailureExecutionIds.add(evaluation.source_execution_id)
        }
      }
      running.set(instance.key, (async () => {
        const incomingTaken = (incoming.get(instance.node.id) || [])
          .map(edge => instance.incoming.get(edge.id!))
          .filter((item): item is WorkflowRunEdgeEvaluationRecord => item?.status === 'taken')
        const incomingEdges = incomingTaken.map(item => edgeById.get(item.edge_id)!).filter(Boolean)
        const upstreamOutputs = new Map<string, string>()
        for (const evaluation of incomingTaken) {
          const source = evaluation.source_execution_id ? executionInstanceById.get(evaluation.source_execution_id) : undefined
          if (source) upstreamOutputs.set(source.node.id, source.output)
        }
        const feedbackInput = feedbackInputByInstance.get(instance.key)
        if (feedbackInput) {
          incomingEdges.push(feedbackInput.edge)
          upstreamOutputs.set(feedbackInput.source.node.id, feedbackInput.source.output)
        }
        const assembledInput = await this.buildNodeUserMessage({
          node: instance.node, incomingEdges, nodeById, outputs: upstreamOutputs,
          overrideInput: instance.trigger === 'root' && startNodeIds.includes(instance.node.id) ? input.input : undefined,
          profile,
        })
        const remaining = Math.max(1, deadlineAt - Date.now())
        const nodeTimeout = input.timeoutMs && input.timeoutMs > 0 ? Math.min(input.timeoutMs, remaining) : remaining
        const runResult = await chatRun.runAndWait({
          session_id: sessionId, source: 'workflow', session_source: 'workflow', input: assembledInput,
          profile, workspace: workflow.workspace, model: instance.node.data.model || undefined,
          provider: instance.node.data.provider || undefined, mode: instance.node.data.agent === 'hermes' ? undefined : 'scoped',
          coding_agent_id: target.codingAgentId, agent_id: target.codingAgentId, apiMode: instance.node.data.apiMode || undefined,
          ...(instance.node.data.reasoningEffort ? { reasoning_effort: instance.node.data.reasoningEffort } : {}),
        }, { profile, user: input.user, timeoutMs: nodeTimeout, approvalChoice: 'once' })
        const output = lastAssistantOutput(sessionId, runResult.output)
        const persisted = getWorkflowRun(run.id)
        const canceled = this.canceledRunIds.has(run.id) || persisted?.status === 'canceled'
        const timedOut = persisted?.terminal_code === 'workflow_timeout'
        if (!runResult.ok && /timed out/i.test(String(runResult.error || ''))) {
          await chatRun.abortSession?.(sessionId, runResult.error || 'Node timed out')
        }
        return {
          instance, ok: Boolean(runResult.ok) && !canceled && !timedOut, canceled, output,
          error: (canceled || timedOut)
            ? (persisted?.error || (timedOut ? 'Workflow run timed out' : 'Workflow run canceled'))
            : (runResult.ok ? null : runResult.error || `node ${instance.node.id} failed`),
        }
      })())
    }
    const throwIfTerminalFailure = () => {
      const failure = terminalFailure as { code: string; message: string } | null
      if (failure) throw Object.assign(new Error(failure.message), { code: failure.code })
    }
    const abortRunning = async (reason: string) => {
      await Promise.allSettled([...running.values()].map(async promise => {
        const pending = await Promise.race([
          promise.then(value => ({ value })),
          Promise.resolve({ value: null as any }),
        ])
        void pending
      }))
      const active = listWorkflowRunNodeExecutions(run.id).filter(item => item.session_id && (item.status === 'queued' || item.status === 'running'))
      await Promise.allSettled(active.map(item => chatRun.abortSession?.(item.session_id!, reason)))
    }

    for (const startNodeId of startNodeIds) {
      const path = (compiled.nodeLoopStacks[startNodeId] || []).map(loopId => ({ loopId, iteration: 1 }))
      ensureInstance(startNodeId, path, 'root')
    }

    const deadlineTimer = setTimeout(() => {
      if (getWorkflowRun(run.id)?.status !== 'running') return
      const message = `Workflow run exceeded total timeout of ${totalTimeoutMs}ms`
      updateWorkflowRun(run.id, { status: 'failed', finished_at: Date.now(), error: message, terminal_code: 'workflow_timeout' })
      void Promise.allSettled(listWorkflowRunNodeExecutions(run.id)
        .filter(item => item.session_id && (item.status === 'queued' || item.status === 'running'))
        .map(item => chatRun.abortSession?.(item.session_id!, message)))
    }, totalTimeoutMs)
    this.deadlineTimers.set(run.id, deadlineTimer)

    try {
      while (true) {
        const persistedRun = getWorkflowRun(run.id)
        if (persistedRun?.status === 'canceled') {
          terminalFailure = { code: persistedRun.terminal_code || 'workflow_canceled', message: persistedRun.error || 'Workflow run canceled' }
        } else if (persistedRun?.terminal_code === 'workflow_timeout') {
          terminalFailure = { code: 'workflow_timeout', message: persistedRun.error || 'Workflow run timed out' }
        }
        throwIfTerminalFailure()

        let madeProgress = false
        for (const instance of instances.values()) {
          if (['completed', 'failed', 'skipped', 'canceled'].includes(instance.status) && !propagated.has(instance.key)) {
            evaluateSource(instance)
            madeProgress = true
          }
        }
        while (processSettledLoops()) {
          madeProgress = true
          if (terminalFailure) break
        }
        throwIfTerminalFailure()

        const queued = [...instances.values()]
          .filter(instance => instance.status === 'queued')
          .sort((left, right) => (topoIndex.get(left.node.id)! - topoIndex.get(right.node.id)!) || pathKey(left.path).localeCompare(pathKey(right.path)))
        const ready: WorkflowV2Instance[] = []
        for (const instance of queued) {
          const decision = readiness(instance)
          if (decision === 'ready') ready.push(instance)
          else if (decision === 'skip') {
            skipInstance(instance, `join ${normalizeWorkflowJoinMode(instance.node.data.orchestration?.joinMode)} was not satisfied`)
            madeProgress = true
          }
        }
        for (const instance of ready) {
          dispatchInstance(instance)
          madeProgress = true
          if (terminalFailure) break
        }
        this.setRuntimeStatus(workflow.id, { status: 'running', runId: run.id, nodeStatuses: { ...nodeStatuses } })
        throwIfTerminalFailure()

        if (running.size > 0) {
          const completed = await Promise.race(running.values())
          running.delete(completed.instance.key)
          const terminal = getWorkflowRun(run.id)
          if (completed.canceled || terminal?.status === 'canceled' || terminal?.terminal_code === 'workflow_timeout') {
            const timedOut = terminal?.terminal_code === 'workflow_timeout'
            completed.instance.status = timedOut ? 'failed' : 'canceled'
            updateWorkflowRunNodeExecution(completed.instance.execution!.execution_id, {
              status: timedOut ? 'failed' : 'canceled',
              finished_at: Date.now(),
              error: completed.error || terminal?.error || (timedOut ? 'Workflow run timed out' : 'Workflow run canceled'),
            })
            persistProjection(completed.instance, completed.error || terminal?.error || (timedOut ? 'Workflow run timed out' : 'Workflow run canceled'))
            continue
          }
          completed.instance.output = completed.output
          completed.instance.outcome = {
            nodeId: completed.instance.node.id,
            status: completed.ok ? 'success' : 'failure',
            output: completed.output,
            error: completed.error,
          }
          completed.instance.status = completed.ok ? 'completed' : 'failed'
          updateWorkflowRunNodeExecution(completed.instance.execution!.execution_id, {
            status: completed.ok ? 'completed' : 'failed', finished_at: Date.now(), error: completed.error,
          })
          persistProjection(completed.instance, completed.error || '')
          continue
        }

        const nonterminal = [...instances.values()].filter(instance => !['completed', 'failed', 'skipped', 'canceled'].includes(instance.status))
        const openEpochs = [...loopEpochs.values()].filter(epoch => epoch.record.status === 'running')
        const pendingHeld = heldEvaluations.filter(item => item.remainingBarriers.length > 0)
        if (nonterminal.length === 0 && openEpochs.length === 0 && pendingHeld.length === 0) break
        if (!madeProgress) {
          throw Object.assign(new Error('workflow v2 scheduler reached a blocked fixed point'), { code: 'workflow_blocked' })
        }
      }

      const unhandled = [...instances.values()].filter(instance => (
        instance.outcome?.status === 'failure' && instance.execution && !handledFailureExecutionIds.has(instance.execution.execution_id)
      ))
      if (unhandled.length > 0) {
        const message = unhandled.map(instance => `Node ${instance.node.data.title || instance.node.id} failed: ${instance.outcome?.error}`).join('; ')
        return result(finishRun('failed', message, 'node_failure_unhandled'))
      }
      return result(finishRun('completed', null, null))
    } catch (err: any) {
      const code = String(err?.code || 'workflow_runtime_error')
      const message = err instanceof Error ? err.message : String(err)
      this.canceledRunIds.add(run.id)
      await Promise.allSettled(listWorkflowRunNodeExecutions(run.id)
        .filter(item => item.session_id && (item.status === 'queued' || item.status === 'running'))
        .map(item => chatRun.abortSession?.(item.session_id!, message)))
      await Promise.allSettled(running.values())
      running.clear()
      const canceled = code === 'workflow_canceled' || getWorkflowRun(run.id)?.status === 'canceled'
      for (const instance of instances.values()) {
        if (instance.status !== 'running' || !instance.execution) continue
        instance.status = canceled ? 'canceled' : 'failed'
        updateWorkflowRunNodeExecution(instance.execution.execution_id, {
          status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message,
        })
        persistProjection(instance, message)
      }
      for (const epoch of loopEpochs.values()) {
        if (epoch.record.status !== 'running') continue
        updateWorkflowLoopIteration(epoch.record.id, {
          status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message,
          feedback_evaluation_id: epoch.feedback?.id || null,
        })
      }
      const current = getWorkflowRun(run.id)
      if (canceled) return result(finishRun('canceled', message, current?.terminal_code || 'workflow_canceled'))
      return result(finishRun('failed', message, code))
    } finally {
      const timer = this.deadlineTimers.get(run.id)
      if (timer) clearTimeout(timer)
      this.deadlineTimers.delete(run.id)
      this.canceledRunIds.delete(run.id)
    }
  }

  validateRerunFromNode(workflowId: string, runId: string): { workflow: WorkflowRecord; run: WorkflowRunRecord } {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) {
      const err = new Error('workflow run not found')
      ;(err as any).status = 404
      throw err
    }
    if (run.status === 'queued' || run.status === 'running') {
      const err = new Error('workflow run is still active')
      ;(err as any).status = 409
      throw err
    }
    if (hasNonLegacyWorkflowOrchestration(run.snapshot_nodes, run.snapshot_edges)) {
      const err = new Error('rerun from node is not supported for orchestration v1 runs')
      ;(err as any).status = 409
      throw err
    }
    return { workflow, run }
  }

  async preflightRerunFromNode(
    workflowId: string,
    runId: string,
    nodeId: string,
    input: WorkflowRerunFromNodeInput = {},
  ): Promise<void> {
    const { workflow, run } = this.validateRerunFromNode(workflowId, runId)
    const profile = input.profile?.trim() || run.profile || workflow.profile || 'default'
    const nodes = run.snapshot_nodes.map(normalizeNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const targetNodeId = nodeId.trim()
    if (!targetNodeId || !nodeById.has(targetNodeId)) {
      const err = new Error('workflow node not found in run snapshot'); (err as any).status = 404; throw err
    }
    const outgoing = new Map(nodes.map(node => [node.id, [] as WorkflowEdgeSnapshot[]]))
    for (const edge of run.snapshot_edges.map(normalizeEdge).filter(Boolean) as WorkflowEdgeSnapshot[]) {
      if (nodeById.has(edge.source) && nodeById.has(edge.target)) outgoing.get(edge.source)!.push(edge)
    }
    const starts = input.preserveStartNode ? (outgoing.get(targetNodeId) || []).map(edge => edge.target) : [targetNodeId]
    const activeIds = reachableFrom(starts, outgoing)
    if (activeIds.size === 0) {
      const err = new Error('workflow node has no downstream nodes to rerun'); (err as any).status = 400; throw err
    }
    await this.preflightWorkflowNodes(profile, nodes.filter(node => activeIds.has(node.id)))
  }

  async rerunFromNode(
    workflowId: string,
    runId: string,
    nodeId: string,
    input: WorkflowRerunFromNodeInput = {},
  ): Promise<WorkflowRunNowResult> {
    const { workflow, run } = this.validateRerunFromNode(workflowId, runId)
    await this.preflightRerunFromNode(workflowId, runId, nodeId, input)

    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || run.profile || workflow.profile || 'default'
    const nodes = run.snapshot_nodes.map(normalizeNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const targetNodeId = nodeId.trim()
    if (!targetNodeId || !nodeById.has(targetNodeId)) {
      const err = new Error('workflow node not found in run snapshot')
      ;(err as any).status = 404
      throw err
    }
    const edges = run.snapshot_edges.map(normalizeEdge).filter((edge): edge is WorkflowEdgeSnapshot =>
      Boolean(edge && nodeById.has(edge.source) && nodeById.has(edge.target)),
    )
    if (nodes.length === 0) {
      const err = new Error('workflow run snapshot has no nodes')
      ;(err as any).status = 400
      throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) {
      incoming.set(node.id, [])
      outgoing.set(node.id, [])
    }
    for (const edge of edges) {
      incoming.get(edge.target)!.push(edge)
      outgoing.get(edge.source)!.push(edge)
    }

    const existingNodeSessions = listWorkflowRunNodeSessions(run.id)
    const existingSessionByNode = new Map(existingNodeSessions.map(session => [session.node_id, session]))
    const preserveStartNode = Boolean(input.preserveStartNode)
    if (preserveStartNode) {
      const startSession = existingSessionByNode.get(targetNodeId)
      if (!startSession || startSession.status !== 'completed') {
        const err = new Error('workflow node has no completed output to preserve')
        ;(err as any).status = 409
        throw err
      }
    }
    const downstreamStartIds = (outgoing.get(targetNodeId) || []).map(edge => edge.target)
    const activeIds = preserveStartNode
      ? reachableFrom(downstreamStartIds, outgoing)
      : reachableFrom([targetNodeId], outgoing)
    if (activeIds.size === 0) {
      const err = new Error('workflow node has no downstream nodes to rerun')
      ;(err as any).status = 400
      throw err
    }
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const outputs = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    for (const session of existingNodeSessions) {
      if (activeIds.has(session.node_id)) continue
      nodeStatuses[session.node_id] = session.status === 'blocked' ? 'failed' : session.status
      if (session.status === 'completed') {
        outputs.set(session.node_id, lastAssistantOutput(session.session_id))
      }
    }

    for (const node of activeNodes) {
      for (const edge of incoming.get(node.id) || []) {
        if (activeIds.has(edge.source)) continue
        const upstreamSession = existingSessionByNode.get(edge.source)
        if (!upstreamSession || upstreamSession.status !== 'completed') {
          const upstream = nodeById.get(edge.source)
          const err = new Error(`Upstream node ${upstream?.data.title || edge.source} has no completed output`)
          ;(err as any).status = 409
          throw err
        }
      }
    }

    for (const session of existingNodeSessions.filter(item => activeIds.has(item.node_id))) {
      await this.deleteNodeSessionArtifacts(session.session_id, session.profile, session.agent)
    }
    deleteWorkflowRunNodeSessions(run.id, [...activeIds])

    const startedAt = Date.now()
    const updatedRun = updateWorkflowRun(run.id, {
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      error: null,
    }) || run
    this.canceledRunIds.delete(run.id)
    for (const node of activeNodes) nodeStatuses[node.id] = 'queued'
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: { ...nodeStatuses },
    })

    const completed = new Set<string>()
    const runningOrDone = new Set<string>()
    const nodeSessionRecordIds = new Map<string, string>()
    let sequence = existingNodeSessions
      .filter(session => !activeIds.has(session.node_id))
      .reduce((max, session) => Math.max(max, session.sequence), -1) + 1

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
        }
        const canceled = updateWorkflowRun(run.id, { status: 'canceled', finished_at: finishedAt, error: message }) || updatedRun
        this.setRuntimeStatus(workflow.id, {
          status: 'canceled',
          runId: run.id,
          completedAt: finishedAt,
          error: message,
          nodeStatuses: { ...nodeStatuses },
        })
        return canceled
      }
      const finishedAt = Date.now()
      const failed = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || updatedRun
      this.setRuntimeStatus(workflow.id, {
        status: 'failed',
        runId: run.id,
        completedAt: finishedAt,
        error: message,
        nodeStatuses: { ...nodeStatuses },
      })
      return failed
    }

    try {
      while (completed.size < activeNodes.length) {
        const ready = activeNodes.filter(node => {
          if (runningOrDone.has(node.id)) return false
          return (incoming.get(node.id) || []).every(edge => (
            activeIds.has(edge.source) ? completed.has(edge.source) : outputs.has(edge.source)
          ))
        })
        if (ready.length === 0) {
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        for (const node of ready) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflow.id, {
          status: 'running',
          runId: run.id,
          nodeStatuses: { ...nodeStatuses },
        })

        const results = await Promise.all(ready.map(async node => {
          const nodeSessionId = randomUUID()
          runningOrDone.add(node.id)
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id,
            workflow_id: workflow.id,
            node_id: node.id,
            session_id: nodeSessionId,
            profile,
            agent: target.agent,
            agent_mode: node.data.agent === 'hermes' ? '' : 'scoped',
            status: 'running',
            sequence: sequence++,
            started_at: Date.now(),
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const assembledInput = await this.buildNodeUserMessage({
            node,
            incomingEdges: incoming.get(node.id) || [],
            nodeById,
            outputs,
            profile,
          })
          const runResult = await chatRun.runAndWait({
            session_id: nodeSessionId,
            source: 'workflow',
            session_source: 'workflow',
            input: assembledInput,
            profile,
            workspace: run.workspace,
            model: node.data.model || undefined,
            provider: node.data.provider || undefined,
            mode: node.data.agent === 'hermes' ? undefined : 'scoped',
            coding_agent_id: target.codingAgentId,
            agent_id: target.codingAgentId,
            apiMode: node.data.apiMode || undefined,
            ...(node.data.reasoningEffort ? { reasoning_effort: node.data.reasoningEffort } : {}),
          }, {
            profile,
            user: input.user,
            timeoutMs: input.timeoutMs,
            approvalChoice: 'once',
          })
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'canceled', finished_at: Date.now(), error })
              nodeStatuses[node.id] = 'canceled'
              this.setRuntimeStatus(workflow.id, {
                status: 'canceled',
                runId: run.id,
                error,
                nodeStatuses: { ...nodeStatuses },
              })
              return { node, ok: false, canceled: true, error }
            }
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, error }
          }
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          outputs.set(node.id, output)
          completed.add(node.id)
          nodeStatuses[node.id] = 'completed'
          this.setRuntimeStatus(workflow.id, {
            status: 'running',
            runId: run.id,
            nodeStatuses: { ...nodeStatuses },
          })
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
          return { node, ok: true }
        }))

        const failed = results.find(result => !result.ok)
        if (failed) {
          for (const node of activeNodes) {
            if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id), edgeResults: listWorkflowRunEdgeResults(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id), edgeResults: listWorkflowRunEdgeResults(run.id) }
        }
      }

      const finishedAt = Date.now()
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || updatedRun
      this.setRuntimeStatus(workflow.id, {
        status: 'completed',
        runId: run.id,
        completedAt: finishedAt,
        error: null,
        nodeStatuses: { ...nodeStatuses },
      })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id), edgeResults: listWorkflowRunEdgeResults(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [rerunNodeId, recordId] of nodeSessionRecordIds) {
        if (!completed.has(rerunNodeId)) {
          nodeStatuses[rerunNodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) {
        if (nodeStatuses[node.id] === 'queued' || nodeStatuses[node.id] === 'running') nodeStatuses[node.id] = 'canceled'
      }
      const failedRun = failRun(message)
      return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id), edgeResults: listWorkflowRunEdgeResults(run.id) }
    }
  }

  private async buildNodeUserMessage(args: {
    node: WorkflowNodeSnapshot
    incomingEdges: WorkflowEdgeSnapshot[]
    nodeById: Map<string, WorkflowNodeSnapshot>
    outputs: Map<string, string>
    overrideInput?: string | null
    profile: string
  }): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    if (args.incomingEdges.length > 0) {
      parts.push('[Workflow upstream results]')
      for (const edge of args.incomingEdges) {
        const upstream = args.nodeById.get(edge.source)
        parts.push(`\n[Upstream: ${upstream?.data.title || edge.source}]\n${args.outputs.get(edge.source) || ''}`)
      }
    }

    if (args.node.data.skills.length > 0) {
      parts.push('\n[Workflow selected skills]')
      for (const skillName of args.node.data.skills) {
        const skill = await resolveWorkflowSkillContent({
          agent: args.node.data.agent,
          profile: args.profile,
          skillName,
        })
        if (!skill) throw new Error(`Skill "${skillName}" not found for ${args.node.data.agent || 'hermes'}`)
        parts.push(`\n[Skill: ${skill.name}]\n${skill.content}`)
      }
    }

    const currentTask = args.overrideInput ?? args.node.data.input
    parts.push(`\n[Current task]\n${currentTask || 'Execute the current workflow node.'}`)
    const text = parts.join('\n').trim()
    if (args.node.data.images.length === 0) return text
    return [
      { type: 'text', text },
      ...args.node.data.images.map(path => ({
        type: 'image' as const,
        name: path.split(/[\\/]/).pop() || path,
        path,
        media_type: imageMediaType(path),
      })),
    ]
  }
}

let singleton: WorkflowManager | null = null

export function getWorkflowManager(): WorkflowManager {
  if (!singleton) singleton = new WorkflowManager()
  return singleton
}
