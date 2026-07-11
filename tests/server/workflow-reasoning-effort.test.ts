import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
  runAndWait: vi.fn(),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
  getStoragePath: () => ':memory:',
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))
vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => ({ runAndWait: state.runAndWait, abortSession: vi.fn() }),
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
vi.mock('../../packages/server/src/services/reasoning-capability', () => ({
  validateReasoningEffortForProfile: vi.fn(async (input: any) => input.reasoningEffort || ''),
}))
vi.mock('../../packages/server/src/controllers/hermes/models', () => ({
  getAvailableModelReferencesForProfile: vi.fn(async () => [
    { provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses' },
  ]),
}))

function workflowNode(id: string, agent: 'hermes' | 'codex' | 'claude-code', reasoningEffort?: unknown) {
  return {
    id,
    type: 'agent',
    data: {
      title: id,
      agent,
      provider: 'custom:test',
      model: 'gpt-5.6-sol',
      apiMode: 'codex_responses',
      input: `run ${id}`,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  }
}

describe('workflow node reasoning effort', () => {
  let root: string

  beforeEach(async () => {
    vi.resetModules()
    state.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'ok' })
    root = mkdtempSync(join(tmpdir(), 'workflow-reasoning-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['hermes', undefined],
    ['codex', 'codex'],
    ['claude-code', 'claude-code'],
  ] as const)('persists max in the canonical snapshot and forwards it for %s', async (agent, codingAgentId) => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: `reasoning ${agent}`, nodes: [workflowNode('node', agent, 'max')] })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect((result.run.snapshot_nodes[0] as any).data.reasoningEffort).toBe('max')
    expect(state.runAndWait).toHaveBeenCalledOnce()
    expect(state.runAndWait.mock.calls[0][0]).toMatchObject({
      reasoning_effort: 'max',
      ...(codingAgentId ? { coding_agent_id: codingAgentId, mode: 'scoped' } : {}),
    })
  })

  it('omits the override when the node uses the default effort', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'default reasoning', nodes: [workflowNode('node', 'hermes', '')] })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect((result.run.snapshot_nodes[0] as any).data).not.toHaveProperty('reasoningEffort')
    expect(state.runAndWait.mock.calls[0][0]).not.toHaveProperty('reasoning_effort')
  })

  it.each(['ultra', 'MAX', null, 3, {}])('rejects invalid explicit effort %j before run persistence', async (reasoningEffort) => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'invalid reasoning', nodes: [workflowNode('node', 'hermes', reasoningEffort)] })
    const manager = new WorkflowManager()

    expect(() => manager.prepareRun(workflow.id)).toThrow(/reasoning effort/i)
    expect(listWorkflowRuns(workflow.id)).toEqual([])
    expect(state.runAndWait).not.toHaveBeenCalled()
  })
})
