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
  createWorkflowRun,
  createWorkflowRunEdgeResult,
  createWorkflowRunNodeSession,
  deleteWorkflowRun,
  deleteWorkflowRunNodeSessions,
  getWorkflowRun,
  listWorkflowRunEdgeResults,
  listWorkflowRunNodeSessions,
  listWorkflowRuns,
  updateWorkflowRun,
  updateWorkflowRunNodeState,
  updateWorkflowRunNodeSession,
  type WorkflowRunEdgeResultRecord,
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
import { compileWorkflowGraph, evaluateWorkflowEdge, hasNonLegacyWorkflowOrchestration, normalizeWorkflowEdgeOrchestration, normalizeWorkflowJoinMode } from './workflow-orchestration'

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
  return {
    id,
    type: typeof record.type === 'string' && record.type ? record.type : 'agent',
    data: {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id,
      agent: typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : 'hermes',
      provider: typeof data.provider === 'string' ? data.provider.trim() : '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
      apiMode: typeof data.apiMode === 'string' ? data.apiMode.trim() : '',
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

export class WorkflowManager extends EventEmitter<WorkflowManagerEvents> {
  private readonly runtimeStatuses = new Map<string, WorkflowRuntimeStatus>()
  private readonly canceledRunIds = new Set<string>()

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
    const runs = listWorkflowRuns(id, 500)
    for (const run of runs) {
      await this.deleteRun(id, run.id)
    }
    const deleted = deleteWorkflow(id)
    if (deleted) this.runtimeStatuses.delete(id)
    return deleted
  }

  async stopRun(workflowId: string, runId: string, reason = 'Workflow run canceled'): Promise<WorkflowRunRecord | null> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return null
    this.canceledRunIds.add(runId)
    const finishedAt = Date.now()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
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
      if (session.status === 'queued' || session.status === 'running') {
        await getChatRunServer()?.abortSession?.(session.session_id, reason)
      }
    }
    const stopped = updateWorkflowRun(runId, {
      status: 'canceled',
      finished_at: finishedAt,
      error: reason,
    }) || run
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
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const nodeSession of nodeSessions) {
      await this.deleteNodeSessionArtifacts(nodeSession.session_id, nodeSession.profile, nodeSession.agent)
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
      const incomingNodeIds = new Set(compiled.edges.map(edge => edge.target))
      const startNodeIds = explicitStartNodeIds || compiled.nodes.filter(node => !incomingNodeIds.has(node.id)).map(node => node.id)
      if (startNodeIds.length === 0) throw new Error('workflow has no start nodes')
      return { workflow, compiled, startNodeIds }
    } catch (cause) {
      const err = new Error(cause instanceof Error ? cause.message : String(cause)); (err as any).status = 400; throw err
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

  async rerunFromNode(
    workflowId: string,
    runId: string,
    nodeId: string,
    input: WorkflowRerunFromNodeInput = {},
  ): Promise<WorkflowRunNowResult> {
    const { workflow, run } = this.validateRerunFromNode(workflowId, runId)

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
