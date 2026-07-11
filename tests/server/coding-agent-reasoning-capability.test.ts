import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { prepareCodingAgentLaunch } from '../../packages/server/src/services/coding-agents'

const roots: string[] = []
function setup(levels?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'coding-capability-')); roots.push(root)
  process.env.HERMES_WEB_UI_HOME = root
  process.env.HERMES_HOME = join(root, 'hermes')
  const profile = process.env.HERMES_HOME
  mkdirSync(profile, { recursive: true })
  const metadata = levels ? `\n        supported_reasoning_levels: [${levels.join(', ')}]` : ' {}'
  writeFileSync(join(profile, 'config.yaml'), `providers:\n  test:\n    base_url: https://example.invalid\n    api_mode: codex_responses\n    models:\n      gpt-5.6-sol:${metadata}\n`)
  return root
}
afterEach(() => {
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_HOME
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const input = {
  mode: 'scoped' as const, profile: 'default', provider: 'custom:test', model: 'gpt-5.6-sol',
  apiMode: 'codex_responses' as const, baseUrl: 'https://example.invalid', apiKey: 'test-key',
  reasoningEffort: 'max',
}

describe('coding agent reasoning capability preflight', () => {
  it('rejects unknown capability before creating scoped launch directories', async () => {
    const root = setup()
    await expect(prepareCodingAgentLaunch('codex', input)).rejects.toThrow(/reasoning_capability_unknown/)
    expect(existsSync(join(root, 'coding-agent'))).toBe(false)
  })

  it('rejects unsupported max exactly instead of downgrading', async () => {
    const root = setup(['low', 'high'])
    await expect(prepareCodingAgentLaunch('claude-code', input)).rejects.toThrow(/reasoning_effort_unsupported.*max/)
    expect(existsSync(join(root, 'coding-agent'))).toBe(false)
  })

  it('allows declared max and keeps the exact launch value', async () => {
    setup(['low', 'high', 'max'])
    const result = await prepareCodingAgentLaunch('codex', input)
    expect(result.reasoningEffort).toBe('max')
    expect(result.args.join(' ')).toContain('model_reasoning_effort="max"')
  })
})
