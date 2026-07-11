import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import {
  confirmWorkflowImport,
  exportWorkflowDefinition,
  previewWorkflowImport,
} from '@/api/hermes/workflows'

describe('workflow portability API client', () => {
  beforeEach(() => request.mockReset())

  it('exports a workflow through the definition-only endpoint', async () => {
    request.mockResolvedValue({ schema: 'hermes-studio.workflow', version: 1 })
    await exportWorkflowDefinition('workflow/1')
    expect(request).toHaveBeenCalledWith('/api/hermes/workflows/workflow%2F1/export')
  })

  it('previews before confirmation and sends explicit confirmation separately', async () => {
    const document = { schema: 'hermes-studio.workflow', version: 1 }
    request.mockResolvedValueOnce({ previewId: 'preview-1', documentDigest: 'sha256:abc', expiresAt: 1, preview: { canImport: true } }).mockResolvedValueOnce({ workflow: { id: 'new' }, warnings: [] })

    await previewWorkflowImport(document, 'work')
    await confirmWorkflowImport('preview-1', 'sha256:abc')

    expect(request.mock.calls).toEqual([
      ['/api/hermes/workflows/import/preview', { method: 'POST', body: JSON.stringify({ document, profile: 'work' }) }],
      ['/api/hermes/workflows/import/confirm', { method: 'POST', body: JSON.stringify({ previewId: 'preview-1', documentDigest: 'sha256:abc', confirmed: true }) }],
    ])
  })
})
