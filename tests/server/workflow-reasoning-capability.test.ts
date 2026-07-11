import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '', runAndWait: vi.fn() }))
vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db, jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
  getStoragePath: () => ':memory:',
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))
vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => ({ runAndWait: state.runAndWait, abortSession: vi.fn() }),
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({ getExactSessionDetailFromDbWithProfile: vi.fn() }))
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({ deleteSession: vi.fn(), getSession: vi.fn(), getSessionDetail: vi.fn(() => null) }))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ deleteUsage: vi.fn() }))
vi.mock('../../packages/server/src/services/workflow-skill-resolver', () => ({ resolveWorkflowSkillContent: vi.fn() }))
vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({ codingAgentRunManager: { stop: vi.fn() } }))
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({ deleteSessionForProfile: vi.fn() }))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  listProfileNamesFromDisk: vi.fn(() => ['default']),
  getProfileDir: vi.fn(() => join(state.appHome, 'profiles', 'default')),
}))
vi.mock('../../packages/server/src/services/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

function node(effort: string) {
  return { id: 'node', type: 'agent', data: {
    title: 'node', agent: 'hermes', provider: 'custom:test', model: 'gpt-5.6-sol',
    apiMode: 'codex_responses', input: 'work', reasoningEffort: effort,
  } }
}

function nodeWithoutEffort(model = 'gpt-5.6-sol') {
  return { id: 'node', type: 'agent', data: {
    title: 'node', agent: 'hermes', provider: 'custom:test', model,
    apiMode: 'codex_responses', input: 'work',
  } }
}

function nodeWithInheritedTarget(effort: string) {
  return { id: 'node', type: 'agent', data: {
    title: 'node', agent: 'hermes', input: 'work', reasoningEffort: effort,
  } }
}

function writeConfig(levels?: string[]) {
  const dir = join(state.appHome, 'profiles', 'default')
  mkdirSync(dir, { recursive: true })
  const metadata = levels ? `\n        supported_reasoning_levels: [${levels.join(', ')}]` : ''
  writeFileSync(join(dir, 'config.yaml'), `model:
  default: gpt-5.6-sol
  provider: custom:test
providers:\n  test:\n    base_url: https://example.invalid\n    api_mode: codex_responses\n    models:\n      gpt-5.6-sol:${metadata || ' {}'}\n`)
}

describe('workflow reasoning capability preflight', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules(); state.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'ok' })
    root = mkdtempSync(join(tmpdir(), 'workflow-capability-')); state.appHome = root
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas'); initAllHermesTables()
  })
  afterEach(() => { state.db?.close(); state.db = null; rmSync(root, { recursive: true, force: true }) })

  it('rejects unknown capability before run persistence or backend invocation', async () => {
    writeConfig()
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'unknown', profile: 'default', nodes: [node('max')] })
    await expect(new WorkflowManager().runNow(workflow.id)).rejects.toThrow(/reasoning_capability_unknown/)
    expect(listWorkflowRuns(workflow.id)).toEqual([])
    expect(state.runAndWait).not.toHaveBeenCalled()
  })

  it('rejects unsupported effort exactly and allows declared max', async () => {
    writeConfig(['low', 'high'])
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const unsupported = createWorkflow({ name: 'unsupported', profile: 'default', nodes: [node('max')] })
    await expect(new WorkflowManager().runNow(unsupported.id)).rejects.toThrow(/reasoning_effort_unsupported.*max/)
    expect(listWorkflowRuns(unsupported.id)).toEqual([])

    writeConfig(['low', 'high', 'max'])
    const supported = createWorkflow({ name: 'supported', profile: 'default', nodes: [node('max')] })
    const result = await new WorkflowManager().runNow(supported.id)
    expect(result.run.status).toBe('completed')
    expect(state.runAndWait).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: 'max' }), expect.anything())
  })

  it('resolves the profile default target before validating an inherited node effort', async () => {
    writeConfig(['max'])
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'inherited target', profile: 'default', nodes: [nodeWithInheritedTarget('max')] })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(state.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses', reasoning_effort: 'max',
    }), expect.anything())
    expect(result.run.snapshot_nodes[0]?.data).toMatchObject({
      provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses', reasoningEffort: 'max',
    })
  })

  it('rejects an unavailable provider/model/apiMode tuple even without an effort override', async () => {
    writeConfig(['max'])
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'unavailable model', profile: 'default', nodes: [nodeWithoutEffort('not-configured')] })

    await expect(new WorkflowManager().runNow(workflow.id)).rejects.toThrow(/workflow_model_unavailable/)
    expect(listWorkflowRuns(workflow.id)).toEqual([])
    expect(state.runAndWait).not.toHaveBeenCalled()
  })
})
