<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NModal, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  confirmWorkflowImport,
  exportWorkflowDefinition,
  previewWorkflowImport,
  type WorkflowImportPreview,
  type WorkflowImportPreviewToken,
  type WorkflowRecord,
} from '@/api/hermes/workflows'

const props = defineProps<{
  workflowId: string
  workflowName: string
  profile: string
}>()

const emit = defineEmits<{
  imported: [workflow: WorkflowRecord]
}>()

const { t } = useI18n()
const message = useMessage()
const fileInput = ref<HTMLInputElement | null>(null)
const exporting = ref(false)
const previewing = ref(false)
const importing = ref(false)
const previewVisible = ref(false)
const importToken = ref<WorkflowImportPreviewToken | null>(null)
const preview = ref<WorkflowImportPreview | null>(null)
const localError = ref('')

const missingRows = computed(() => {
  const missing = preview.value?.missing
  if (!missing) return []
  return [
    ...missing.profiles.map(value => ({ type: t('workflow.portability.profiles'), value })),
    ...missing.agents.map(value => ({ type: t('workflow.portability.agents'), value })),
    ...missing.providers.map(value => ({ type: t('workflow.portability.providers'), value })),
    ...missing.models.map(value => ({ type: t('workflow.portability.models'), value: `${value.provider} / ${value.model} / ${value.apiMode}` })),
    ...missing.skills.map(value => ({ type: t('workflow.portability.skills'), value: `${value.agent} / ${value.name}` })),
  ]
})

function safeFilename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'workflow'
  return `${safe}.workflow.json`
}

async function exportDefinition() {
  if (!props.workflowId || exporting.value) return
  exporting.value = true
  try {
    const document = await exportWorkflowDefinition(props.workflowId)
    const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = safeFilename(props.workflowName)
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    message.error(err?.message || t('workflow.portability.exportFailed'))
  } finally {
    exporting.value = false
  }
}

function openImportPicker() {
  if (previewing.value || importing.value) return
  fileInput.value?.click()
}

function closePreview() {
  previewVisible.value = false
  importToken.value = null
  preview.value = null
  localError.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

function readImportFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error(t('workflow.portability.invalidJson')))
    reader.readAsText(file)
  })
}

async function handleImportFile(event: Event) {
  const input = event.target instanceof HTMLInputElement ? event.target : null
  const file = input?.files?.[0]
  if (!file) return
  previewVisible.value = true
  preview.value = null
  localError.value = ''
  importToken.value = null
  previewing.value = true
  try {
    if (file.size > 1_048_576) throw new Error(t('workflow.portability.tooLarge'))
    const document = JSON.parse(await readImportFile(file))
    const result = await previewWorkflowImport(document, props.profile)
    importToken.value = result
    preview.value = result.preview
  } catch (err: any) {
    localError.value = err?.message || t('workflow.portability.invalidJson')
  } finally {
    previewing.value = false
  }
}

async function confirmImport() {
  if (!preview.value?.canImport || !importToken.value || importing.value) return
  importing.value = true
  try {
    const result = await confirmWorkflowImport(importToken.value.previewId, importToken.value.documentDigest)
    emit('imported', result.workflow)
    message.success(t('workflow.portability.imported'))
    closePreview()
  } catch (err: any) {
    localError.value = err?.message || t('workflow.portability.importFailed')
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="workflow-portability-controls">
    <input
      ref="fileInput"
      class="workflow-import-file"
      type="file"
      accept="application/json,.json"
      @change="handleImportFile"
    >
    <NButton
      data-testid="workflow-export"
      quaternary
      size="small"
      :loading="exporting"
      :disabled="!workflowId"
      :aria-label="t('workflow.portability.export')"
      @click="exportDefinition"
    >
      {{ t('workflow.portability.export') }}
    </NButton>
    <NButton
      data-testid="workflow-import"
      quaternary
      size="small"
      :loading="previewing"
      :aria-label="t('workflow.portability.import')"
      @click="openImportPicker"
    >
      {{ t('workflow.portability.import') }}
    </NButton>

    <NModal
      :show="previewVisible"
      preset="card"
      :title="t('workflow.portability.previewTitle')"
      style="width: min(640px, 92vw)"
      @update:show="value => { if (!value) closePreview() }"
    >
      <div v-if="previewing" class="portability-state">{{ t('common.loading') }}</div>
      <div v-else-if="localError" class="portability-error">{{ localError }}</div>
      <template v-else-if="preview">
        <div class="portability-name">{{ preview.resolvedWorkflow.name }}</div>
        <div v-if="missingRows.length" class="portability-section">
          <strong>{{ t('workflow.portability.missing') }}</strong>
          <ul>
            <li v-for="row in missingRows" :key="`${row.type}:${row.value}`">
              {{ row.type }}: {{ row.value }}
            </li>
          </ul>
        </div>
        <div v-if="preview.warnings.length" class="portability-section">
          <strong>{{ t('workflow.portability.warnings') }}</strong>
          <ul>
            <li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </div>
        <div class="portability-inactive">{{ t('workflow.portability.inactiveNotice') }}</div>
      </template>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="closePreview">{{ t('common.cancel') }}</NButton>
          <NButton
            data-testid="workflow-import-confirm"
            type="primary"
            :loading="importing"
            :disabled="!preview?.canImport || !importToken"
            @click="confirmImport"
          >
            {{ t('workflow.portability.confirmImport') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
.workflow-portability-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.workflow-import-file { display: none; }
.portability-state,
.portability-error,
.portability-name,
.portability-section,
.portability-inactive { margin-bottom: 12px; }
.portability-error { color: var(--error-color, #dc2626); }
.portability-section ul { margin: 8px 0 0; padding-left: 20px; }
.portability-inactive { color: var(--text-color-3); }
</style>
