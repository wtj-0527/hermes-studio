import { describe, expect, it } from 'vitest'
import {
  exportWorkflowDocument,
  inspectWorkflowImportDependencies,
  parseWorkflowImportDocument,
} from '../../packages/server/src/services/workflow-portability'

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1', type: 'agent', position: { x: 0, y: 0 },
    data: {
      title: 'Agent', agent: 'hermes', provider: 'custom:test', model: 'm', apiMode: 'responses',
      input: 'work', skills: [], images: [], ...overrides,
    },
  }
}

function record(nodeValue = node()) {
  return {
    id: 'db-id', name: 'Portable', profile: 'default', workspace: null,
    nodes: [nodeValue], edges: [], viewport: null, created_at: 1, updated_at: 1,
  }
}

describe('workflow portability security boundaries', () => {
  it('rejects local attachment paths instead of exporting or importing them', () => {
    expect(() => exportWorkflowDocument(record(node({ images: ['/home/user/private.png'] })) as any))
      .toThrow(/non_portable_attachment/i)

    const safe = exportWorkflowDocument(record() as any) as any
    safe.workflow.nodes[0].data.images = ['/etc/passwd']
    expect(() => parseWorkflowImportDocument(safe)).toThrow(/non_portable_attachment/i)
  })

  it('rejects unsafe identifiers before they can become dynamic object keys', () => {
    for (const id of ['__proto__', 'prototype', 'constructor', 'space id', '/absolute']) {
      const safe = exportWorkflowDocument(record() as any) as any
      safe.workflow.nodes[0].id = id
      expect(() => parseWorkflowImportDocument(safe)).toThrow(/node id/i)
    }
  })

  it('derives model dependencies as provider/model/apiMode triples', () => {
    const exported = exportWorkflowDocument(record() as any)
    expect(exported.dependencies.models).toEqual([
      { provider: 'custom:test', model: 'm', apiMode: 'responses' },
    ])
    const parsed = parseWorkflowImportDocument(exported)
    const preview = inspectWorkflowImportDependencies(parsed, {
      targetProfile: 'default', profiles: ['default'], agents: ['hermes'], skills: [],
      models: [{ provider: 'custom:test', model: 'm', apiMode: 'chat_completions' }], reasoningCapabilities: [],
    })
    expect(preview.canImport).toBe(false)
    expect(preview.missing.models).toEqual([
      { provider: 'custom:test', model: 'm', apiMode: 'responses' },
    ])
  })

  it('exports only canonical edge orchestration and rejects every other imported edge data field', () => {
    const source = record() as any
    source.edges = [{
      id: 'edge-1', source: 'agent-1', target: 'agent-1',
      data: {
        orchestration: { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 } },
        clientSecret: 'must-not-export', accessToken: 'must-not-export',
        oauth: { refreshToken: 'must-not-export' }, headers: { 'X-API-Key': 'must-not-export' },
        auth: { bearer: 'must-not-export' }, trace: { owner: 'qa' }, weight: 2,
      },
    }]
    const exported = exportWorkflowDocument(source) as any
    expect(exported.workflow.edges[0].data).toEqual({
      orchestration: { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 2 } },
    })
    const tampered = structuredClone(exported)
    tampered.workflow.edges[0].data.clientSecret = 'injected'
    expect(() => parseWorkflowImportDocument(tampered)).toThrow(/edge data.*unknown field.*clientSecret/i)
  })

  it('requires each explicit reasoning effort to be supported by the exact target model tuple', () => {
    const parsed = parseWorkflowImportDocument(exportWorkflowDocument(record(node({ reasoningEffort: 'max' })) as any))
    const unsupported = inspectWorkflowImportDependencies(parsed, {
      targetProfile: 'default', profiles: ['default'], agents: ['hermes'], skills: [],
      models: [{ provider: 'custom:test', model: 'm', apiMode: 'responses' }],
      reasoningCapabilities: [],
    })
    expect(unsupported.canImport).toBe(false)
    expect(unsupported.missing.reasoningCapabilities).toEqual([
      { provider: 'custom:test', model: 'm', apiMode: 'responses', reasoningEffort: 'max' },
    ])

    const supported = inspectWorkflowImportDependencies(parsed, {
      targetProfile: 'default', profiles: ['default'], agents: ['hermes'], skills: [],
      models: [{ provider: 'custom:test', model: 'm', apiMode: 'responses' }],
      reasoningCapabilities: [{ provider: 'custom:test', model: 'm', apiMode: 'responses', reasoningEffort: 'max' }],
    })
    expect(supported.canImport).toBe(true)
  })

  it('warns when a source profile hint differs from the explicit target without remapping it', () => {
    const parsed = parseWorkflowImportDocument(exportWorkflowDocument(record() as any))
    const preview = inspectWorkflowImportDependencies(parsed, {
      targetProfile: 'work', profiles: ['work'], agents: ['hermes'], skills: [],
      models: [{ provider: 'custom:test', model: 'm', apiMode: 'responses' }], reasoningCapabilities: [],
    })
    expect(preview.resolvedWorkflow.profile).toBe('work')
    expect(preview.warnings.join('\n')).toMatch(/profile.*default.*work/i)
  })
})
