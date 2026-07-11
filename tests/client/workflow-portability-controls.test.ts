// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import WorkflowPortabilityControls from '@/components/hermes/workflow/WorkflowPortabilityControls.vue'

const api = vi.hoisted(() => ({
  exportWorkflowDefinition: vi.fn(),
  previewWorkflowImport: vi.fn(),
  confirmWorkflowImport: vi.fn(),
}))
vi.mock('@/api/hermes/workflows', () => api)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    inheritAttrs: false,
    props: ['disabled', 'loading'], emits: ['click'],
    template: '<button v-bind="$attrs" type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  }),
  NModal: defineComponent({
    props: ['show'], emits: ['update:show'],
    template: '<div v-if="show" class="modal-stub"><slot /><slot name="footer" /></div>',
  }),
  NSpace: defineComponent({ template: '<div><slot /></div>' }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))

const document = { schema: 'hermes-studio.workflow', version: 1, workflow: { name: 'Imported' }, dependencies: {} }
const missingPreview = {
  canImport: false,
  missing: {
    profiles: [], agents: ['codex'], providers: [],
    models: [{ provider: 'p', model: 'm', apiMode: 'responses' }], skills: [{ agent: 'hermes', name: 'plan' }],
  },
  warnings: ['workspace is a non-portable hint'],
  resolvedWorkflow: { name: 'Imported', profile: 'work', workspace: null, nodes: [], edges: [], viewport: null },
}

function mountControls(onImported = vi.fn()) {
  return {
    wrapper: mount(WorkflowPortabilityControls, {
      props: { workflowId: 'workflow-1', workflowName: 'Source workflow', profile: 'work', onImported },
    }),
    onImported,
  }
}

async function selectImportFile(wrapper: ReturnType<typeof mount> , value = document) {
  const input = wrapper.get('input[type="file"]')
  const file = new File([JSON.stringify(value)], 'workflow.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { configurable: true, value: vi.fn().mockResolvedValue(JSON.stringify(value)) })
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
  await input.trigger('change')
  await flushPromises()
}

describe('workflow portability controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.exportWorkflowDefinition.mockResolvedValue(document)
    api.previewWorkflowImport.mockResolvedValue({ previewId: 'preview-1', documentDigest: 'sha256:abc', expiresAt: 1, preview: missingPreview })
    api.confirmWorkflowImport.mockResolvedValue({ workflow: { id: 'new-workflow' }, warnings: [] })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:workflow') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  })

  it('exports a formatted definition-only JSON file', async () => {
    const { wrapper } = mountControls()
    await wrapper.get('[data-testid="workflow-export"]').trigger('click')
    await flushPromises()

    expect(api.exportWorkflowDefinition).toHaveBeenCalledWith('workflow-1')
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })

  it('previews an import and blocks confirmation while dependencies are missing', async () => {
    const { wrapper } = mountControls()
    await selectImportFile(wrapper)

    expect(api.previewWorkflowImport).toHaveBeenCalledWith(document, 'work')
    expect(wrapper.text()).toContain('codex')
    expect(wrapper.text()).toContain('p / m / responses')
    expect(wrapper.text()).toContain('hermes / plan')
    expect(wrapper.text()).toContain('workspace is a non-portable hint')
    expect(wrapper.get('[data-testid="workflow-import-confirm"]').attributes()).toHaveProperty('disabled')
    expect(api.confirmWorkflowImport).not.toHaveBeenCalled()
  })

  it('creates a new inactive workflow only after explicit confirmation', async () => {
    api.previewWorkflowImport.mockResolvedValueOnce({ previewId: 'preview-1', documentDigest: 'sha256:abc', expiresAt: 1, preview: { ...missingPreview, canImport: true, missing: {
      profiles: [], agents: [], providers: [], models: [], skills: [],
    } } })
    const { wrapper, onImported } = mountControls()
    await selectImportFile(wrapper)

    expect(api.confirmWorkflowImport).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="workflow-import-confirm"]').trigger('click')
    await flushPromises()

    expect(api.confirmWorkflowImport).toHaveBeenCalledWith('preview-1', 'sha256:abc')
    expect(onImported).toHaveBeenCalledWith({ id: 'new-workflow' })
  })

  it('rejects invalid JSON locally without calling preview or confirmation', async () => {
    const { wrapper } = mountControls()
    const input = wrapper.get('input[type="file"]')
    const file = new File(['not-json'], 'bad.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { configurable: true, value: vi.fn().mockResolvedValue('not-json') })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
    expect(api.previewWorkflowImport).not.toHaveBeenCalled()
    expect(api.confirmWorkflowImport).not.toHaveBeenCalled()
  })
})
