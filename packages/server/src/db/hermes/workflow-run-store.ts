import { randomUUID } from 'crypto'
import { getDb, jsonDelete, jsonGet, jsonGetAll, jsonSet } from '../index'
import { WORKFLOW_RUN_EDGE_RESULTS_TABLE, WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUNS_TABLE } from './schemas'

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type WorkflowRunNodeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped' | 'canceled'
export type WorkflowRunEdgeResultStatus = 'taken' | 'not_taken' | 'error'

export interface WorkflowRunRecord {
  id: string
  workflow_id: string
  profile: string
  workspace: string | null
  start_node_ids: string[]
  status: WorkflowRunStatus
  snapshot_nodes: unknown[]
  snapshot_edges: unknown[]
  started_at: number | null
  finished_at: number | null
  created_at: number
  error: string | null
  edge_results: WorkflowRunEdgeResultRecord[]
  node_states: Record<string, WorkflowRunNodeState>
}

export interface WorkflowRunNodeState { status: WorkflowRunNodeStatus; reason?: string; started_at: number | null; finished_at: number | null }

export interface WorkflowRunEdgeResultRecord {
  id: string
  run_id: string
  workflow_id: string
  edge_id: string
  source_node_id: string
  target_node_id: string
  status: WorkflowRunEdgeResultStatus
  reason: string
  context: Record<string, unknown>
  sequence: number
  evaluated_at: number
  created_at: number
}

export interface WorkflowRunNodeSessionRecord {
  id: string
  run_id: string
  workflow_id: string
  node_id: string
  session_id: string
  profile: string
  agent: string
  agent_mode: string
  status: WorkflowRunNodeStatus
  sequence: number
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
  error: string | null
}

function profileName(value?: string | null): string {
  return value?.trim() || 'default'
}

function parseArrayJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function rowToRunRecord(row: Record<string, any>): WorkflowRunRecord {
  return {
    id: String(row.id || ''),
    workflow_id: String(row.workflow_id || ''),
    profile: profileName(row.profile),
    workspace: row.workspace == null || row.workspace === '' ? null : String(row.workspace),
    start_node_ids: parseArrayJson(row.start_node_ids_json ?? row.start_node_ids).map(String),
    status: String(row.status || 'queued') as WorkflowRunStatus,
    snapshot_nodes: parseArrayJson(row.snapshot_nodes_json ?? row.snapshot_nodes),
    snapshot_edges: parseArrayJson(row.snapshot_edges_json ?? row.snapshot_edges),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at || 0),
    error: row.error == null || row.error === '' ? null : String(row.error),
    edge_results: [],
    node_states: parseObjectJson(row.node_states_json ?? row.node_states) as Record<string, WorkflowRunNodeState>,
  }
}

function parseObjectJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function rowToEdgeResultRecord(row: Record<string, any>): WorkflowRunEdgeResultRecord {
  return {
    id: String(row.id || ''),
    run_id: String(row.run_id || ''),
    workflow_id: String(row.workflow_id || ''),
    edge_id: String(row.edge_id || ''),
    source_node_id: String(row.source_node_id || ''),
    target_node_id: String(row.target_node_id || ''),
    status: String(row.status || 'not_taken') as WorkflowRunEdgeResultStatus,
    reason: String(row.reason || ''),
    context: parseObjectJson(row.context_json ?? row.context),
    sequence: Number(row.sequence || 0),
    evaluated_at: Number(row.evaluated_at || 0),
    created_at: Number(row.created_at || 0),
  }
}

function rowToNodeSessionRecord(row: Record<string, any>): WorkflowRunNodeSessionRecord {
  return {
    id: String(row.id || ''),
    run_id: String(row.run_id || ''),
    workflow_id: String(row.workflow_id || ''),
    node_id: String(row.node_id || ''),
    session_id: String(row.session_id || ''),
    profile: profileName(row.profile),
    agent: String(row.agent || ''),
    agent_mode: String(row.agent_mode || ''),
    status: String(row.status || 'queued') as WorkflowRunNodeStatus,
    sequence: Number(row.sequence || 0),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    error: row.error == null || row.error === '' ? null : String(row.error),
  }
}

export function createWorkflowRun(input: {
  id?: string
  workflow_id: string
  profile?: string | null
  workspace?: string | null
  start_node_ids?: string[]
  status?: WorkflowRunStatus
  snapshot_nodes?: unknown[]
  snapshot_edges?: unknown[]
  started_at?: number | null
  error?: string | null
}): WorkflowRunRecord {
  const now = Date.now()
  const record: WorkflowRunRecord = {
    id: input.id?.trim() || randomUUID(),
    workflow_id: input.workflow_id,
    profile: profileName(input.profile),
    workspace: input.workspace?.trim() || null,
    start_node_ids: input.start_node_ids || [],
    status: input.status || 'queued',
    snapshot_nodes: input.snapshot_nodes || [],
    snapshot_edges: input.snapshot_edges || [],
    started_at: input.started_at ?? null,
    finished_at: null,
    created_at: now,
    error: input.error || null,
    edge_results: [],
    node_states: {},
  }
  const row = {
    id: record.id,
    workflow_id: record.workflow_id,
    profile: record.profile,
    workspace: record.workspace,
    start_node_ids_json: JSON.stringify(record.start_node_ids),
    status: record.status,
    snapshot_nodes_json: JSON.stringify(record.snapshot_nodes),
    snapshot_edges_json: JSON.stringify(record.snapshot_edges),
    node_states_json: JSON.stringify(record.node_states),
    started_at: record.started_at,
    finished_at: record.finished_at,
    created_at: record.created_at,
    error: record.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, record.id, row as any)
    return record
  }
  db.prepare(`
    INSERT INTO ${WORKFLOW_RUNS_TABLE} (
      id, workflow_id, profile, workspace, start_node_ids_json, status,
      snapshot_nodes_json, snapshot_edges_json, node_states_json, started_at, finished_at, created_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.workflow_id,
    row.profile,
    row.workspace,
    row.start_node_ids_json,
    row.status,
    row.snapshot_nodes_json,
    row.snapshot_edges_json,
    row.node_states_json,
    row.started_at,
    row.finished_at,
    row.created_at,
    row.error,
  )
  return record
}

export function updateWorkflowRun(id: string, patch: {
  status?: WorkflowRunStatus
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunRecord | null {
  const existing = getWorkflowRun(id)
  if (!existing) return null
  const next: WorkflowRunRecord = {
    ...existing,
    status: patch.status ?? existing.status,
    started_at: patch.started_at === undefined ? existing.started_at : patch.started_at,
    finished_at: patch.finished_at === undefined ? existing.finished_at : patch.finished_at,
    error: patch.error === undefined ? existing.error : patch.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, id, {
      ...next,
      start_node_ids_json: JSON.stringify(next.start_node_ids),
      snapshot_nodes_json: JSON.stringify(next.snapshot_nodes),
      snapshot_edges_json: JSON.stringify(next.snapshot_edges),
      node_states_json: JSON.stringify(next.node_states),
    } as any)
    return next
  }
  db.prepare(`
    UPDATE ${WORKFLOW_RUNS_TABLE}
    SET status = ?, started_at = ?, finished_at = ?, error = ?
    WHERE id = ?
  `).run(next.status, next.started_at, next.finished_at, next.error, id)
  return next
}

export function updateWorkflowRunNodeState(id: string, nodeId: string, state: WorkflowRunNodeState): WorkflowRunRecord | null {
  const existing = getWorkflowRun(id); if (!existing) return null
  const nodeStates = { ...existing.node_states, [nodeId]: state }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, id, { ...existing, node_states: nodeStates, node_states_json: JSON.stringify(nodeStates), start_node_ids_json: JSON.stringify(existing.start_node_ids), snapshot_nodes_json: JSON.stringify(existing.snapshot_nodes), snapshot_edges_json: JSON.stringify(existing.snapshot_edges) } as any)
  } else db.prepare(`UPDATE ${WORKFLOW_RUNS_TABLE} SET node_states_json = ? WHERE id = ?`).run(JSON.stringify(nodeStates), id)
  return { ...existing, node_states: nodeStates }
}

export function getWorkflowRun(id: string): WorkflowRunRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOW_RUNS_TABLE, id)
    if (!row) return null
    const record = rowToRunRecord(row)
    record.edge_results = listWorkflowRunEdgeResults(record.id)
    return record
  }
  const row = db.prepare(`SELECT * FROM ${WORKFLOW_RUNS_TABLE} WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!row) return null
  const record = rowToRunRecord(row)
  record.edge_results = listWorkflowRunEdgeResults(record.id)
  return record
}

export function deleteWorkflowRun(id: string): boolean {
  const existing = getWorkflowRun(id)
  if (!existing) return false
  const db = getDb()
  if (!db) {
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_EDGE_RESULTS_TABLE)).map(rowToEdgeResultRecord)) {
      if (record.run_id === id) jsonDelete(WORKFLOW_RUN_EDGE_RESULTS_TABLE, record.id)
    }
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE)).map(rowToNodeSessionRecord)) {
      if (record.run_id === id) jsonDelete(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id)
    }
    jsonDelete(WORKFLOW_RUNS_TABLE, id)
    return true
  }
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_EDGE_RESULTS_TABLE} WHERE run_id = ?`).run(id)
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} WHERE run_id = ?`).run(id)
    db.prepare(`DELETE FROM ${WORKFLOW_RUNS_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return true
}

export function listWorkflowRuns(workflowId?: string | null, limit = 100): WorkflowRunRecord[] {
  const normalizedWorkflowId = workflowId?.trim() || ''
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 100))
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUNS_TABLE))
      .map(rowToRunRecord)
      .map(record => ({ ...record, edge_results: listWorkflowRunEdgeResults(record.id) }))
      .filter(record => !normalizedWorkflowId || record.workflow_id === normalizedWorkflowId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, safeLimit)
  }
  if (normalizedWorkflowId) {
    const rows = db.prepare(`
      SELECT * FROM ${WORKFLOW_RUNS_TABLE}
      WHERE workflow_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(normalizedWorkflowId, safeLimit) as Record<string, any>[]
    return rows.map(rowToRunRecord).map(record => ({ ...record, edge_results: listWorkflowRunEdgeResults(record.id) }))
  }
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUNS_TABLE}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit) as Record<string, any>[]
  return rows.map(rowToRunRecord).map(record => ({ ...record, edge_results: listWorkflowRunEdgeResults(record.id) }))
}

export function createWorkflowRunEdgeResult(input: {
  id?: string
  run_id: string
  workflow_id: string
  edge_id: string
  source_node_id: string
  target_node_id: string
  status: WorkflowRunEdgeResultStatus
  reason: string
  context: Record<string, unknown>
  sequence?: number
  evaluated_at?: number
}): WorkflowRunEdgeResultRecord {
  const now = Date.now()
  const record: WorkflowRunEdgeResultRecord = {
    id: input.id?.trim() || randomUUID(),
    run_id: input.run_id, workflow_id: input.workflow_id, edge_id: input.edge_id,
    source_node_id: input.source_node_id, target_node_id: input.target_node_id,
    status: input.status, reason: input.reason, context: input.context,
    sequence: input.sequence || 0, evaluated_at: input.evaluated_at ?? now, created_at: now,
  }
  const db = getDb()
  if (!db) {
    const existing = listWorkflowRunEdgeResults(record.run_id).find(item => item.edge_id === record.edge_id)
    if (existing) jsonDelete(WORKFLOW_RUN_EDGE_RESULTS_TABLE, existing.id)
    jsonSet(WORKFLOW_RUN_EDGE_RESULTS_TABLE, record.id, { ...record, context_json: JSON.stringify(record.context) } as any)
    return record
  }
  db.prepare(`DELETE FROM ${WORKFLOW_RUN_EDGE_RESULTS_TABLE} WHERE run_id = ? AND edge_id = ?`).run(record.run_id, record.edge_id)
  db.prepare(`INSERT INTO ${WORKFLOW_RUN_EDGE_RESULTS_TABLE} (
    id, run_id, workflow_id, edge_id, source_node_id, target_node_id, status, reason, context_json, sequence, evaluated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(record.id, record.run_id, record.workflow_id, record.edge_id, record.source_node_id, record.target_node_id,
    record.status, record.reason, JSON.stringify(record.context), record.sequence, record.evaluated_at, record.created_at)
  return record
}

export function listWorkflowRunEdgeResults(runId: string): WorkflowRunEdgeResultRecord[] {
  const db = getDb()
  if (!db) return Object.values(jsonGetAll(WORKFLOW_RUN_EDGE_RESULTS_TABLE)).map(rowToEdgeResultRecord)
    .filter(record => record.run_id === runId).sort((a, b) => a.sequence - b.sequence)
  return (db.prepare(`SELECT * FROM ${WORKFLOW_RUN_EDGE_RESULTS_TABLE} WHERE run_id = ? ORDER BY sequence ASC`).all(runId) as Record<string, any>[])
    .map(rowToEdgeResultRecord)
}

export function deleteWorkflowRunEdgeResults(runId: string, sourceNodeIds?: string[]): WorkflowRunEdgeResultRecord[] {
  const sourceSet = sourceNodeIds ? new Set(sourceNodeIds) : null
  const records = listWorkflowRunEdgeResults(runId).filter(record => !sourceSet || sourceSet.has(record.source_node_id))
  const db = getDb()
  if (!db) {
    for (const record of records) jsonDelete(WORKFLOW_RUN_EDGE_RESULTS_TABLE, record.id)
  } else if (sourceSet) {
    for (const record of records) db.prepare(`DELETE FROM ${WORKFLOW_RUN_EDGE_RESULTS_TABLE} WHERE id = ?`).run(record.id)
  } else {
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_EDGE_RESULTS_TABLE} WHERE run_id = ?`).run(runId)
  }
  return records
}

export function createWorkflowRunNodeSession(input: {
  id?: string
  run_id: string
  workflow_id: string
  node_id: string
  session_id: string
  profile?: string | null
  agent?: string | null
  agent_mode?: string | null
  status?: WorkflowRunNodeStatus
  sequence?: number
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunNodeSessionRecord {
  const now = Date.now()
  const record: WorkflowRunNodeSessionRecord = {
    id: input.id?.trim() || randomUUID(),
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    node_id: input.node_id,
    session_id: input.session_id,
    profile: profileName(input.profile),
    agent: input.agent?.trim() || '',
    agent_mode: input.agent_mode?.trim() || '',
    status: input.status || 'queued',
    sequence: input.sequence || 0,
    started_at: input.started_at ?? null,
    finished_at: input.finished_at ?? null,
    created_at: now,
    updated_at: now,
    error: input.error || null,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id, record as any)
    return record
  }
  db.prepare(`
    INSERT INTO ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} (
      id, run_id, workflow_id, node_id, session_id, profile, agent, agent_mode,
      status, sequence, started_at, finished_at, created_at, updated_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.workflow_id,
    record.node_id,
    record.session_id,
    record.profile,
    record.agent,
    record.agent_mode,
    record.status,
    record.sequence,
    record.started_at,
    record.finished_at,
    record.created_at,
    record.updated_at,
    record.error,
  )
  return record
}

export function updateWorkflowRunNodeSession(id: string, patch: {
  status?: WorkflowRunNodeStatus
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunNodeSessionRecord | null {
  const existing = getWorkflowRunNodeSession(id)
  if (!existing) return null
  const next: WorkflowRunNodeSessionRecord = {
    ...existing,
    status: patch.status ?? existing.status,
    started_at: patch.started_at === undefined ? existing.started_at : patch.started_at,
    finished_at: patch.finished_at === undefined ? existing.finished_at : patch.finished_at,
    updated_at: Date.now(),
    error: patch.error === undefined ? existing.error : patch.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, id, next as any)
    return next
  }
  db.prepare(`
    UPDATE ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, error = ?
    WHERE id = ?
  `).run(next.status, next.started_at, next.finished_at, next.updated_at, next.error, id)
  return next
}

export function getWorkflowRunNodeSession(id: string): WorkflowRunNodeSessionRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, id)
    return row ? rowToNodeSessionRecord(row) : null
  }
  const row = db.prepare(`SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToNodeSessionRecord(row) : null
}

export function listWorkflowRunNodeSessions(runId: string): WorkflowRunNodeSessionRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE))
      .map(rowToNodeSessionRecord)
      .filter(record => record.run_id === runId)
      .sort((a, b) => a.sequence - b.sequence)
  }
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ?
    ORDER BY sequence ASC
  `).all(runId) as Record<string, any>[]
  return rows.map(rowToNodeSessionRecord)
}

export function deleteWorkflowRunNodeSessions(runId: string, nodeIds: string[]): WorkflowRunNodeSessionRecord[] {
  const normalizedRunId = runId.trim()
  const nodeIdSet = new Set(nodeIds.map(id => id.trim()).filter(Boolean))
  if (!normalizedRunId || nodeIdSet.size === 0) return []

  const db = getDb()
  if (!db) {
    const deleted: WorkflowRunNodeSessionRecord[] = []
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE)).map(rowToNodeSessionRecord)) {
      if (record.run_id !== normalizedRunId || !nodeIdSet.has(record.node_id)) continue
      deleted.push(record)
      jsonDelete(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id)
    }
    return deleted.sort((a, b) => a.sequence - b.sequence)
  }

  const placeholders = [...nodeIdSet].map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ? AND node_id IN (${placeholders})
    ORDER BY sequence ASC
  `).all(normalizedRunId, ...nodeIdSet) as Record<string, any>[]
  db.prepare(`
    DELETE FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ? AND node_id IN (${placeholders})
  `).run(normalizedRunId, ...nodeIdSet)
  return rows.map(rowToNodeSessionRecord)
}
