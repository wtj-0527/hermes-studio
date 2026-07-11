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
      models: [{ provider: 'custom:test', model: 'm', apiMode: 'chat_completions' }],
    })
    expect(preview.canImport).toBe(false)
    expect(preview.missing.models).toEqual([
      { provider: 'custom:test', model: 'm', apiMode: 'responses' },
    ])
  })

  it('warns when a source profile hint differs from the explicit target without remapping it', () => {
    const parsed = parseWorkflowImportDocument(exportWorkflowDocument(record() as any))
    const preview = inspectWorkflowImportDependencies(parsed, {
      targetProfile: 'work', profiles: ['work'], agents: ['hermes'], skills: [],
      models: [{ provider: 'custom:test', model: 'm', apiMode: 'responses' }],
    })
    expect(preview.resolvedWorkflow.profile).toBe('work')
    expect(preview.warnings.join('\n')).toMatch(/profile.*default.*work/i)
  })
})
