import { describe, expect, it } from 'vitest'
import {
  evaluateWorkflowEdge,
  normalizeWorkflowEdgeOrchestration,
  normalizeWorkflowJoinMode,
  parseWorkflowJsonOutput,
  compileWorkflowGraph,
  hasNonLegacyWorkflowOrchestration,
} from '../../packages/server/src/services/workflow-orchestration'

describe('workflow orchestration policy', () => {
  it('keeps legacy edges as unconditional success routes and legacy nodes as all joins', () => {
    expect(normalizeWorkflowEdgeOrchestration(undefined)).toEqual({ route: 'success' })
    expect(normalizeWorkflowJoinMode(undefined)).toBe('all')
  })

  it('parses plain and fenced JSON output without evaluating code', () => {
    expect(parseWorkflowJsonOutput('{"release":{"ready":true}}')).toEqual({ release: { ready: true } })
    expect(parseWorkflowJsonOutput('Result:\n```json\n{"tags":["stable","v1"]}\n```')).toEqual({ tags: ['stable', 'v1'] })
    expect(parseWorkflowJsonOutput('```js\nprocess.exit(1)\n```')).toBeNull()
  })

  it('takes declarative success conditions over parsed output', () => {
    const result = evaluateWorkflowEdge({
      id: 'approve', source: 'plan', target: 'publish',
      data: { orchestration: { route: 'success', condition: { path: 'json.release.ready', operator: 'equals', value: true } } },
    }, { nodeId: 'plan', status: 'success', output: '```json\n{"release":{"ready":true}}\n```' })

    expect(result).toMatchObject({ status: 'taken', reason: 'condition matched' })
    expect(result.context).toMatchObject({ status: 'success', json: { release: { ready: true } } })
  })

  it.each([
    ['not_equals', 'green', 'red'],
    ['exists', 'value', undefined],
    ['truthy', 1, undefined],
    ['contains', ['stable', 'v1'], 'v1'],
    ['contains', 'release-v1', 'v1'],
  ] as const)('supports the %s condition operator', (operator, actual, value) => {
    const result = evaluateWorkflowEdge({
      source: 'a', target: 'b',
      data: { orchestration: { route: 'always', condition: { path: 'json.value', operator, value } } },
    }, { nodeId: 'a', status: 'failure', output: JSON.stringify({ value: actual }), error: 'expected failure' })
    expect(result.status).toBe('taken')
  })

  it('resolves unprefixed condition paths against parsed JSON output', () => {
    const result = evaluateWorkflowEdge({
      source: 'a', target: 'b',
      data: { orchestration: { route: 'success', condition: { path: 'release.ready', operator: 'truthy' } } },
    }, { nodeId: 'a', status: 'success', output: '{"release":{"ready":true}}' })

    expect(result.status).toBe('taken')
  })

  it('fails closed when a condition is invalid', () => {
    const result = evaluateWorkflowEdge({
      source: 'a', target: 'b',
      data: { orchestration: { route: 'success', condition: { path: '', operator: 'equals', value: 1 } } },
    }, { nodeId: 'a', status: 'success', output: '{"value":1}' })

    expect(result.status).toBe('error')
    expect(result.reason).toContain('condition path')
  })

  it('does not take a route that does not match the source outcome', () => {
    const result = evaluateWorkflowEdge({
      source: 'a', target: 'recover', data: { orchestration: { route: 'failure' } },
    }, { nodeId: 'a', status: 'success', output: 'ok' })

    expect(result).toMatchObject({ status: 'not_taken', reason: 'route failure does not match success' })
  })
  it('rejects explicit invalid join modes while defaulting only undefined', async () => {
    const { normalizeWorkflowJoinMode } = await import('../../packages/server/src/services/workflow-orchestration')
    expect(normalizeWorkflowJoinMode(undefined)).toBe('all')
    expect(() => normalizeWorkflowJoinMode('sometimes')).toThrow('joinMode must be all or any')
  })

  it.each([
    ['duplicate node IDs', [{ id: 'a' }, { id: 'a' }], [], 'duplicate node id'],
    ['duplicate edge IDs', [{ id: 'a' }, { id: 'b' }], [{ id: 'e', source: 'a', target: 'b' }, { id: 'e', source: 'a', target: 'b' }], 'duplicate edge id'],
    ['dangling edges', [{ id: 'a' }], [{ source: 'a', target: 'missing' }], 'missing target'],
    ['self loops', [{ id: 'a' }], [{ source: 'a', target: 'a' }], 'self-loop'],
    ['cycles', [{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }], 'cycle'],
    ['invalid route', [{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b', data: { orchestration: { route: 'maybe' } } }], 'route'],
    ['invalid condition', [{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: 'code' } } }], 'condition'],
    ['invalid join', [{ id: 'a', data: { orchestration: { joinMode: 'some' } } }], [], 'joinMode'],
  ])('rejects %s during graph compilation', (_name, nodes, edges, message) => {
    expect(() => compileWorkflowGraph(nodes, edges)).toThrow(message)
  })

  it('compiles legacy policies and synthesizes stable edge IDs', () => {
    expect(compileWorkflowGraph([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }]).edges[0].id).toBe('a->b#0')
  })

  it('rejects explicit primitive policies and node orchestration containers', () => {
    expect(() => normalizeWorkflowEdgeOrchestration('success')).toThrow('object')
    expect(() => compileWorkflowGraph([{ id: 'a', data: { orchestration: 'all' } }], [])).toThrow('node orchestration must be an object')
  })

  it('requires explicit routes and required condition values', () => {
    expect(() => normalizeWorkflowEdgeOrchestration({})).toThrow('route')
    expect(() => normalizeWorkflowEdgeOrchestration({ condition: { path: 'json.ok', operator: 'truthy' } })).toThrow('route')
    for (const operator of ['equals', 'not_equals', 'contains']) {
      expect(() => normalizeWorkflowEdgeOrchestration({ route: 'success', condition: { path: 'json.ok', operator } })).toThrow('value')
    }
    expect(normalizeWorkflowEdgeOrchestration({ route: 'success', condition: { path: 'json.ok', operator: 'equals', value: undefined } }).condition).toHaveProperty('value')
  })

  it.each(['toString', 'json.toString', 'json.items.map'])('does not traverse prototype properties for %s', (path) => {
    const result = evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path, operator: 'truthy' } } } }, { nodeId: 'a', status: 'success', output: '{"items":[]}' })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('own property')
  })

  it('still resolves ordinary own properties', () => {
    expect(evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path: 'json.ok', operator: 'truthy' } } } }, { nodeId: 'a', status: 'success', output: '{"ok":true}' }).status).toBe('taken')
  })

  it('detects only non-legacy orchestration semantics in snapshots', () => {
    expect(hasNonLegacyWorkflowOrchestration([], [])).toBe(false)
    expect(hasNonLegacyWorkflowOrchestration(
      [{ id: 'a', data: { orchestration: { joinMode: 'all' } } }],
      [{ source: 'a', target: 'b', data: { orchestration: { route: 'success' } } }],
    )).toBe(false)
    expect(hasNonLegacyWorkflowOrchestration([], [{ source: 'a', target: 'b', data: { orchestration: { route: 'failure' } } }])).toBe(true)
    expect(hasNonLegacyWorkflowOrchestration([], [{ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path: 'json.ok', operator: 'truthy' } } } }])).toBe(true)
    expect(hasNonLegacyWorkflowOrchestration([{ id: 'a', data: { orchestration: { joinMode: 'any' } } }], [])).toBe(true)
    expect(hasNonLegacyWorkflowOrchestration([], [{ source: 'a', target: 'b', data: { orchestration: {} } }])).toBe(true)
    expect(hasNonLegacyWorkflowOrchestration([{ id: 'a', data: { orchestration: 'all' } }], [])).toBe(true)
  })

  it('fails closed when JSON paths inspect unparseable output', () => {
    const jsonRoot = evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path: 'json', operator: 'equals', value: null } } } }, { nodeId: 'a', status: 'success', output: 'not json' })
    expect(jsonRoot).toMatchObject({ status: 'error', context: { jsonParsed: false, json: null } })
    expect(jsonRoot.reason).toContain('valid JSON')
    const implicit = evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path: 'release.ready', operator: 'truthy' } } } }, { nodeId: 'a', status: 'success', output: 'not json' })
    expect(implicit).toMatchObject({ status: 'error', context: { jsonParsed: false } })
  })

  it('distinguishes valid JSON null from parse failure and keeps context paths independent', () => {
    expect(evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path: 'json', operator: 'equals', value: null } } } }, { nodeId: 'a', status: 'success', output: 'null' })).toMatchObject({ status: 'taken', context: { jsonParsed: true, json: null } })
    expect(evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path: 'status', operator: 'equals', value: 'success' } } } }, { nodeId: 'a', status: 'success', output: 'not json' }).status).toBe('taken')
  })

  it.each(['json.missing', 'missing', 'json.nested.missing'])('treats absent own property %s as a non-match', (path) => {
    const result = evaluateWorkflowEdge({ source: 'a', target: 'b', data: { orchestration: { route: 'success', condition: { path, operator: 'exists' } } } }, { nodeId: 'a', status: 'success', output: '{"nested":{}}' })
    expect(result).toMatchObject({ status: 'not_taken', reason: 'condition did not match' })
  })


  it('defaults only absent orchestration fields and fails closed for explicit null', () => {
    expect(normalizeWorkflowEdgeOrchestration(undefined)).toEqual({ route: 'success' })
    expect(() => normalizeWorkflowEdgeOrchestration(null)).toThrow()
    expect(normalizeWorkflowJoinMode(undefined)).toBe('all')
    expect(() => normalizeWorkflowJoinMode(null)).toThrow()
    expect(() => normalizeWorkflowEdgeOrchestration({ route: 'success', condition: null })).toThrow()
    expect(() => compileWorkflowGraph([{ id: 'a', data: { orchestration: null } }], [])).toThrow('node orchestration')
  })

})
