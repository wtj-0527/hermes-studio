import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

describe('Workflow edge authoring interactions', () => {
  it('opens the edge policy editor from a normal left click only on editable definitions', () => {
    expect(source).toContain('@edge-click="handleEdgeClick"')
    expect(source).toContain('function handleEdgeClick(')
    expect(source).toMatch(/function handleEdgeClick[\s\S]*?if \(selectedWorkflowRunId\.value\) return/)
    expect(source).toMatch(/function handleEdgeClick[\s\S]*?contextMenuTarget\.value = \{ type: 'edge', id: payload\.edge\.id \}/)
    expect(source).toMatch(/function handleEdgeClick[\s\S]*?openEdgeEditor\(payload\.edge\.id\)/)
  })

  it('creates and connects a Hermes node when an output connection ends on empty canvas', () => {
    expect(source).toContain('@connect-start="handleConnectStart"')
    expect(source).toContain('@connect-end="handleConnectEnd"')
    expect(source).toContain('function handleConnectStart(')
    expect(source).toContain('async function handleConnectEnd(')
    expect(source).toMatch(/function handleConnectStart[\s\S]*?handleType !== 'source'/)
    expect(source).toMatch(/function handleConnectStart[\s\S]*?handleId !== 'output'/)
    expect(source).toMatch(/async function handleConnectEnd[\s\S]*?if \(connectionCompletedSinceStart\.value\) return/)
    expect(source).toMatch(/async function handleConnectEnd[\s\S]*?isEmptyWorkflowCanvasRelease/)
    expect(source).toMatch(/async function handleConnectEnd[\s\S]*?makeNode\(/)
    expect(source).toMatch(/async function handleConnectEnd[\s\S]*?agent: 'hermes'/)
    expect(source).toMatch(/async function handleConnectEnd[\s\S]*?appendWorkflowEdge/)
    expect(source).toMatch(/async function handleConnectEnd[\s\S]*?screenToFlowCoordinate/)
    expect(source).toMatch(/function appendWorkflowEdge[\s\S]*?route: 'success'/)
  })
})
