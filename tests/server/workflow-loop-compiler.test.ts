import { describe, expect, it } from 'vitest'
import {
  MAX_WORKFLOW_LOOP_ITERATIONS,
  compileWorkflowGraph,
  normalizeWorkflowEdgeOrchestration,
} from '../../packages/server/src/services/workflow-orchestration'

const n = (id: string, type: string | undefined = 'agent') => ({
  id,
  ...(type === undefined ? {} : { type }),
  data: { title: id, agent: 'hermes', provider: 'p', model: 'm', input: id },
})
const edge = (id: string, source: string, target: string, orchestration?: unknown) => ({
  id, source, target, ...(orchestration === undefined ? {} : { data: { orchestration } }),
})
const feedback = (id: string, source: string, target: string, maxIterations = 3) => edge(
  id, source, target,
  { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations } },
)

describe('workflow feedback loop compiler', () => {
  it('compiles a bounded natural feedback edge and removes it from forward topo', () => {
    const result = compileWorkflowGraph(
      [n('a'), n('b')],
      [edge('a-b', 'a', 'b'), feedback('retry', 'b', 'a', 3)],
    )
    expect(result.topologicalOrder).toEqual(['a', 'b'])
    expect(result.forwardEdges.map(item => item.id)).toEqual(['a-b'])
    expect(result.feedbackEdges.map(item => item.id)).toEqual(['retry'])
    expect(result.loops).toEqual([{
      id: 'loop:retry', headerNodeId: 'a', latchNodeId: 'b', feedbackEdgeId: 'retry',
      nodeIds: ['a', 'b'], maxIterations: 3, parentLoopId: null,
    }])
    expect(result.nodeLoopStacks).toEqual({ a: ['loop:retry'], b: ['loop:retry'] })
    expect(result.edgeClassifications).toMatchObject({
      'a-b': { kind: 'internal', enterLoopIds: [], exitLoopIds: [] },
      retry: { kind: 'feedback', loopId: 'loop:retry' },
    })
  })

  it('allows a marked bounded self feedback loop', () => {
    const result = compileWorkflowGraph([n('a')], [feedback('again', 'a', 'a', 2)])
    expect(result.topologicalOrder).toEqual(['a'])
    expect(result.loops[0]).toMatchObject({
      id: 'loop:again', headerNodeId: 'a', latchNodeId: 'a', nodeIds: ['a'], maxIterations: 2,
    })
  })

  it('compiles strict nested loops and assigns the minimal containing parent', () => {
    const result = compileWorkflowGraph(
      [n('outer-h'), n('inner-h'), n('inner-l'), n('outer-l')],
      [
        edge('oh-ih', 'outer-h', 'inner-h'),
        edge('ih-il', 'inner-h', 'inner-l'),
        edge('il-ol', 'inner-l', 'outer-l'),
        feedback('inner', 'inner-l', 'inner-h', 2),
        feedback('outer', 'outer-l', 'outer-h', 4),
      ],
    )
    expect(result.loops).toEqual([
      {
        id: 'loop:outer', headerNodeId: 'outer-h', latchNodeId: 'outer-l', feedbackEdgeId: 'outer',
        nodeIds: ['outer-h', 'inner-h', 'inner-l', 'outer-l'], maxIterations: 4, parentLoopId: null,
      },
      {
        id: 'loop:inner', headerNodeId: 'inner-h', latchNodeId: 'inner-l', feedbackEdgeId: 'inner',
        nodeIds: ['inner-h', 'inner-l'], maxIterations: 2, parentLoopId: 'loop:outer',
      },
    ])
    expect(result.nodeLoopStacks).toEqual({
      'outer-h': ['loop:outer'],
      'inner-h': ['loop:outer', 'loop:inner'],
      'inner-l': ['loop:outer', 'loop:inner'],
      'outer-l': ['loop:outer'],
    })
    expect(result.edgeClassifications['oh-ih']).toMatchObject({ kind: 'enter', enterLoopIds: ['loop:inner'] })
    expect(result.edgeClassifications['il-ol']).toMatchObject({ kind: 'exit', exitLoopIds: ['loop:inner'] })
  })

  it('compiles disjoint loop regions', () => {
    const result = compileWorkflowGraph(
      [n('a'), n('b'), n('c'), n('d')],
      [edge('a-b', 'a', 'b'), feedback('ab', 'b', 'a'), edge('c-d', 'c', 'd'), feedback('cd', 'd', 'c')],
    )
    expect(result.loops.map(loop => ({ id: loop.id, parent: loop.parentLoopId, nodes: loop.nodeIds }))).toEqual([
      { id: 'loop:ab', parent: null, nodes: ['a', 'b'] },
      { id: 'loop:cd', parent: null, nodes: ['c', 'd'] },
    ])
  })

  it.each([
    ['missing condition', { route: 'success', loop: { maxIterations: 3 } }, /condition/i],
    ['zero', { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 0 } }, /maxIterations/i],
    ['fraction', { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 1.5 } }, /maxIterations/i],
    ['string', { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: '3' } }, /maxIterations/i],
    ['over hard limit', { route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: MAX_WORKFLOW_LOOP_ITERATIONS + 1 } }, /maxIterations/i],
  ])('rejects invalid feedback loop policy: %s', (_name, policy, error) => {
    expect(() => normalizeWorkflowEdgeOrchestration(policy)).toThrow(error)
  })

  it('requires an explicit stable id for every feedback edge', () => {
    expect(() => compileWorkflowGraph(
      [n('a'), n('b')],
      [edge('a-b', 'a', 'b'), { source: 'b', target: 'a', data: { orchestration: {
        route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations: 3 },
      } } }],
    )).toThrow(/feedback edge id/i)
  })

  it('rejects an unmarked cycle', () => {
    expect(() => compileWorkflowGraph(
      [n('a'), n('b')], [edge('a-b', 'a', 'b'), edge('b-a', 'b', 'a')],
    )).toThrow(/unmarked cycle/i)
  })

  it('rejects feedback whose target cannot reach its source in the forward DAG', () => {
    expect(() => compileWorkflowGraph(
      [n('a'), n('b'), n('c')], [edge('a-b', 'a', 'b'), feedback('bad', 'c', 'a')],
    )).toThrow(/cannot reach/i)
  })

  it('rejects a multi-entry loop when the header does not dominate the latch', () => {
    expect(() => compileWorkflowGraph(
      [n('root'), n('header'), n('middle'), n('latch')],
      [
        edge('root-header', 'root', 'header'), edge('header-middle', 'header', 'middle'),
        edge('middle-latch', 'middle', 'latch'), edge('root-middle', 'root', 'middle'),
        feedback('retry', 'latch', 'header'),
      ],
    )).toThrow(/multi-entry|dominate|reducible/i)
  })

  it('rejects partially overlapping non-nested loop regions', () => {
    expect(() => compileWorkflowGraph(
      [n('a'), n('b'), n('c'), n('d')],
      [
        edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-d', 'c', 'd'),
        feedback('left', 'c', 'a'), feedback('right', 'd', 'b'),
      ],
    )).toThrow(/overlap|laminar/i)
  })

  it('rejects equal loop regions with ambiguous feedback ownership', () => {
    expect(() => compileWorkflowGraph(
      [n('a'), n('b')],
      [edge('a-b', 'a', 'b'), feedback('first', 'b', 'a'), feedback('second', 'b', 'a')],
    )).toThrow(/ambiguous|equal/i)
  })

  it('rejects explicit non-Agent node types while preserving absent legacy types as Agent', () => {
    expect(() => compileWorkflowGraph([n('shell', 'shell')], [])).toThrow(/agent node type/i)
    expect(compileWorkflowGraph([n('legacy', undefined)], []).nodes[0].type).toBe('agent')
  })
})
