import type { Context } from 'koa'
import { createHash, randomBytes } from 'crypto'
import { getWorkflowManager, validateWorkflowRunSafetyLimits, type WorkflowRerunFromNodeInput, type WorkflowRunNowInput, type WorkflowUpdateInput } from '../../services/workflow-manager'
import { listUserProfiles } from '../../db/hermes/users-store'
import {
  getWorkflowRun,
  listWorkflowRunEdgeEvaluations,
  listWorkflowRunLoopIterations,
  listWorkflowRunNodeExecutions,
  listWorkflowRunNodeSessions,
  listWorkflowRuns,
  type WorkflowRunRecord,
} from '../../db/hermes/workflow-run-store'
import { logger } from '../../services/logger'
import { collectWorkflowImportEnvironment, exportWorkflowDocument, inspectWorkflowImportDependencies, parseWorkflowImportDocument, type ParsedWorkflowImportDocument, type WorkflowImportPreview } from '../../services/workflow-portability'

const MAX_BATCH_DELETE = 200

function bodyRecord(ctx: Context): Record<string, unknown> {
  const body = ctx.request.body
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function profileName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default'
}

function requestedProfile(ctx: Context, body?: Record<string, unknown>): string | null {
  const bodyProfile = body && typeof body.profile === 'string' ? body.profile.trim() : ''
  const queryProfile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  const stateProfile = ctx.state?.profile?.name || ''
  return stateProfile || bodyProfile || queryProfile || null
}

function explicitListProfile(ctx: Context): string | null {
  const profile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  return profile || null
}

function allowedProfileSet(ctx: Context): Set<string> | null {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function canAccessProfile(ctx: Context, profile: string | null | undefined): boolean {
  const allowed = allowedProfileSet(ctx)
  return !allowed || allowed.has(profileName(profile))
}

function denyProfileAccess(ctx: Context, profile: string | null | undefined): boolean {
  if (canAccessProfile(ctx, profile)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${profileName(profile)}" is not available for this user` }
  return true
}

function filterByAllowedProfiles<T extends { profile: string }>(ctx: Context, items: T[]): T[] {
  const allowed = allowedProfileSet(ctx)
  if (!allowed) return items
  return items.filter(item => allowed.has(profileName(item.profile)))
}

function requiredId(ctx: Context): string | null {
  const id = typeof ctx.params?.id === 'string' ? ctx.params.id.trim() : ''
  if (id) return id
  ctx.status = 400
  ctx.body = { error: 'id is required' }
  return null
}

function optionalJsonArray(value: unknown, name: string): { value?: unknown[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value)) return { error: `${name} must be an array` }
  return { value }
}

function optionalNullableString(value: unknown, name: string): { value?: string | null; error?: string } {
  if (value === undefined) return {}
  if (value === null) return { value: null }
  if (typeof value !== 'string') return { error: `${name} must be a string` }
  return { value }
}

function optionalJsonObject(value: unknown, name: string): { value?: Record<string, unknown> | null; error?: string } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return { error: `${name} must be an object` }
  return { value: value as Record<string, unknown> }
}

function optionalStringArray(value: unknown, name: string): { value?: string[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value)) return { error: `${name} must be an array` }
  const strings = value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
  return { value: strings }
}

function rejectBadRequest(ctx: Context, error?: string): boolean {
  if (!error) return false
  ctx.status = 400
  ctx.body = { error }
  return true
}

function optionalPositiveNumber(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined || value === null) return {}
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return { error: `${name} must be a positive number` }
  return { value: numberValue }
}

function optionalBoolean(value: unknown, name: string): { value?: boolean; error?: string } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'boolean') return { value }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return { value: true }
    if (normalized === 'false') return { value: false }
  }
  return { error: `${name} must be a boolean` }
}


function portableFilename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'workflow'
  return `${safe}.workflow.json`
}

const IMPORT_PREVIEW_TTL_MS = 10 * 60 * 1000
const MAX_IMPORT_PREVIEWS = 256

interface ImportPreviewEntry {
  ownerKey: string
  profile: string
  parsed: ParsedWorkflowImportDocument
  preview: WorkflowImportPreview
  documentDigest: string
  expiresAt: number
}

const importPreviewEntries = new Map<string, ImportPreviewEntry>()

function controllerError(message: string, status: number, code: string): Error {
  const err = new Error(message)
  ;(err as any).status = status
  ;(err as any).code = code
  return err
}

function importOwnerKey(ctx: Context): string {
  const id = ctx.state?.user?.id
  return id === undefined || id === null ? 'anonymous' : `user:${String(id)}`
}

function importTargetProfile(ctx: Context, body: Record<string, unknown>): string {
  const bodyProfile = typeof body.profile === 'string' ? body.profile.trim() : ''
  const stateProfile = typeof ctx.state?.profile?.name === 'string' ? ctx.state.profile.name.trim() : ''
  const queryProfile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  if (body.profile !== undefined && !bodyProfile) {
    throw controllerError('profile must be a non-empty string', 400, 'invalid_profile')
  }
  if (bodyProfile && stateProfile && bodyProfile !== stateProfile) {
    throw controllerError('request profile does not match the authenticated profile context', 409, 'profile_mismatch')
  }
  const profile = stateProfile || bodyProfile || queryProfile
  if (!profile) throw controllerError('target profile is required', 400, 'profile_required')
  return profile
}

function cleanupImportPreviews(now = Date.now()): void {
  for (const [id, entry] of importPreviewEntries) {
    if (entry.expiresAt <= now) importPreviewEntries.delete(id)
  }
  while (importPreviewEntries.size >= MAX_IMPORT_PREVIEWS) {
    const oldest = importPreviewEntries.keys().next().value
    if (typeof oldest !== 'string') break
    importPreviewEntries.delete(oldest)
  }
}

function storeImportPreview(
  ctx: Context,
  document: unknown,
  result: { parsed: ParsedWorkflowImportDocument; preview: WorkflowImportPreview; profile: string },
): { previewId: string; documentDigest: string; expiresAt: number } {
  cleanupImportPreviews()
  const previewId = randomBytes(24).toString('base64url')
  const documentDigest = `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`
  const expiresAt = Date.now() + IMPORT_PREVIEW_TTL_MS
  importPreviewEntries.set(previewId, {
    ownerKey: importOwnerKey(ctx),
    profile: result.profile,
    parsed: result.parsed,
    preview: result.preview,
    documentDigest,
    expiresAt,
  })
  return { previewId, documentDigest, expiresAt }
}

async function buildImportPreview(ctx: Context, body: Record<string, unknown>) {
  const profile = importTargetProfile(ctx, body)
  if (denyProfileAccess(ctx, profile)) return null
  if (!Object.prototype.hasOwnProperty.call(body, 'document')) {
    throw controllerError('document is required', 400, 'document_required')
  }
  const parsed = parseWorkflowImportDocument(body.document)
  const environment = await collectWorkflowImportEnvironment(parsed, profile)
  return { parsed, preview: inspectWorkflowImportDependencies(parsed, environment), profile }
}

export async function exportDefinition(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return
  try {
    ctx.type = 'application/json'
    ctx.set('Content-Disposition', `attachment; filename="${portableFilename(workflow.name)}"`)
    ctx.body = exportWorkflowDocument(workflow)
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { error: err?.message || 'failed to export workflow' }
  }
}

export async function previewImport(ctx: Context) {
  const body = bodyRecord(ctx)
  try {
    const result = await buildImportPreview(ctx, body)
    if (!result) return
    const token = storeImportPreview(ctx, body.document, result)
    ctx.body = { ...token, preview: result.preview }
  } catch (err: any) {
    ctx.status = Number(err?.status) || 400
    ctx.body = { error: err?.message || 'failed to preview workflow import', ...(err?.code ? { code: err.code } : {}) }
  }
}

export async function confirmImport(ctx: Context) {
  const body = bodyRecord(ctx)
  try {
    if (body.confirmed !== true) throw controllerError('confirmed must be true', 400, 'confirmation_required')
    const unknown = Object.keys(body).filter(key => !['previewId', 'documentDigest', 'confirmed'].includes(key))
    if (unknown.length) throw controllerError(`workflow import confirmation contains unknown field: ${unknown.join(', ')}`, 400, 'invalid_confirmation')
    const previewId = typeof body.previewId === 'string' ? body.previewId.trim() : ''
    const documentDigest = typeof body.documentDigest === 'string' ? body.documentDigest.trim() : ''
    if (!previewId || !documentDigest) throw controllerError('previewId and documentDigest are required', 400, 'preview_required')
    cleanupImportPreviews()
    const entry = importPreviewEntries.get(previewId)
    if (!entry || entry.expiresAt <= Date.now()) {
      throw controllerError('workflow import preview is invalid or expired', 409, 'preview_invalid')
    }
    if (entry.ownerKey !== importOwnerKey(ctx)) {
      throw controllerError('workflow import preview does not belong to this user', 409, 'preview_invalid')
    }
    const stateProfile = typeof ctx.state?.profile?.name === 'string' ? ctx.state.profile.name.trim() : ''
    if (stateProfile && stateProfile !== entry.profile) {
      throw controllerError('workflow import preview target profile changed', 409, 'profile_mismatch')
    }
    if (documentDigest !== entry.documentDigest) {
      throw controllerError('workflow import document digest does not match the preview', 409, 'preview_invalid')
    }
    // Consume before any await so concurrent confirmations cannot create twice.
    importPreviewEntries.delete(previewId)
    if (!entry.preview.canImport) {
      throw controllerError('workflow import preview has unresolved dependencies', 409, 'preview_not_importable')
    }
    if (denyProfileAccess(ctx, entry.profile)) return
    const environment = await collectWorkflowImportEnvironment(entry.parsed, entry.profile)
    const currentPreview = inspectWorkflowImportDependencies(entry.parsed, environment)
    if (!currentPreview.canImport || JSON.stringify(currentPreview.missing) !== JSON.stringify(entry.preview.missing)) {
      ctx.status = 409
      ctx.body = { error: 'workflow import environment changed; preview again', code: 'preview_stale', preview: currentPreview }
      return
    }
    const definition = currentPreview.resolvedWorkflow
    const workflow = getWorkflowManager().create({
      name: definition.name,
      profile: entry.profile,
      workspace: null,
      nodes: definition.nodes,
      edges: definition.edges,
      viewport: definition.viewport,
    })
    ctx.status = 201
    ctx.body = { workflow, warnings: currentPreview.warnings }
  } catch (err: any) {
    ctx.status = Number(err?.status) || 400
    ctx.body = { error: err?.message || 'failed to import workflow', ...(err?.code ? { code: err.code } : {}) }
  }
}

export async function list(ctx: Context) {
  const profile = explicitListProfile(ctx)
  if (profile && denyProfileAccess(ctx, profile)) return
  const workflows = filterByAllowedProfiles(ctx, getWorkflowManager().list(profile))
  ctx.body = { workflows }
}

export async function get(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return
  ctx.body = { workflow }
}

function runWithEvidence(run: WorkflowRunRecord) {
  const base = { ...run, node_sessions: listWorkflowRunNodeSessions(run.id) }
  if (run.orchestration_version !== 2) return base
  return {
    ...base,
    node_executions: listWorkflowRunNodeExecutions(run.id),
    edge_evaluations: listWorkflowRunEdgeEvaluations(run.id),
    loop_iterations: listWorkflowRunLoopIterations(run.id),
  }
}

export async function getRun(ctx: Context) {
  const id = requiredId(ctx); if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) { ctx.status = 400; ctx.body = { error: 'runId is required' }; return }
  const workflow = getWorkflowManager().get(id)
  if (!workflow) { ctx.status = 404; ctx.body = { error: 'workflow not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  const run = getWorkflowRun(runId)
  if (!run || run.workflow_id !== id) { ctx.status = 404; ctx.body = { error: 'workflow run not found' }; return }
  ctx.body = { run: runWithEvidence(run) }
}

export async function listRuns(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const limitValue = firstQueryValue(ctx.query.limit as string | string[] | undefined)
  const limit = limitValue ? Number(limitValue) : 100
  const runs = listWorkflowRuns(id, Number.isFinite(limit) ? limit : 100)
  ctx.body = {
    runs: runs.map(runWithEvidence),
  }
}

export async function stopRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const run = await getWorkflowManager().stopRun(id, runId, 'Workflow run canceled by user')
  if (!run) {
    ctx.status = 404
    ctx.body = { error: 'workflow run not found' }
    return
  }
  ctx.body = { ok: true, run }
}

export async function deleteRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const deleted = await getWorkflowManager().deleteRun(id, runId)
  if (!deleted) {
    ctx.status = 404
    ctx.body = { error: 'workflow run not found' }
    return
  }
  ctx.body = { ok: true }
}

export async function rerunFromNode(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const body = bodyRecord(ctx)
  const nodeId = typeof (body.node_id ?? body.nodeId) === 'string' ? String(body.node_id ?? body.nodeId).trim() : ''
  if (!nodeId) {
    ctx.status = 400
    ctx.body = { error: 'node_id is required' }
    return
  }
  const preserveStartNode = optionalBoolean(body.preserve_start_node ?? body.preserveStartNode, 'preserve_start_node')
  const timeoutMs = optionalPositiveNumber(body.timeout_ms ?? body.timeoutMs, 'timeout_ms')
  if (rejectBadRequest(ctx, preserveStartNode.error || timeoutMs.error)) return

  const runInput: WorkflowRerunFromNodeInput = {
    profile: workflow.profile,
    user: ctx.state?.user,
  }
  if (preserveStartNode.value !== undefined) runInput.preserveStartNode = preserveStartNode.value
  if (timeoutMs.value !== undefined) runInput.timeoutMs = timeoutMs.value

  const manager = getWorkflowManager()
  try {
    manager.validateRerunFromNode(id, runId)
    await manager.preflightRerunFromNode(id, runId, nodeId, runInput)
  } catch (err: any) {
    ctx.status = Number.isFinite(err?.status) ? err.status : 500
    ctx.body = { error: err?.message || 'failed to rerun workflow' }
    return
  }
  void manager.rerunFromNode(id, runId, nodeId, runInput).catch((err: any) => {
    const message = err?.message || 'failed to rerun workflow'
    logger.error(err, '[workflow] async rerun failed for workflow %s run %s node %s', id, runId, nodeId)
    manager.setRuntimeStatus(id, {
      status: 'failed',
      runId,
      completedAt: Date.now(),
      error: message,
    })
  })

  ctx.status = 202
  ctx.body = { ok: true, status: 'accepted' }
}

export async function create(ctx: Context) {
  const body = bodyRecord(ctx)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'name is required' }
    return
  }

  const profile = requestedProfile(ctx, body) || 'default'
  if (denyProfileAccess(ctx, profile)) return

  const workspace = optionalNullableString(body.workspace, 'workspace')
  const nodes = optionalJsonArray(body.nodes, 'nodes')
  const edges = optionalJsonArray(body.edges, 'edges')
  const viewport = optionalJsonObject(body.viewport, 'viewport')
  if (rejectBadRequest(ctx, workspace.error || nodes.error || edges.error || viewport.error)) return

  try {
    const workflow = getWorkflowManager().create({
      name,
      profile,
      workspace: workspace.value,
      nodes: nodes.value || [],
      edges: edges.value || [],
      viewport: viewport.value || null,
    })
    ctx.status = 201
    ctx.body = { workflow }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'failed to create workflow' }
  }
}

export async function update(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const existing = getWorkflowManager().get(id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, existing.profile)) return

  const body = bodyRecord(ctx)
  const patch: WorkflowUpdateInput = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      ctx.status = 400
      ctx.body = { error: 'name must be a non-empty string' }
      return
    }
    patch.name = body.name
  }
  const workspace = optionalNullableString(body.workspace, 'workspace')
  const nodes = optionalJsonArray(body.nodes, 'nodes')
  const edges = optionalJsonArray(body.edges, 'edges')
  const viewport = optionalJsonObject(body.viewport, 'viewport')
  if (rejectBadRequest(ctx, workspace.error || nodes.error || edges.error || viewport.error)) return
  if (workspace.value !== undefined) patch.workspace = workspace.value
  if (nodes.value !== undefined) patch.nodes = nodes.value
  if (edges.value !== undefined) patch.edges = edges.value
  if (viewport.value !== undefined) patch.viewport = viewport.value

  const workflow = getWorkflowManager().update(id, patch)
  ctx.body = { workflow }
}

export async function remove(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  await getWorkflowManager().delete(id)
  ctx.body = { ok: true }
}

export async function batchRemove(ctx: Context) {
  const body = bodyRecord(ctx)
  const ids = Array.isArray(body.ids)
    ? body.ids.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean)
    : []
  if (ids.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required' }
    return
  }
  if (ids.length > MAX_BATCH_DELETE) {
    ctx.status = 400
    ctx.body = { error: `ids must contain at most ${MAX_BATCH_DELETE} items` }
    return
  }

  const uniqueIds = [...new Set(ids)]
  const errors: Array<{ id: string; error: string }> = []
  let deleted = 0
  for (const id of uniqueIds) {
    const workflow = getWorkflowManager().get(id)
    if (!workflow) {
      errors.push({ id, error: 'workflow not found' })
      continue
    }
    if (!canAccessProfile(ctx, workflow.profile)) {
      errors.push({ id, error: `Profile "${profileName(workflow.profile)}" is not available for this user` })
      continue
    }
    if (await getWorkflowManager().delete(id)) deleted += 1
    else errors.push({ id, error: 'workflow not found' })
  }

  ctx.body = {
    deleted,
    failed: errors.length,
    errors,
  }
}

export async function runNow(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const body = bodyRecord(ctx)
  const startNodeIds = optionalStringArray(body.start_node_ids ?? body.startNodeIds, 'start_node_ids')
  const input = optionalNullableString(body.input, 'input')
  const timeoutMs = optionalPositiveNumber(body.timeout_ms ?? body.timeoutMs, 'timeout_ms')
  const totalTimeoutMs = optionalPositiveNumber(body.total_timeout_ms ?? body.totalTimeoutMs, 'total_timeout_ms')
  const executionBudget = optionalPositiveNumber(body.execution_budget ?? body.executionBudget, 'execution_budget')
  if (rejectBadRequest(ctx, startNodeIds.error || input.error || timeoutMs.error || totalTimeoutMs.error || executionBudget.error)) return

  const runInput: WorkflowRunNowInput = {
    profile: workflow.profile,
    user: ctx.state?.user,
  }
  if (startNodeIds.value !== undefined) runInput.startNodeIds = startNodeIds.value
  if (input.value !== undefined) runInput.input = input.value
  if (timeoutMs.value !== undefined) runInput.timeoutMs = timeoutMs.value
  if (totalTimeoutMs.value !== undefined) runInput.totalTimeoutMs = totalTimeoutMs.value
  if (executionBudget.value !== undefined) runInput.executionBudget = executionBudget.value
  if (runInput.totalTimeoutMs !== undefined || runInput.executionBudget !== undefined) {
    try {
      validateWorkflowRunSafetyLimits(runInput)
    } catch (err: any) {
      ctx.status = Number(err?.status) || 400
      ctx.body = { error: err?.message || 'invalid workflow run safety limits' }
      return
    }
  }

  const manager = getWorkflowManager()
  let prepared
  try {
    prepared = manager.prepareRun(id, runInput.startNodeIds)
  } catch (err: any) {
    ctx.status = Number(err?.status) || 400
    ctx.body = { error: err?.message || 'invalid workflow graph' }
    return
  }
  try {
    await manager.preflightPreparedRun(prepared, runInput)
  } catch (err: any) {
    ctx.status = Number(err?.status) || 400
    ctx.body = { error: err?.message || 'workflow run preflight failed' }
    return
  }
  void manager.runPrepared(prepared, runInput).catch((err: any) => {
    const message = err?.message || 'failed to run workflow'
    logger.error(err, '[workflow] async run failed for workflow %s', id)
    manager.setRuntimeStatus(id, {
      status: 'failed',
      completedAt: Date.now(),
      error: message,
    })
  })

  ctx.status = 202
  ctx.body = { ok: true, status: 'accepted' }
}
