import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
  runAndWait: vi.fn(),
  abortSession: vi.fn(),
  chatRunAvailable: true,
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
  getStoragePath: () => ':memory:',
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))
vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => state.chatRunAvailable
    ? { runAndWait: state.runAndWait, abortSession: state.abortSession }
    : undefined,
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({ getExactSessionDetailFromDbWithProfile: vi.fn() }))
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  deleteSession: vi.fn(), getSession: vi.fn(), getSessionDetail: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ deleteUsage: vi.fn() }))
vi.mock('../../packages/server/src/services/workflow-skill-resolver', () => ({ resolveWorkflowSkillContent: vi.fn() }))
vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({ codingAgentRunManager: { stop: vi.fn() } }))
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({ deleteSessionForProfile: vi.fn() }))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({ listProfileNamesFromDisk: vi.fn(() => []) }))
vi.mock('../../packages/server/src/services/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../packages/server/src/controllers/hermes/models', () => ({
  getAvailableModelReferencesForProfile: vi.fn(async () => [
    { provider: 'custom:test', model: 'gpt-test', apiMode: 'chat_completions' },
  ]),
  getEffectiveModelReferenceForProfile: vi.fn(async () => (
    { provider: 'custom:test', model: 'gpt-test', apiMode: 'chat_completions' }
  )),
}))

function node(id: string, input = id, joinMode?: 'all' | 'any') {
  return { id, type: 'agent', data: { title: id, agent: 'hermes', input, orchestration: joinMode ? { joinMode } : undefined } }
}
function edge(id: string, source: string, target: string, orchestration?: Record<string, unknown>) {
  return { id, source, target, data: orchestration ? { orchestration } : undefined }
}

describe('workflow manager orchestration', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    state.runAndWait.mockReset()
    state.abortSession.mockReset()
    state.chatRunAvailable = true
    root = mkdtempSync(join(tmpdir(), 'workflow-manager-orchestration-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    state.db?.close(); state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('stores canonical synthesized edge ids in run snapshots and readback', async () => {
    state.runAndWait.mockResolvedValue({ ok: true, output: 'ok' })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { getWorkflowRun, listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'legacy edge', nodes: [node('a'), node('b')], edges: [{ source: 'a', target: 'b', data: { note: 'keep' } }] })
    const result = await new WorkflowManager().runNow(workflow.id)
    const id = (result.run.snapshot_edges[0] as any).id
    expect(id).toBe(result.edgeResults[0].edge_id)
    expect((result.run.snapshot_edges[0] as any).data).toEqual({ note: 'keep' })
    expect((getWorkflowRun(result.run.id)!.snapshot_edges[0] as any).id).toBe(id)
    expect((listWorkflowRuns(workflow.id)[0].snapshot_edges[0] as any).id).toBe(id)
  })

  it('drains canceled fanout and prevents late completed writes', async () => {
    const gates: Array<(value: any) => void> = []
    state.runAndWait.mockImplementation(() => new Promise(resolve => gates.push(resolve)))
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunNodeSessions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'cancel fanout', nodes: [node('left'), node('right')], edges: [] })
    const manager = new WorkflowManager(); const promise = manager.runNow(workflow.id)
    while (gates.length < 2) await new Promise(resolve => setTimeout(resolve, 5))
    const runId = manager.getRuntimeStatus(workflow.id).runId!
    await manager.stopRun(workflow.id, runId)
    let settled = false; promise.finally(() => { settled = true })
    gates[0]({ ok: false, error: 'aborted' }); await new Promise(resolve => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    gates[1]({ ok: true, output: 'late ok' })
    const result = await promise
    expect(result.run.status).toBe('canceled')
    expect(result.nodeSessions.map(item => item.status)).toEqual(['canceled', 'canceled'])
    expect(state.abortSession).toHaveBeenCalledTimes(2)
    expect(listWorkflowRunNodeSessions(runId).every(item => item.status === 'canceled')).toBe(true)
  })

  it('rejects any unknown explicit start node ids before persisting a run or calling chat', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'explicit starts', nodes: [node('root'), node('child')], edges: [edge('rc', 'root', 'child')] })
    const manager = new WorkflowManager()

    expect(() => manager.prepareRun(workflow.id, ['root', 'missing-a', 'missing-b'])).toThrowError(expect.objectContaining({
      status: 400,
      message: expect.stringContaining('missing-a, missing-b'),
    }))
    await expect(manager.runNow(workflow.id, { startNodeIds: ['missing-a'] })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('missing-a'),
    })
    expect(listWorkflowRuns(workflow.id)).toEqual([])
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

  it('rejects malformed graphs before persisting a run or calling chat', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'invalid', nodes: [node('a'), node('a')], edges: [] })
    await expect(new WorkflowManager().runNow(workflow.id)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('duplicate node id') })
    expect(listWorkflowRuns(workflow.id)).toEqual([])
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

  it('takes a matching branch and persists a real skipped node without calling chat', async () => {
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      if (task.includes('[Current task]\ndecide')) return { ok: true, output: '```json\n{"approved":true}\n```' }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'branch', nodes: [node('decide'), node('publish'), node('reject')],
      edges: [
        edge('approved', 'decide', 'publish', { route: 'success', condition: { path: 'json.approved', operator: 'equals', value: true } }),
        edge('rejected', 'decide', 'reject', { route: 'success', condition: { path: 'json.approved', operator: 'equals', value: false } }),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(state.runAndWait).toHaveBeenCalledTimes(2)
    expect(result.nodeSessions.find(item => item.node_id === 'reject')).toBeUndefined()
    expect(result.run.node_states.reject).toMatchObject({ status: 'skipped', reason: 'join all was not satisfied' })
    expect(result.edgeResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge_id: 'approved', status: 'taken' }),
      expect.objectContaining({ edge_id: 'rejected', status: 'not_taken' }),
    ]))
  })

  it('fans out ready nodes concurrently and joins after all taken inputs complete', async () => {
    let active = 0
    let maxActive = 0
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      if (task.includes('[Current task]\nleft') || task.includes('[Current task]\nright')) {
        active += 1; maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active -= 1
      }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'fanout', nodes: [node('start'), node('left'), node('right'), node('join')],
      edges: [edge('sl', 'start', 'left'), edge('sr', 'start', 'right'), edge('lj', 'left', 'join'), edge('rj', 'right', 'join')],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(maxActive).toBe(2)
    expect(result.nodeSessions.map(item => item.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('starts an any join as soon as fast finishes without waiting for slow', async () => {
    const events: string[] = []
    let releaseSlow!: () => void
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      const current = ['start', 'fast', 'slow', 'join'].find(id => task.includes(`[Current task]\n${id}`))!
      events.push(`${current}:start`)
      if (current === 'slow') await slowGate
      events.push(`${current}:finish`)
      if (current === 'join') releaseSlow()
      return { ok: true, output: current }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'any timing', nodes: [node('start'), node('fast'), node('slow'), node('join', 'join', 'any')], edges: [
      edge('sf', 'start', 'fast'), edge('ss', 'start', 'slow'), edge('fj', 'fast', 'join'), edge('sj', 'slow', 'join'),
    ] })
    const timeout = new Promise<never>((_, reject) => setTimeout(() => { releaseSlow(); reject(new Error('join did not start before slow completed')) }, 200))
    await Promise.race([new WorkflowManager().runNow(workflow.id), timeout])
    expect(events.indexOf('join:start')).toBeGreaterThan(events.indexOf('fast:finish'))
    expect(events.indexOf('join:start')).toBeLessThan(events.indexOf('slow:finish'))
  })

  it('runs an any join when the first branch is taken and ignores the untaken branch input', async () => {
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      if (task.includes('[Current task]\ndecide')) return { ok: true, output: '{"fast":true}' }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'any', nodes: [node('decide'), node('fallback'), node('join', 'join', 'any')],
      edges: [
        edge('direct', 'decide', 'join', { route: 'success', condition: { path: 'json.fast', operator: 'truthy' } }),
        edge('fallback-route', 'decide', 'fallback', { route: 'success', condition: { path: 'json.fast', operator: 'equals', value: false } }),
        edge('fallback-join', 'fallback', 'join'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(state.runAndWait).toHaveBeenCalledTimes(2)
    expect(result.nodeSessions.find(item => item.node_id === 'fallback')).toBeUndefined()
    expect(result.run.node_states.fallback.status).toBe('skipped')
    expect(result.nodeSessions.find(item => item.node_id === 'join')?.status).toBe('completed')
  })

  it('does not handle a late failure through an any-join that already ran from another edge', async () => {
    let releaseDelayed!: () => void
    const delayedGate = new Promise<void>(resolve => { releaseDelayed = resolve })
    const recoveryInputs: string[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      if (task.includes('[Current task]\ndelayed')) {
        await delayedGate
        return { ok: false, error: 'delayed failed', output: 'delayed output' }
      }
      if (task.includes('[Current task]\nrecovery')) {
        recoveryInputs.push(task)
        releaseDelayed()
        return { ok: true, output: 'recovered fast' }
      }
      return { ok: true, output: task.includes('[Current task]\nfast') ? 'fast output' : task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'late failure any join', nodes: [node('start'), node('fast'), node('delayed'), node('recovery', 'recovery', 'any')],
      edges: [
        edge('start-fast', 'start', 'fast'), edge('start-delayed', 'start', 'delayed'),
        edge('fast-recovery', 'fast', 'recovery'),
        edge('failure-recovery', 'delayed', 'recovery', { route: 'failure' }),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.edgeResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge_id: 'failure-recovery', status: 'taken' }),
    ]))
    expect(result.nodeSessions.filter(item => item.node_id === 'recovery')).toHaveLength(1)
    expect(recoveryInputs).toHaveLength(1)
    expect(recoveryInputs[0]).toContain('fast output')
    expect(recoveryInputs[0]).not.toContain('delayed output')
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('Node delayed failed: delayed failed') })
  })

  it('does not treat a taken failure route as handled when its all-join target is skipped', async () => {
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      if (task.includes('[Current task]\nbuild')) return { ok: false, error: 'compile failed', output: 'partial log' }
      if (task.includes('[Current task]\ngate')) return { ok: true, output: '{"recover":false}' }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'skipped recovery', nodes: [node('build'), node('gate'), node('recovery')],
      edges: [
        edge('failure-to-recovery', 'build', 'recovery', { route: 'failure' }),
        edge('gate-to-recovery', 'gate', 'recovery', { route: 'success', condition: { path: 'json.recover', operator: 'truthy' } }),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.edgeResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge_id: 'failure-to-recovery', status: 'taken' }),
      expect.objectContaining({ edge_id: 'gate-to-recovery', status: 'not_taken' }),
    ]))
    expect(result.nodeSessions.find(item => item.node_id === 'recovery')).toBeUndefined()
    expect(result.run.node_states.recovery.status).toBe('skipped')
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('Node build failed: compile failed') })
  })

  it('continues through failure and always routes and completes when the failure is handled', async () => {
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = typeof request.input === 'string' ? request.input : request.input[0].text
      if (task.includes('[Current task]\nbuild')) return { ok: false, error: 'compile failed', output: 'partial log' }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'recover', nodes: [node('build'), node('recover'), node('notify')],
      edges: [edge('failure', 'build', 'recover', { route: 'failure' }), edge('always', 'build', 'notify', { route: 'always' })],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(result.nodeSessions.find(item => item.node_id === 'build')?.status).toBe('failed')
    expect(result.nodeSessions.find(item => item.node_id === 'recover')?.status).toBe('completed')
    expect(result.nodeSessions.find(item => item.node_id === 'notify')?.status).toBe('completed')
  })

  it('fails the run when a node failure has no taken failure or always route', async () => {
    state.runAndWait.mockResolvedValue({ ok: false, error: 'boom' })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'unhandled', nodes: [node('only')], edges: [] })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run).toMatchObject({ status: 'failed', error: 'Node only failed: boom' })
  })

  it('fails conditions closed and skips their target without executing it', async () => {
    state.runAndWait.mockResolvedValue({ ok: true, output: 'not valid json' })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'invalid JSON condition', nodes: [node('start'), node('unsafe')],
      edges: [edge('bad', 'start', 'unsafe', { route: 'success', condition: { path: 'json.approved', operator: 'truthy' } })],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(state.runAndWait).toHaveBeenCalledTimes(1)
    expect(result.edgeResults[0]).toMatchObject({ status: 'error' })
    expect(result.nodeSessions.find(item => item.node_id === 'unsafe')).toBeUndefined()
    expect(result.run.node_states.unsafe.status).toBe('skipped')
  })


  it('rejects rerun preflight when the chat-run backend is unavailable', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const nodes = [node('start')]
    const workflow = createWorkflow({ name: 'missing chat backend', nodes, edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: nodes, snapshot_edges: [] })
    state.chatRunAvailable = false

    await expect(new WorkflowManager().preflightRerunFromNode(workflow.id, run.id, 'start')).rejects.toMatchObject({
      message: 'chat-run server is not available',
      status: 503,
    })
    expect(getWorkflowRun(run.id)?.status).toBe('completed')
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

  it('rejects rerun preflight when the preserved start node has no completed evidence', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const nodes = [node('start'), node('next')]
    const edges = [edge('start-next', 'start', 'next')]
    const workflow = createWorkflow({ name: 'missing preserved evidence', nodes, edges })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: nodes, snapshot_edges: edges })

    await expect(new WorkflowManager().preflightRerunFromNode(workflow.id, run.id, 'start', {
      preserveStartNode: true,
    })).rejects.toMatchObject({
      message: 'workflow node has no completed output to preserve',
      status: 409,
    })
    expect(getWorkflowRun(run.id)?.status).toBe('completed')
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

  it('rejects rerun preflight when an upstream dependency has no completed evidence', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const nodes = [node('upstream'), node('target')]
    const edges = [edge('upstream-target', 'upstream', 'target')]
    const workflow = createWorkflow({ name: 'missing upstream evidence', nodes, edges })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: nodes, snapshot_edges: edges })

    await expect(new WorkflowManager().preflightRerunFromNode(workflow.id, run.id, 'target')).rejects.toMatchObject({
      message: 'Upstream node upstream has no completed output',
      status: 409,
    })
    expect(getWorkflowRun(run.id)?.status).toBe('completed')
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

  it('reruns snapshots with explicit legacy success/all defaults', async () => {
    state.runAndWait.mockResolvedValue({ ok: true, output: 'rerun output' })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const nodes = [node('start'), node('next')].map(item => ({ ...item, data: { ...item.data, orchestration: { joinMode: 'all' } } }))
    const edges = [edge('legacy-default', 'start', 'next', { route: 'success' })]
    const workflow = createWorkflow({ name: 'legacy defaults rerun', nodes, edges })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: nodes, snapshot_edges: edges })

    const result = await new WorkflowManager().rerunFromNode(workflow.id, run.id, 'start')

    expect(result.run.status).toBe('completed')
    expect(result.nodeSessions.map(item => item.node_id)).toEqual(['start', 'next'])
    expect(result.nodeSessions.every(item => item.status === 'completed')).toBe(true)
    expect(state.runAndWait).toHaveBeenCalledTimes(2)
  })

  it('dispatches legacy rerun snapshots with the resolved profile default target', async () => {
    state.runAndWait.mockResolvedValue({ ok: true, output: 'ok' })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const nodes = [node('start')]
    const workflow = createWorkflow({ name: 'inherited rerun target', nodes, edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: nodes, snapshot_edges: [] })

    const result = await new WorkflowManager().rerunFromNode(workflow.id, run.id, 'start')

    expect(result.run.status).toBe('completed')
    expect(state.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom:test', model: 'gpt-test', apiMode: 'chat_completions',
    }), expect.anything())
  })

  it('rejects rerun-from-node for orchestration v1 snapshots without mutating the run', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const nodes = [node('start'), node('next')]
    const edges = [edge('conditional', 'start', 'next', { route: 'success', condition: { path: 'json.go', operator: 'truthy' } })]
    const workflow = createWorkflow({ name: 'rerun limit', nodes, edges })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: nodes, snapshot_edges: edges })

    await expect(new WorkflowManager().rerunFromNode(workflow.id, run.id, 'next')).rejects.toMatchObject({
      message: 'rerun from node is not supported for orchestration v1 runs', status: 409,
    })
    expect(getWorkflowRun(run.id)?.status).toBe('completed')
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

})
