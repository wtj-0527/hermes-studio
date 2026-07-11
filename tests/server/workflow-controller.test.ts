import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  get: vi.fn(),
  deleteRun: vi.fn(),
  rerunFromNode: vi.fn(),
  validateRerunFromNode: vi.fn(),
  runNow: vi.fn(),
  prepareRun: vi.fn(),
  runPrepared: vi.fn(),
  stopRun: vi.fn(),
}))
const getWorkflowRunMock = vi.hoisted(() => vi.fn())
const listWorkflowRunsMock = vi.hoisted(() => vi.fn())
const listWorkflowRunNodeSessionsMock = vi.hoisted(() => vi.fn())
const listUserProfilesMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/workflow-manager', () => ({
  getWorkflowManager: () => managerMock,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: listUserProfilesMock,
}))

vi.mock('../../packages/server/src/db/hermes/workflow-run-store', () => ({
  getWorkflowRun: getWorkflowRunMock,
  listWorkflowRunNodeSessions: listWorkflowRunNodeSessionsMock,
  listWorkflowRuns: listWorkflowRunsMock,
}))

function ctx(overrides: Record<string, any> = {}) {
  return {
    params: {},
    query: {},
    request: { body: {} },
    state: {},
    status: 200,
    body: undefined,
    ...overrides,
  } as any
}

describe('workflow controller', () => {
  beforeEach(() => {
    managerMock.get.mockReset()
    managerMock.deleteRun.mockReset()
    managerMock.rerunFromNode.mockReset()
    managerMock.validateRerunFromNode.mockReset()
    managerMock.runNow.mockReset()
    managerMock.prepareRun.mockReset()
    managerMock.prepareRun.mockReturnValue({ workflow: { id: 'workflow-1' }, compiled: {} })
    managerMock.runPrepared.mockReset()
    managerMock.stopRun.mockReset()
    getWorkflowRunMock.mockReset()
    listWorkflowRunNodeSessionsMock.mockReset()
    listWorkflowRunsMock.mockReset()
    listUserProfilesMock.mockReset()
    listUserProfilesMock.mockReturnValue([])
  })

  it('gets run detail with node sessions and edge results', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    getWorkflowRunMock.mockReturnValue({
      id: 'run-1', workflow_id: 'workflow-1', status: 'completed',
      edge_results: [{ edge_id: 'e1', status: 'taken' }],
    })
    listWorkflowRunNodeSessionsMock.mockReturnValue([{ node_id: 'node-1', status: 'completed' }])

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })
    await mod.getRun(c)

    expect(c.body).toEqual({ run: {
      id: 'run-1', workflow_id: 'workflow-1', status: 'completed',
      edge_results: [{ edge_id: 'e1', status: 'taken' }],
      node_sessions: [{ node_id: 'node-1', status: 'completed' }],
    } })
  })

  it('lists run records for a workflow', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    listWorkflowRunsMock.mockReturnValue([{ id: 'run-1', workflow_id: 'workflow-1', status: 'completed', edge_results: [{ edge_id: 'e1', status: 'taken' }] }])
    listWorkflowRunNodeSessionsMock.mockReturnValue([{ id: 'node-session-1', node_id: 'node-1', status: 'completed' }])

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1' }, query: { limit: '25' } })

    await mod.listRuns(c)

    expect(listWorkflowRunsMock).toHaveBeenCalledWith('workflow-1', 25)
    expect(listWorkflowRunNodeSessionsMock).toHaveBeenCalledWith('run-1')
    expect(c.body).toEqual({
      runs: [{
        id: 'run-1',
        workflow_id: 'workflow-1',
        status: 'completed',
        edge_results: [{ edge_id: 'e1', status: 'taken' }],
        node_sessions: [{ id: 'node-session-1', node_id: 'node-1', status: 'completed' }],
      }],
    })
  })

  it('runs a workflow through the workflow manager', async () => {
    const user = { id: 'user-1', role: 'super_admin' }
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.runPrepared.mockResolvedValue({ run: { id: 'run-1', status: 'completed' }, nodeSessions: [] })

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({
      params: { id: 'workflow-1' },
      request: { body: { start_node_ids: ['node-1', 12, 'node-2'], input: 'go', timeout_ms: '1000' } },
      state: { user },
    })

    await mod.runNow(c)

    expect(managerMock.prepareRun).toHaveBeenCalledWith('workflow-1', ['node-1', 'node-2'])
    expect(managerMock.runPrepared).toHaveBeenCalledWith({ workflow: { id: 'workflow-1' }, compiled: {} }, {
      profile: 'default',
      user,
      startNodeIds: ['node-1', 'node-2'],
      input: 'go',
      timeoutMs: 1000,
    })
    expect(c.status).toBe(202)
    expect(c.body).toEqual({ ok: true, status: 'accepted' })
  })

  it('returns 400 synchronously for unknown explicit start node ids', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.prepareRun.mockImplementation(() => { const error: any = new Error('unknown start node ids: missing'); error.status = 400; throw error })
    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1' }, request: { body: { start_node_ids: ['missing'] } } })
    await mod.runNow(c)
    expect(managerMock.prepareRun).toHaveBeenCalledWith('workflow-1', ['missing'])
    expect(c.status).toBe(400)
    expect(c.body).toEqual({ error: 'unknown start node ids: missing' })
    expect(managerMock.runPrepared).not.toHaveBeenCalled()
  })

  it('returns 400 synchronously for a malformed graph without starting a run', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.prepareRun.mockImplementation(() => { const error: any = new Error('workflow graph contains a cycle'); error.status = 400; throw error })
    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1' }, request: { body: {} } })
    await mod.runNow(c)
    expect(c.status).toBe(400)
    expect(c.body).toEqual({ error: 'workflow graph contains a cycle' })
    expect(managerMock.runPrepared).not.toHaveBeenCalled()
  })

  it('stops a workflow run through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.stopRun.mockResolvedValue({ id: 'run-1', workflow_id: 'workflow-1', status: 'canceled' })

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })

    await mod.stopRun(c)

    expect(managerMock.stopRun).toHaveBeenCalledWith('workflow-1', 'run-1', 'Workflow run canceled by user')
    expect(c.body).toEqual({
      ok: true,
      run: { id: 'run-1', workflow_id: 'workflow-1', status: 'canceled' },
    })
  })

  it('reruns a workflow run from a node through the workflow manager', async () => {
    const user = { id: 'user-1', role: 'super_admin' }
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.rerunFromNode.mockResolvedValue({ run: { id: 'run-1', status: 'completed' }, nodeSessions: [] })

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({
      params: { id: 'workflow-1', runId: 'run-1' },
      request: { body: { node_id: 'node-2', preserve_start_node: true, timeout_ms: '1000' } },
      state: { user },
    })

    await mod.rerunFromNode(c)

    expect(managerMock.validateRerunFromNode).toHaveBeenCalledWith('workflow-1', 'run-1')
    expect(managerMock.rerunFromNode).toHaveBeenCalledWith('workflow-1', 'run-1', 'node-2', {
      profile: 'default',
      user,
      preserveStartNode: true,
      timeoutMs: 1000,
    })
    expect(c.status).toBe(202)
    expect(c.body).toEqual({ ok: true, status: 'accepted' })
  })

  it('returns orchestration v1 rerun rejection synchronously instead of accepting a no-op', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.validateRerunFromNode.mockImplementation(() => {
      const error: any = new Error('rerun from node is not supported for orchestration v1 runs')
      error.status = 409
      throw error
    })

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({
      params: { id: 'workflow-1', runId: 'run-1' },
      request: { body: { node_id: 'node-2', preserve_start_node: true } },
    })

    await mod.rerunFromNode(c)

    expect(managerMock.validateRerunFromNode).toHaveBeenCalledWith('workflow-1', 'run-1')
    expect(managerMock.rerunFromNode).not.toHaveBeenCalled()
    expect(c.status).toBe(409)
    expect(c.body).toEqual({ error: 'rerun from node is not supported for orchestration v1 runs' })
  })

  it('deletes a workflow run through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default' })
    managerMock.deleteRun.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })

    await mod.deleteRun(c)

    expect(managerMock.deleteRun).toHaveBeenCalledWith('workflow-1', 'run-1')
    expect(c.body).toEqual({ ok: true })
  })

  it('rejects workflow runs for unavailable profiles', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'secret' })
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }])

    const mod = await import('../../packages/server/src/controllers/hermes/workflows')
    const c = ctx({
      params: { id: 'workflow-1' },
      state: { user: { id: 'user-1', role: 'user' } },
    })

    await mod.runNow(c)

    expect(c.status).toBe(403)
    expect(managerMock.runPrepared).not.toHaveBeenCalled()
  })
})
