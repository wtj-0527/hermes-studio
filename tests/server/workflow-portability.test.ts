import { describe, expect, it } from 'vitest'
import {
  exportWorkflowDocument,
  inspectWorkflowImportDependencies,
  parseWorkflowImportDocument,
} from '../../packages/server/src/services/workflow-portability'

const workflow = {
  id: 'workflow-secret-id',
  name: 'Portable workflow',
  profile: 'default',
  workspace: '/local/workspace',
  created_at: 1,
  updated_at: 2,
  nodes: [
    {
      id: 'plan', type: 'agent', position: { x: 10, y: 20 }, dragHandle: '.node-header',
      style: { width: '280px', height: '420px' },
      data: {
        title: 'Plan', agent: 'hermes', provider: 'custom:test', model: 'gpt-5.6-sol',
        apiMode: 'codex_responses', reasoningEffort: 'max', input: 'Make a plan',
        skills: ['plan'], images: [], orchestration: { joinMode: 'all' },
        apiKey: 'must-not-export', session_id: 'must-not-export', arbitrary: { token: 'must-not-export' },
      },
    },
    {
      id: 'build', type: 'agent', position: { x: 360, y: 20 },
      data: {
        title: 'Build', agent: 'codex', provider: 'custom:test', model: 'gpt-5.6-sol',
        apiMode: 'codex_responses', reasoningEffort: 'high', input: 'Build it', skills: [], images: [],
        orchestration: { joinMode: 'all' },
      },
    },
  ],
  edges: [{
    id: 'plan-build', source: 'plan', target: 'build', sourceHandle: 'output', targetHandle: 'input',
    type: 'smoothstep', animated: true, markerEnd: 'arrowclosed',
    data: { orchestration: { route: 'success' }, trace: { owner: 'qa' }, weight: 2, apiKey: 'must-not-export' },
  }],
  viewport: { x: 1, y: 2, zoom: 0.9 },
  runs: [{ id: 'must-not-export' }],
}

describe('workflow JSON portability', () => {
  it('exports a deterministic versioned definition without ids, history, credentials, or runtime fields', () => {
    const first = exportWorkflowDocument(workflow as any)
    const second = exportWorkflowDocument({ ...workflow, updated_at: 999 } as any)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schema: 'hermes-studio.workflow', version: 1,
      workflow: {
        name: 'Portable workflow', profileHint: 'default', workspaceHint: '/local/workspace',
        viewport: { x: 1, y: 2, zoom: 0.9 },
      },
      dependencies: {
        agents: ['codex', 'hermes'],
        providers: ['custom:test'],
        models: [{ provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses' }],
        skills: [{ agent: 'hermes', name: 'plan' }],
      },
    })
    expect((first.workflow.nodes[0] as any).data.reasoningEffort).toBe('max')
    expect((first.workflow.nodes[0] as any).data).not.toHaveProperty('apiKey')
    expect((first.workflow.nodes[0] as any).data).not.toHaveProperty('session_id')
    expect((first.workflow.nodes[0] as any).data).not.toHaveProperty('arbitrary')
    expect((first.workflow.edges[0] as any).data).toEqual({ orchestration: { route: 'success' } })
    const text = JSON.stringify(first)
    for (const forbidden of ['workflow-secret-id', 'must-not-export', 'created_at', 'updated_at', 'runs']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('round-trips canonical node reasoning, topology, edge metadata, and viewport', () => {
    const exported = exportWorkflowDocument(workflow as any)
    const parsed = parseWorkflowImportDocument(exported)

    expect(parsed.name).toBe('Portable workflow')
    expect(parsed.profileHint).toBe('default')
    expect(parsed.workspaceHint).toBe('/local/workspace')
    expect(parsed.nodes).toEqual(exported.workflow.nodes)
    expect(parsed.edges).toEqual(exported.workflow.edges)
    expect(parsed.viewport).toEqual(exported.workflow.viewport)
    expect(parsed.dependencies).toEqual(exported.dependencies)
  })

  it.each([
    [{ schema: 'other', version: 1, workflow: {} }, 'schema'],
    [{ schema: 'hermes-studio.workflow', version: 2, workflow: {} }, 'version'],
    [{ schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'x', nodes: [{ id: 'x', type: 'shell', data: {} }], edges: [] } }, 'agent'],
    [{ schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'x', nodes: [{ id: 'x', type: 'agent', data: { title: 'x', agent: 'hermes', provider: 'p', model: 'm', input: 'x', reasoningEffort: 'ultra' } }], edges: [] } }, 'reasoning effort'],
    [{ schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'x', nodes: [{ id: 'x', type: 'agent', data: { title: 'x', agent: 'hermes', provider: 'p', model: 'm', input: 'x' } }, { id: 'y', type: 'agent', data: { title: 'y', agent: 'hermes', provider: 'p', model: 'm', input: 'y' } }], edges: [{ source: 'x', target: 'y' }, { source: 'y', target: 'x' }] } }, 'cycle'],
    [{ schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'x', nodes: [], edges: [], runHistory: [] } }, 'unknown'],
  ] as const)('rejects malformed or non-portable documents: %j', (document, message) => {
    expect(() => parseWorkflowImportDocument(document)).toThrow(message)
  })

  it('rejects oversized, deeply nested, and prototype-related JSON before compilation', () => {
    const base = exportWorkflowDocument(workflow as any) as any
    expect(() => parseWorkflowImportDocument({ ...base, workflow: { ...base.workflow, name: 'x'.repeat(1_048_577) } })).toThrow(/size/i)
    let nested: any = 'leaf'
    for (let index = 0; index < 25; index += 1) nested = { child: nested }
    expect(() => parseWorkflowImportDocument({ ...base, workflow: { ...base.workflow, nodes: base.workflow.nodes.map((node: any, index: number) => index ? node : ({ ...node, data: { ...node.data, orchestration: nested } })) } })).toThrow(/depth/i)
    const polluted = JSON.parse(JSON.stringify(base).replace('"orchestration":{"route":"success"}', '"orchestration":{"route":"success","__proto__":{"polluted":true}}'))
    expect(() => parseWorkflowImportDocument(polluted)).toThrow(/unsafe key/i)
    expect(({} as any).polluted).toBeUndefined()
  })

  it('rejects tampered or secret-bearing declared dependencies instead of trusting them', () => {
    const exported = exportWorkflowDocument(workflow as any) as any
    expect(() => parseWorkflowImportDocument({
      ...exported,
      dependencies: { ...exported.dependencies, providers: ['replacement-provider'] },
    })).toThrow(/dependencies do not match/i)
    expect(() => parseWorkflowImportDocument({
      ...exported,
      dependencies: { ...exported.dependencies, token: 'secret' },
    })).toThrow(/unknown field/i)
  })

  it('derives dependencies from canonical nodes and reports missing environment items without remapping', () => {
    const parsed = parseWorkflowImportDocument(exportWorkflowDocument(workflow as any))
    const preview = inspectWorkflowImportDependencies(parsed, {
      targetProfile: 'work',
      profiles: ['default'],
      agents: ['hermes'],
      models: [{ provider: 'custom:test', model: 'other-model', apiMode: 'codex_responses' }],
      reasoningCapabilities: [],
      skills: [],
    })

    expect(preview.canImport).toBe(false)
    expect(preview.missing).toEqual({
      profiles: ['work'],
      agents: ['codex'],
      providers: [],
      models: [{ provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses' }],
      reasoningCapabilities: [
        { provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses', reasoningEffort: 'high' },
        { provider: 'custom:test', model: 'gpt-5.6-sol', apiMode: 'codex_responses', reasoningEffort: 'max' },
      ],
      skills: [{ agent: 'hermes', name: 'plan' }],
    })
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('workspace'),
    ]))
    expect(preview.resolvedWorkflow.nodes).toEqual(parsed.nodes)
    expect((preview.resolvedWorkflow.nodes[0] as any).data.model).toBe('gpt-5.6-sol')
  })
})
