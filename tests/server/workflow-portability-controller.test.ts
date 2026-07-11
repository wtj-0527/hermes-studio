import { beforeEach, describe, expect, it, vi } from 'vitest'

const manager = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn() }))
const portability = vi.hoisted(() => ({
  exportWorkflowDocument: vi.fn(),
  parseWorkflowImportDocument: vi.fn(),
  inspectWorkflowImportDependencies: vi.fn(),
  collectWorkflowImportEnvironment: vi.fn(),
}))
const listUserProfiles = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/workflow-manager', () => ({ getWorkflowManager: () => manager }))
vi.mock('../../packages/server/src/services/workflow-portability', () => portability)
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({ listUserProfiles }))
vi.mock('../../packages/server/src/db/hermes/workflow-run-store', () => ({
  getWorkflowRun: vi.fn(), listWorkflowRunNodeSessions: vi.fn(), listWorkflowRuns: vi.fn(),
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({ listProfileNamesFromDisk: () => ['default', 'work'] }))

function context(overrides: Record<string, any> = {}) {
  return {
    params: {}, query: {}, request: { body: {} }, state: {}, status: 200, body: undefined,
    set: vi.fn(), ...overrides,
  } as any
}

const document = { schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'Imported' }, dependencies: {} }
const parsed = {
  name: 'Imported', profileHint: 'default', workspaceHint: '/source/path', nodes: [{ id: 'a' }], edges: [], viewport: null,
  dependencies: { agents: ['hermes'], providers: ['p'], models: [{ provider: 'p', model: 'm' }], skills: [] },
}
const readyPreview = {
  canImport: true,
  missing: { profiles: [], agents: [], providers: [], models: [], skills: [] },
  warnings: ['workspace hint ignored'],
  resolvedWorkflow: { name: 'Imported', profile: 'work', workspace: null, nodes: parsed.nodes, edges: [], viewport: null },
}

describe('workflow portability controller', () => {
  beforeEach(() => {
    vi.resetModules()
    manager.get.mockReset()
    manager.create.mockReset()
    portability.exportWorkflowDocument.mockReset()
    portability.parseWorkflowImportDocument.mockReset().mockReturnValue(parsed)
    portability.inspectWorkflowImportDependencies.mockReset().mockReturnValue(readyPreview)
    portability.collectWorkflowImportEnvironment.mockReset().mockResolvedValue({})
    listUserProfiles.mockReset().mockReturnValue([])
  })

  it('exports only the portable document as an attachment', async () => {
    manager.get.mockReturnValue({ id: 'workflow-1', profile: 'default', name: 'Portable workflow' })
    portability.exportWorkflowDocument.mockReturnValue(document)
    const { exportDefinition } = await import('../../packages/server/src/controllers/hermes/workflows')
    const ctx = context({ params: { id: 'workflow-1' } })

    await exportDefinition(ctx)

    expect(portability.exportWorkflowDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 'workflow-1' }))
    expect(ctx.set).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('.json'))
    expect(ctx.body).toEqual(document)
  })

  it('previews an import without creating or running anything', async () => {
    const { previewImport } = await import('../../packages/server/src/controllers/hermes/workflows')
    const ctx = context({ request: { body: { document, profile: 'work' } } })

    await previewImport(ctx)

    expect(portability.collectWorkflowImportEnvironment).toHaveBeenCalledWith(parsed, 'work')
    expect(portability.inspectWorkflowImportDependencies).toHaveBeenCalledWith(parsed, {})
    expect(manager.create).not.toHaveBeenCalled()
    expect(ctx.body).toMatchObject({
      previewId: expect.any(String), documentDigest: expect.stringMatching(/^sha256:/), expiresAt: expect.any(Number),
      preview: readyPreview,
    })
  })

  it('refuses confirmation when dependencies are missing and creates no workflow', async () => {
    portability.inspectWorkflowImportDependencies.mockReturnValue({ ...readyPreview, canImport: false })
    const { previewImport, confirmImport } = await import('../../packages/server/src/controllers/hermes/workflows')
    const previewCtx = context({ request: { body: { document, profile: 'work' } } })
    await previewImport(previewCtx)
    const { previewId, documentDigest } = previewCtx.body as any
    const confirmCtx = context({ request: { body: { previewId, documentDigest, confirmed: true } } })

    await confirmImport(confirmCtx)

    expect(confirmCtx.status).toBe(409)
    expect(manager.create).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation, creates a new id, ignores source workspace, and never starts a run', async () => {
    manager.create.mockReturnValue({ id: 'new-workflow-id', name: 'Imported', profile: 'work', workspace: '/generated/path' })
    const { confirmImport } = await import('../../packages/server/src/controllers/hermes/workflows')

    const unconfirmed = context({ request: { body: { document, profile: 'work' } } })
    await confirmImport(unconfirmed)
    expect(unconfirmed.status).toBe(400)
    expect(manager.create).not.toHaveBeenCalled()

    const { previewImport } = await import('../../packages/server/src/controllers/hermes/workflows')
    const previewCtx = context({ request: { body: { document, profile: 'work' } } })
    await previewImport(previewCtx)
    const { previewId, documentDigest } = previewCtx.body as any
    const confirmed = context({ request: { body: { previewId, documentDigest, confirmed: true } } })
    await confirmImport(confirmed)

    expect(manager.create).toHaveBeenCalledWith({
      name: 'Imported', profile: 'work', workspace: null,
      nodes: parsed.nodes, edges: [], viewport: null,
    })
    expect(manager.create.mock.calls[0][0]).not.toHaveProperty('id')
    expect((manager as any).runNow).toBeUndefined()
    expect(confirmed.status).toBe(201)
    expect(confirmed.body).toEqual({ workflow: expect.objectContaining({ id: 'new-workflow-id' }), warnings: readyPreview.warnings })
  })
})
