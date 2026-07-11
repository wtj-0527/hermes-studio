// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import WorkflowAgentNode from '@/components/hermes/workflow/WorkflowAgentNode.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/api/hermes/files', () => ({ getFileDownloadUrl: (path: string) => path }))
vi.mock('@vue-flow/core', () => ({
  Handle: defineComponent({ template: '<div />' }),
  Position: { Left: 'left', Right: 'right' },
}))
vi.mock('@vue-flow/node-resizer', () => ({ NodeResizer: defineComponent({ template: '<div />' }) }))
vi.mock('naive-ui', () => ({
  NInput: defineComponent({
    props: ['value'], emits: ['update:value'],
    template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NTooltip: defineComponent({ template: '<div><slot name="trigger" /><slot /></div>' }),
  NSelect: defineComponent({
    inheritAttrs: false,
    props: ['value', 'options'], emits: ['update:value'],
    template: `<div v-bind="$attrs" class="n-select-stub">
      <button v-for="option in options" :key="option.value" type="button"
        :data-value="option.value" @click="$emit('update:value', option.value)">{{ option.label }}</button>
    </div>`,
  }),
  useMessage: () => ({ error: vi.fn() }),
}))
vi.mock('@/components/hermes/workflow/WorkflowModelSelector.vue', () => ({
  default: defineComponent({ template: '<div class="model-selector-stub" />' }),
}))

function mountNode(onUpdate = vi.fn()) {
  return {
    onUpdate,
    wrapper: mount(WorkflowAgentNode, {
      props: {
        id: 'node-1', type: 'agent', selected: false, dragging: false, connectable: true,
        positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 1,
        data: {
          title: 'Node 1', agent: 'hermes', provider: 'custom:test', model: 'gpt-5.6-sol',
          apiMode: 'codex_responses', reasoningEffort: '', input: 'work', skills: [], images: [],
          joinMode: 'all', status: 'idle', agentOptions: [], skillOptions: [], skillsLoading: false,
          modelGroups: [], onUpdate, onUploadImages: vi.fn().mockResolvedValue([]),
        },
      } as any,
    }),
  }
}

describe('workflow node reasoning effort UI', () => {
  it('offers every canonical effort including maximum and a default override', () => {
    const { wrapper } = mountNode()
    const selector = wrapper.get('[data-testid="workflow-reasoning-effort"]')
    expect(selector.findAll('button').map(button => button.attributes('data-value'))).toEqual([
      '', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })

  it('updates the node with the exact max wire value', async () => {
    const { wrapper, onUpdate } = mountNode()
    await wrapper.get('[data-testid="workflow-reasoning-effort"] [data-value="max"]').trigger('click')
    expect(onUpdate).toHaveBeenCalledWith('node-1', { reasoningEffort: 'max' })
  })
})
