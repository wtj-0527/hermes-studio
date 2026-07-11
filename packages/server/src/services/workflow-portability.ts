import type { WorkflowRecord } from '../db/hermes/workflow-store'
import { compileWorkflowGraph, normalizeWorkflowEdgeOrchestration, normalizeWorkflowJoinMode } from './workflow-orchestration'
import { normalizeReasoningEffort } from '../../../shared/reasoning-effort'
import { listProfileNamesFromDisk } from './hermes/hermes-profile'
import { getCodingAgentsStatus } from './coding-agents'
import { getAvailableModelReferencesForProfile } from '../controllers/hermes/models'
import { resolveWorkflowSkillContent } from './workflow-skill-resolver'

export const WORKFLOW_DOCUMENT_SCHEMA = 'hermes-studio.workflow' as const
export const WORKFLOW_DOCUMENT_VERSION = 1 as const
export const MAX_WORKFLOW_DOCUMENT_BYTES = 1_048_576
export const MAX_WORKFLOW_DOCUMENT_DEPTH = 20
export const MAX_WORKFLOW_DOCUMENT_NODES = 500
export const MAX_WORKFLOW_DOCUMENT_EDGES = 2_000

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|cookie|credential|password|passwd|secret|session[_-]?id|run[_-]?id|token)$/i
const ENVELOPE_KEYS = new Set(['schema', 'version', 'workflow', 'dependencies'])
const WORKFLOW_KEYS = new Set(['name', 'profileHint', 'workspaceHint', 'nodes', 'edges', 'viewport'])
const NODE_KEYS = new Set(['id', 'type', 'position', 'dragHandle', 'style', 'data'])
const NODE_DATA_KEYS = new Set([
  'title', 'agent', 'provider', 'model', 'apiMode', 'reasoningEffort', 'input', 'skills', 'images', 'orchestration',
])
const EDGE_KEYS = new Set([
  'id', 'source', 'target', 'sourceHandle', 'targetHandle', 'type', 'animated', 'markerEnd', 'label', 'data',
])
const AGENTS = new Set(['hermes', 'codex', 'claude-code'])

type PortableModelDependency = { provider: string; model: string; apiMode: string }
type PortableSkillDependency = { agent: string; name: string }

export interface WorkflowDocumentDependencies {
  agents: string[]
  providers: string[]
  models: PortableModelDependency[]
  skills: PortableSkillDependency[]
}

export interface WorkflowPortableDocument {
  schema: typeof WORKFLOW_DOCUMENT_SCHEMA
  version: typeof WORKFLOW_DOCUMENT_VERSION
  workflow: {
    name: string
    profileHint: string | null
    workspaceHint: string | null
    nodes: unknown[]
    edges: unknown[]
    viewport: Record<string, unknown> | null
  }
  dependencies: WorkflowDocumentDependencies
}

export interface ParsedWorkflowImportDocument {
  name: string
  profileHint: string | null
  workspaceHint: string | null
  nodes: unknown[]
  edges: unknown[]
  viewport: Record<string, unknown> | null
  dependencies: WorkflowDocumentDependencies
}

export interface WorkflowImportEnvironment {
  targetProfile: string
  profiles: string[]
  agents: string[]
  models: PortableModelDependency[]
  skills: PortableSkillDependency[]
}

export interface WorkflowImportPreview {
  canImport: boolean
  missing: {
    profiles: string[]
    agents: string[]
    providers: string[]
    models: PortableModelDependency[]
    skills: PortableSkillDependency[]
  }
  warnings: string[]
  resolvedWorkflow: {
    name: string
    profile: string
    workspace: null
    nodes: unknown[]
    edges: unknown[]
    viewport: Record<string, unknown> | null
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function assertKnownKeys(record: Record<string, unknown>, allowed: Set<string>, name: string): void {
  const unknown = Object.keys(record).filter(key => !allowed.has(key))
  if (unknown.length) throw new Error(`${name} contains unknown field: ${unknown.join(', ')}`)
}

function documentSize(value: unknown): number {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('workflow document must be JSON serializable')
  }
  if (typeof serialized !== 'string') throw new Error('workflow document must be JSON serializable')
  return Buffer.byteLength(serialized, 'utf8')
}

function inspectJsonTree(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > MAX_WORKFLOW_DOCUMENT_DEPTH) throw new Error(`workflow document exceeds maximum depth ${MAX_WORKFLOW_DOCUMENT_DEPTH}`)
  if (value == null || typeof value !== 'object') return
  if (seen.has(value as object)) throw new Error('workflow document must not contain circular references')
  seen.add(value as object)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`workflow document contains unsafe key: ${key}`)
    inspectJsonTree((value as Record<string, unknown>)[key], depth + 1, seen)
  }
  seen.delete(value as object)
}

function stringValue(value: unknown, name: string, options: { required?: boolean; max?: number } = {}): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const normalized = value.trim()
  if (options.required && !normalized) throw new Error(`${name} is required`)
  if (normalized.length > (options.max ?? 16_384)) throw new Error(`${name} is too long`)
  return normalized
}

function nullableString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return stringValue(value, name, { max: 16_384 })
}

function portableId(value: unknown, name: string): string {
  const id = stringValue(value, name, { required: true, max: 128 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || UNSAFE_KEYS.has(id)) {
    throw new Error(`${name} must use a safe portable identifier`)
  }
  return id
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  if (value.length > 200) throw new Error(`${name} contains too many items`)
  return value.map((item, index) => stringValue(item, `${name}[${index}]`, { required: true, max: 4_096 }))
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  return value
}

function portablePosition(value: unknown): { x: number; y: number } | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, 'workflow node position')
  assertKnownKeys(record, new Set(['x', 'y']), 'workflow node position')
  return { x: finiteNumber(record.x, 'workflow node position.x'), y: finiteNumber(record.y, 'workflow node position.y') }
}

function portableStyle(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, 'workflow node style')
  assertKnownKeys(record, new Set(['width', 'height']), 'workflow node style')
  const style: Record<string, string> = {}
  for (const key of ['width', 'height']) {
    if (record[key] !== undefined) style[key] = stringValue(record[key], `workflow node style.${key}`, { required: true, max: 64 })
  }
  return style
}

function portableNodeOrchestration(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, 'workflow node orchestration')
  assertKnownKeys(record, new Set(['joinMode']), 'workflow node orchestration')
  return { joinMode: normalizeWorkflowJoinMode(record.joinMode) }
}

function portableNode(raw: unknown, mode: 'export' | 'import'): Record<string, unknown> {
  const record = asRecord(raw, 'workflow node')
  if (mode === 'import') assertKnownKeys(record, NODE_KEYS, 'workflow node')
  const id = portableId(record.id, 'workflow node id')
  if (record.type !== 'agent') throw new Error('workflow nodes must use the agent node type')
  const data = asRecord(record.data, `workflow node ${id} data`)
  if (mode === 'import') assertKnownKeys(data, NODE_DATA_KEYS, `workflow node ${id} data`)
  const agent = stringValue(data.agent, `workflow node ${id} agent`, { required: true, max: 64 })
  if (!AGENTS.has(agent)) throw new Error(`workflow node ${id} agent is unsupported`)
  const reasoningEffort = normalizeReasoningEffort(data.reasoningEffort)
  const nodeData: Record<string, unknown> = {
    title: stringValue(data.title, `workflow node ${id} title`, { required: true, max: 512 }),
    agent,
    provider: stringValue(data.provider, `workflow node ${id} provider`, { required: true, max: 512 }),
    model: stringValue(data.model, `workflow node ${id} model`, { required: true, max: 1_024 }),
    apiMode: data.apiMode === undefined ? '' : stringValue(data.apiMode, `workflow node ${id} apiMode`, { max: 128 }),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    input: stringValue(data.input, `workflow node ${id} input`, { required: true, max: 131_072 }),
    skills: stringArray(data.skills, `workflow node ${id} skills`),
    images: [],
  }
  const images = stringArray(data.images, `workflow node ${id} images`)
  if (images.length > 0) throw new Error('non_portable_attachment: workflow node images must be empty')
  const orchestration = portableNodeOrchestration(data.orchestration)
  if (orchestration) nodeData.orchestration = orchestration
  return {
    id,
    type: 'agent',
    ...(portablePosition(record.position) ? { position: portablePosition(record.position) } : {}),
    ...(record.dragHandle === undefined ? {} : { dragHandle: stringValue(record.dragHandle, `workflow node ${id} dragHandle`, { required: true, max: 128 }) }),
    ...(portableStyle(record.style) ? { style: portableStyle(record.style) } : {}),
    data: nodeData,
  }
}

function cloneSafeMetadata(value: unknown, mode: 'export' | 'import', depth = 0): unknown {
  if (depth > MAX_WORKFLOW_DOCUMENT_DEPTH) throw new Error(`workflow document exceeds maximum depth ${MAX_WORKFLOW_DOCUMENT_DEPTH}`)
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('workflow metadata numbers must be finite')
    return value
  }
  if (Array.isArray(value)) return value.map(item => cloneSafeMetadata(item, mode, depth + 1))
  if (typeof value !== 'object') throw new Error('workflow metadata must be JSON compatible')
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`workflow document contains unsafe key: ${key}`)
    if (SENSITIVE_KEY.test(key)) {
      if (mode === 'import') throw new Error(`workflow metadata contains sensitive field: ${key}`)
      continue
    }
    result[key] = cloneSafeMetadata(item, mode, depth + 1)
  }
  return result
}

function portableEdge(raw: unknown, mode: 'export' | 'import'): Record<string, unknown> {
  const record = asRecord(raw, 'workflow edge')
  assertKnownKeys(record, EDGE_KEYS, 'workflow edge')
  const source = stringValue(record.source, 'workflow edge source', { required: true, max: 256 })
  const target = stringValue(record.target, 'workflow edge target', { required: true, max: 256 })
  const edge: Record<string, unknown> = {
    ...(record.id === undefined ? {} : { id: portableId(record.id, 'workflow edge id') }),
    source,
    target,
  }
  for (const key of ['sourceHandle', 'targetHandle', 'type', 'markerEnd', 'label'] as const) {
    if (record[key] !== undefined) edge[key] = stringValue(record[key], `workflow edge ${key}`, { max: 512 })
  }
  if (record.animated !== undefined) {
    if (typeof record.animated !== 'boolean') throw new Error('workflow edge animated must be a boolean')
    edge.animated = record.animated
  }
  if (record.data !== undefined) {
    const data = asRecord(record.data, 'workflow edge data')
    const cloned = cloneSafeMetadata(data, mode) as Record<string, unknown>
    if (Object.hasOwn(cloned, 'orchestration')) {
      cloned.orchestration = normalizeWorkflowEdgeOrchestration(cloned.orchestration)
    }
    edge.data = cloned
  }
  return edge
}

function portableViewport(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  const record = asRecord(value, 'workflow viewport')
  assertKnownKeys(record, new Set(['x', 'y', 'zoom']), 'workflow viewport')
  const zoom = finiteNumber(record.zoom, 'workflow viewport.zoom')
  if (zoom <= 0) throw new Error('workflow viewport.zoom must be positive')
  return {
    x: finiteNumber(record.x, 'workflow viewport.x'),
    y: finiteNumber(record.y, 'workflow viewport.y'),
    zoom,
  }
}

function dependenciesForNodes(nodes: unknown[]): WorkflowDocumentDependencies {
  const agents = new Set<string>()
  const providers = new Set<string>()
  const models = new Map<string, PortableModelDependency>()
  const skills = new Map<string, PortableSkillDependency>()
  for (const raw of nodes) {
    const node = raw as Record<string, any>
    const data = node.data as Record<string, any>
    agents.add(data.agent)
    providers.add(data.provider)
    models.set(`${data.provider}\0${data.model}\0${data.apiMode}`, { provider: data.provider, model: data.model, apiMode: data.apiMode })
    for (const name of data.skills as string[]) {
      skills.set(`${data.agent}\0${name}`, { agent: data.agent, name })
    }
  }
  return {
    agents: [...agents].sort(),
    providers: [...providers].sort(),
    models: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.apiMode.localeCompare(b.apiMode)),
    skills: [...skills.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name)),
  }
}

function parseDeclaredDependencies(value: unknown): WorkflowDocumentDependencies {
  const record = asRecord(value, 'workflow document dependencies')
  assertKnownKeys(record, new Set(['agents', 'providers', 'models', 'skills']), 'workflow document dependencies')
  const agents = stringArray(record.agents, 'workflow document dependencies.agents').sort()
  const providers = stringArray(record.providers, 'workflow document dependencies.providers').sort()
  if (!Array.isArray(record.models)) throw new Error('workflow document dependencies.models must be an array')
  if (!Array.isArray(record.skills)) throw new Error('workflow document dependencies.skills must be an array')
  const models = record.models.map((raw, index) => {
    const item = asRecord(raw, `workflow document dependencies.models[${index}]`)
    assertKnownKeys(item, new Set(['provider', 'model', 'apiMode']), `workflow document dependencies.models[${index}]`)
    return {
      provider: stringValue(item.provider, `workflow document dependencies.models[${index}].provider`, { required: true, max: 512 }),
      model: stringValue(item.model, `workflow document dependencies.models[${index}].model`, { required: true, max: 1_024 }),
      apiMode: stringValue(item.apiMode, `workflow document dependencies.models[${index}].apiMode`, { max: 128 }),
    }
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.apiMode.localeCompare(b.apiMode))
  const skills = record.skills.map((raw, index) => {
    const item = asRecord(raw, `workflow document dependencies.skills[${index}]`)
    assertKnownKeys(item, new Set(['agent', 'name']), `workflow document dependencies.skills[${index}]`)
    return {
      agent: stringValue(item.agent, `workflow document dependencies.skills[${index}].agent`, { required: true, max: 64 }),
      name: stringValue(item.name, `workflow document dependencies.skills[${index}].name`, { required: true, max: 4_096 }),
    }
  }).sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name))
  return { agents, providers, models, skills }
}

function dependenciesEqual(left: WorkflowDocumentDependencies, right: WorkflowDocumentDependencies): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function canonicalDefinition(raw: {
  name: unknown
  profileHint?: unknown
  workspaceHint?: unknown
  nodes: unknown
  edges: unknown
  viewport?: unknown
}, mode: 'export' | 'import'): ParsedWorkflowImportDocument {
  const name = stringValue(raw.name, 'workflow name', { required: true, max: 512 })
  if (!Array.isArray(raw.nodes)) throw new Error('workflow nodes must be an array')
  if (!Array.isArray(raw.edges)) throw new Error('workflow edges must be an array')
  if (raw.nodes.length > MAX_WORKFLOW_DOCUMENT_NODES) throw new Error(`workflow document has too many nodes (max ${MAX_WORKFLOW_DOCUMENT_NODES})`)
  if (raw.edges.length > MAX_WORKFLOW_DOCUMENT_EDGES) throw new Error(`workflow document has too many edges (max ${MAX_WORKFLOW_DOCUMENT_EDGES})`)
  const nodes = raw.nodes.map(node => portableNode(node, mode))
  const edges = raw.edges.map(edge => portableEdge(edge, mode))
  const compiled = compileWorkflowGraph(nodes, edges)
  return {
    name,
    profileHint: nullableString(raw.profileHint, 'workflow profileHint'),
    workspaceHint: nullableString(raw.workspaceHint, 'workflow workspaceHint'),
    nodes: compiled.nodes,
    edges: compiled.edges,
    viewport: portableViewport(raw.viewport),
    dependencies: dependenciesForNodes(compiled.nodes),
  }
}

export function exportWorkflowDocument(workflow: WorkflowRecord): WorkflowPortableDocument {
  const canonical = canonicalDefinition({
    name: workflow.name,
    profileHint: workflow.profile,
    workspaceHint: workflow.workspace,
    nodes: workflow.nodes,
    edges: workflow.edges,
    viewport: workflow.viewport,
  }, 'export')
  return {
    schema: WORKFLOW_DOCUMENT_SCHEMA,
    version: WORKFLOW_DOCUMENT_VERSION,
    workflow: {
      name: canonical.name,
      profileHint: canonical.profileHint,
      workspaceHint: canonical.workspaceHint,
      nodes: canonical.nodes,
      edges: canonical.edges,
      viewport: canonical.viewport,
    },
    dependencies: canonical.dependencies,
  }
}

export function parseWorkflowImportDocument(value: unknown): ParsedWorkflowImportDocument {
  if (documentSize(value) > MAX_WORKFLOW_DOCUMENT_BYTES) throw new Error(`workflow document exceeds maximum size ${MAX_WORKFLOW_DOCUMENT_BYTES} bytes`)
  inspectJsonTree(value)
  const envelope = asRecord(value, 'workflow document')
  assertKnownKeys(envelope, ENVELOPE_KEYS, 'workflow document')
  if (envelope.schema !== WORKFLOW_DOCUMENT_SCHEMA) throw new Error(`workflow document schema must be ${WORKFLOW_DOCUMENT_SCHEMA}`)
  if (envelope.version !== WORKFLOW_DOCUMENT_VERSION) throw new Error(`unsupported workflow document version: ${String(envelope.version)}`)
  const workflow = asRecord(envelope.workflow, 'workflow document workflow')
  assertKnownKeys(workflow, WORKFLOW_KEYS, 'workflow document workflow')
  const canonical = canonicalDefinition({
    name: workflow.name,
    profileHint: workflow.profileHint,
    workspaceHint: workflow.workspaceHint,
    nodes: workflow.nodes,
    edges: workflow.edges,
    viewport: workflow.viewport,
  }, 'import')
  const declared = parseDeclaredDependencies(envelope.dependencies)
  if (!dependenciesEqual(declared, canonical.dependencies)) {
    throw new Error('workflow document dependencies do not match the canonical node definition')
  }
  return canonical
}

function missingPairs<T extends Record<string, string>>(required: T[], available: T[], keys: Array<keyof T>): T[] {
  const identities = new Set(available.map(item => keys.map(key => item[key]).join('\0')))
  return required.filter(item => !identities.has(keys.map(key => item[key]).join('\0')))
}

export function inspectWorkflowImportDependencies(
  parsed: ParsedWorkflowImportDocument,
  environment: WorkflowImportEnvironment,
): WorkflowImportPreview {
  const profile = stringValue(environment.targetProfile, 'target profile', { required: true, max: 256 })
  const profiles = new Set(environment.profiles)
  const agents = new Set(environment.agents)
  const providers = new Set(environment.models.map(item => item.provider))
  const missing = {
    profiles: profiles.has(profile) ? [] : [profile],
    agents: parsed.dependencies.agents.filter(agent => !agents.has(agent)),
    providers: parsed.dependencies.providers.filter(provider => !providers.has(provider)),
    models: missingPairs(parsed.dependencies.models, environment.models, ['provider', 'model', 'apiMode']),
    skills: missingPairs(parsed.dependencies.skills, environment.skills, ['agent', 'name']),
  }
  const warnings: string[] = []
  if (parsed.profileHint && parsed.profileHint !== profile) {
    warnings.push(`source profile hint "${parsed.profileHint}" differs from target profile "${profile}" and will not be remapped automatically.`)
  }
  if (parsed.workspaceHint) warnings.push('workspace is a non-portable hint and will not be assigned automatically.')
  if (parsed.nodes.some((node: any) => Array.isArray(node.data?.images) && node.data.images.length > 0)) {
    warnings.push('attachment paths are local references and must be validated on the target environment.')
  }
  return {
    canImport: Object.values(missing).every(items => items.length === 0),
    missing,
    warnings,
    resolvedWorkflow: {
      name: parsed.name,
      profile,
      workspace: null,
      nodes: parsed.nodes,
      edges: parsed.edges,
      viewport: parsed.viewport,
    },
  }
}


export async function collectWorkflowImportEnvironment(
  parsed: ParsedWorkflowImportDocument,
  targetProfile: string,
): Promise<WorkflowImportEnvironment> {
  const profile = stringValue(targetProfile, 'target profile', { required: true, max: 256 })
  const [models, codingAgentStatus] = await Promise.all([
    getAvailableModelReferencesForProfile(profile),
    getCodingAgentsStatus(),
  ])
  const installedAgents = new Set(['hermes'])
  for (const tool of codingAgentStatus.tools) {
    if (tool.installed) installedAgents.add(tool.id)
  }
  const skills: PortableSkillDependency[] = []
  for (const dependency of parsed.dependencies.skills) {
    const resolved = await resolveWorkflowSkillContent({
      agent: dependency.agent,
      profile,
      skillName: dependency.name,
    })
    if (resolved) skills.push(dependency)
  }
  return {
    targetProfile: profile,
    profiles: listProfileNamesFromDisk(),
    agents: [...installedAgents],
    models,
    skills,
  }
}
