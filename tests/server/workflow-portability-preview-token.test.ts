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

function ctx(body: Record<string, unknown>, state: Record<string, unknown> = {}) {
  return {
    params: {}, query: {}, request: { body }, state, status: 200, body: undefined,
    set: vi.fn(),
  } as any
}
const document = { schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'Imported' }, dependencies: {} }
const parsed = {
  name: 'Imported', profileHint: 'default', workspaceHint: null, nodes: [{ id: 'a' }], edges: [], viewport: null,
  dependencies: { agents: ['hermes'], providers: ['p'], models: [{ provider: 'p', model: 'm', apiMode: 'responses' }], skills: [] },
}
const ready = {
  canImport: true, missing: { profiles: [], agents: [], providers: [], models: [], skills: [] }, warnings: [],
  resolvedWorkflow: { name: 'Imported', profile: 'work', workspace: null, nodes: parsed.nodes, edges: [], viewport: null },
}

describe('workflow import preview token', () => {
  beforeEach(async () => {
    vi.resetModules()
    manager.create.mockReset().mockReturnValue({ id: 'created' })
    portability.parseWorkflowImportDocument.mockReset().mockReturnValue(parsed)
    portability.collectWorkflowImportEnvironment.mockReset().mockResolvedValue({})
    portability.inspectWorkflowImportDependencies.mockReset().mockReturnValue(ready)
    listUserProfiles.mockReset().mockReturnValue([{ profile_name: 'work' }])
  })

  it('returns an opaque preview id and confirms without accepting a replacement document', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/workflows')
    const previewCtx = ctx({ document, profile: 'work' }, { user: { id: 7, role: 'admin' } })
    await ctrl.previewImport(previewCtx)
    const previewId = (previewCtx.body as any).previewId
    const documentDigest = (previewCtx.body as any).documentDigest
    expect(previewId).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(previewCtx.body).not.toHaveProperty('document')

    const replacement = ctx({ previewId, documentDigest, confirmed: true, document: { malicious: true } }, { user: { id: 7, role: 'admin' } })
    await ctrl.confirmImport(replacement)
    expect(replacement.status).toBe(400)
    expect(manager.create).not.toHaveBeenCalled()

    const confirmCtx = ctx({ previewId, documentDigest, confirmed: true }, { user: { id: 7, role: 'admin' } })
    await ctrl.confirmImport(confirmCtx)
    expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ nodes: parsed.nodes }))
    expect(portability.parseWorkflowImportDocument).toHaveBeenCalledTimes(1)
  })

  it('binds the preview to the user and target profile and consumes it exactly once', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/workflows')
    const previewCtx = ctx({ document, profile: 'work' }, { user: { id: 7, role: 'admin' } })
    await ctrl.previewImport(previewCtx)
    const previewId = (previewCtx.body as any).previewId
    const documentDigest = (previewCtx.body as any).documentDigest

    const otherUser = ctx({ previewId, documentDigest, confirmed: true }, { user: { id: 8, role: 'admin' } })
    await ctrl.confirmImport(otherUser)
    expect(otherUser.status).toBe(409)
    expect(manager.create).not.toHaveBeenCalled()

    const first = ctx({ previewId, documentDigest, confirmed: true }, { user: { id: 7, role: 'admin' } })
    await ctrl.confirmImport(first)
    expect(first.status).toBe(201)
    const second = ctx({ previewId, documentDigest, confirmed: true }, { user: { id: 7, role: 'admin' } })
    await ctrl.confirmImport(second)
    expect(second.status).toBe(409)
    expect(manager.create).toHaveBeenCalledTimes(1)
  })

  it('returns preview_stale and creates nothing when dependencies changed after preview', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/workflows')
    const previewCtx = ctx({ document, profile: 'work' }, { user: { id: 7, role: 'admin' } })
    await ctrl.previewImport(previewCtx)
    const previewId = (previewCtx.body as any).previewId
    const documentDigest = (previewCtx.body as any).documentDigest
    portability.inspectWorkflowImportDependencies.mockReturnValueOnce({ ...ready, canImport: false })

    const confirmCtx = ctx({ previewId, documentDigest, confirmed: true }, { user: { id: 7, role: 'admin' } })
    await ctrl.confirmImport(confirmCtx)
    expect(confirmCtx.status).toBe(409)
    expect(confirmCtx.body).toMatchObject({ code: 'preview_stale' })
    expect(manager.create).not.toHaveBeenCalled()
  })

  it('rejects a body profile that conflicts with the authenticated profile context', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/workflows')
    const mismatch = ctx({ document, profile: 'work' }, {
      user: { id: 7, role: 'admin' }, profile: { name: 'default' },
    })
    await ctrl.previewImport(mismatch)
    expect(mismatch.status).toBe(409)
    expect(mismatch.body).toMatchObject({ code: 'profile_mismatch' })
    expect(portability.parseWorkflowImportDocument).not.toHaveBeenCalled()
  })
})
