import { describe, expect, it } from 'vitest'
import {
  buildWorkflowEdgeOrchestration,
  edgeEvidenceVisual,
  edgeOrchestrationLabel,
  normalizeWorkflowEdgeOrchestration,
  normalizeWorkflowJoinMode,
  withWorkflowEdgeOrchestration,
  legacyWorkflowEdgeId,
} from '../../packages/client/src/components/hermes/workflow/orchestration'

describe('workflow orchestration client contract', () => {
  it('defaults legacy workflows to success/all and normalizes declarative policies', () => {
    expect(normalizeWorkflowEdgeOrchestration(undefined)).toEqual({ route: 'success' })
    expect(normalizeWorkflowJoinMode(undefined)).toBe('all')
    expect(normalizeWorkflowEdgeOrchestration({ route: 'failure', condition: { path: 'json.ok', operator: 'equals', value: true } }))
      .toEqual({ route: 'failure', condition: { path: 'json.ok', operator: 'equals', value: true } })
    expect(normalizeWorkflowJoinMode('any')).toBe('any')
    expect(() => normalizeWorkflowJoinMode('sometimes')).toThrow('joinMode must be all or any')
  })

  it('builds labels without executable expressions', () => {
    expect(edgeOrchestrationLabel({ route: 'always', condition: { path: 'json.items', operator: 'contains', value: 'ready' } }))
      .toBe('always · json.items contains "ready"')
  })

  it('maps persisted edge evidence to visible states', () => {
    expect(edgeEvidenceVisual('taken')).toMatchObject({ animated: true, className: 'edge-taken' })
    expect(edgeEvidenceVisual('not_taken')).toMatchObject({ animated: false, className: 'edge-not-taken' })
    expect(edgeEvidenceVisual('error')).toMatchObject({ animated: false, className: 'edge-error' })
  })
  it('fails closed for explicit malformed edge policies', () => {
    expect(() => normalizeWorkflowEdgeOrchestration(null)).toThrow()
    for (const policy of ['success', { route: 'unknown' }, { route: 'success', condition: 'x' }, { route: 'success', condition: { path: '', operator: 'equals' } }, { route: 'success', condition: { path: 'json.ok', operator: 'execute' } }]) {
      expect(() => normalizeWorkflowEdgeOrchestration(policy)).toThrow()
    }
  })

  it('preserves unrelated edge data when updating orchestration', () => {
    expect(withWorkflowEdgeOrchestration({ orchestration: { route: 'success' }, trace: { owner: 'qa' }, weight: 2 }, { route: 'failure' }))
      .toEqual({ orchestration: { route: 'failure' }, trace: { owner: 'qa' }, weight: 2 })
  })

  it('uses server-compatible indexed ids for old snapshot edges', () => {
    expect(legacyWorkflowEdgeId('a', 'b', 3)).toBe('a->b#3')
  })

  it('requires explicit routes and condition values like the server', () => {
    expect(() => normalizeWorkflowEdgeOrchestration({})).toThrow('route')
    expect(() => normalizeWorkflowEdgeOrchestration({ condition: { path: 'json.ok', operator: 'truthy' } })).toThrow('route')
    for (const operator of ['equals', 'not_equals', 'contains']) {
      expect(() => normalizeWorkflowEdgeOrchestration({ route: 'success', condition: { path: 'json.ok', operator } })).toThrow('value')
    }
    expect(normalizeWorkflowEdgeOrchestration({ route: 'success', condition: { path: 'json.ok', operator: 'equals', value: undefined } }).condition).toHaveProperty('value')
  })

  it('builds edge policies without dropping enabled invalid conditions', () => {
    expect(() => buildWorkflowEdgeOrchestration('success', true, '   ', 'equals', true)).toThrow('path')
    expect(buildWorkflowEdgeOrchestration('success', false, '', 'equals', true)).toEqual({ route: 'success' })
    expect(buildWorkflowEdgeOrchestration('failure', true, ' json.ok ', 'equals', null)).toEqual({
      route: 'failure', condition: { path: 'json.ok', operator: 'equals', value: null },
    })
    expect(buildWorkflowEdgeOrchestration('always', true, 'json.ready', 'truthy', 'ignored')).toEqual({
      route: 'always', condition: { path: 'json.ready', operator: 'truthy' },
    })
  })

  it('fails closed for explicit null defaults and unsafe or empty path segments', () => {
    expect(() => normalizeWorkflowEdgeOrchestration(null)).toThrow()
    expect(() => normalizeWorkflowJoinMode(null)).toThrow()
    expect(() => normalizeWorkflowEdgeOrchestration({ route: 'success', condition: null })).toThrow()
    for (const path of ['json..ok', '.json', 'json.', 'json.__proto__.ok', 'json.prototype.x', 'json.constructor.name']) {
      expect(() => normalizeWorkflowEdgeOrchestration({ route: 'success', condition: { path, operator: 'truthy' } })).toThrow('path')
      expect(() => buildWorkflowEdgeOrchestration('success', true, path, 'truthy', undefined)).toThrow('path')
    }
  })

})
