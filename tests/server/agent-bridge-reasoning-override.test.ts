import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  const output = execFileSync('python3', ['-c', script], {
    cwd: process.cwd(), encoding: 'utf-8', stdio: 'pipe',
  })
  return JSON.parse(output)
}

describe('agent bridge per-run reasoning override', () => {
  it('keeps the facade runtime helper wired into bridge_pool patch synchronization', () => {
    const result = runPython(String.raw`
import importlib.util, json, sys
bridge_dir = 'packages/server/src/services/hermes/agent-bridge/python'
sys.path.insert(0, bridge_dir)
import hermes_bridge
sentinel = object()
hermes_bridge.temporary_reasoning_override = sentinel
hermes_bridge._sync_pool_patches()
print(json.dumps({
    'runtime': hermes_bridge._runtime.temporary_reasoning_override is sentinel,
    'pool': hermes_bridge._pool.temporary_reasoning_override is sentinel,
}))
`)
    expect(result).toEqual({ runtime: true, pool: true })
  })

  it('adds exact chat_completions wire effort and restores both agent fields', () => {
    const result = runPython(String.raw`
import importlib.util, json, sys, types
constants = types.ModuleType('hermes_constants')
constants.parse_reasoning_effort = lambda effort: {'enabled': True, 'effort': effort}
sys.modules['hermes_constants'] = constants
spec = importlib.util.spec_from_file_location('bridge_runtime', 'packages/server/src/services/hermes/agent-bridge/python/bridge_runtime.py')
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)
class Agent:
    reasoning_config = {'enabled': True, 'effort': 'low'}
    request_overrides = {'service_tier': 'priority'}
agent = Agent()
with runtime.temporary_reasoning_override(agent, 'max', 'chat_completions'):
    inside = {'reasoning_config': dict(agent.reasoning_config), 'request_overrides': dict(agent.request_overrides)}
after = {'reasoning_config': dict(agent.reasoning_config), 'request_overrides': dict(agent.request_overrides)}
print(json.dumps({'inside': inside, 'after': after}))
`)
    expect(result.inside).toEqual({
      reasoning_config: { enabled: true, effort: 'max' },
      request_overrides: { service_tier: 'priority', reasoning_effort: 'max' },
    })
    expect(result.after).toEqual({
      reasoning_config: { enabled: true, effort: 'low' },
      request_overrides: { service_tier: 'priority' },
    })
  })

  it('restores an originally absent request_overrides attribute exactly', () => {
    const result = runPython(String.raw`
import importlib.util, json, sys, types
constants = types.ModuleType('hermes_constants')
constants.parse_reasoning_effort = lambda effort: {'enabled': True, 'effort': effort}
sys.modules['hermes_constants'] = constants
spec = importlib.util.spec_from_file_location('bridge_runtime', 'packages/server/src/services/hermes/agent-bridge/python/bridge_runtime.py')
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)
class Agent:
    reasoning_config = None
agent = Agent()
before = hasattr(agent, 'request_overrides')
with runtime.temporary_reasoning_override(agent, 'max', 'chat_completions'):
    inside = dict(agent.request_overrides)
after = hasattr(agent, 'request_overrides')
print(json.dumps({'before': before, 'inside': inside, 'after': after}))
`)
    expect(result).toEqual({
      before: false,
      inside: { reasoning_effort: 'max' },
      after: false,
    })
  })

  it('restores an originally absent reasoning_config attribute even when the run raises', () => {
    const result = runPython(String.raw`
import importlib.util, json, sys, types
constants = types.ModuleType('hermes_constants')
constants.parse_reasoning_effort = lambda effort: {'enabled': True, 'effort': effort}
sys.modules['hermes_constants'] = constants
spec = importlib.util.spec_from_file_location('bridge_runtime', 'packages/server/src/services/hermes/agent-bridge/python/bridge_runtime.py')
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)
class Agent: pass
agent = Agent()
before = hasattr(agent, 'reasoning_config')
try:
    with runtime.temporary_reasoning_override(agent, 'max', 'chat_completions'):
        inside = dict(agent.reasoning_config)
        raise RuntimeError('probe')
except RuntimeError:
    pass
after = hasattr(agent, 'reasoning_config')
print(json.dumps({'before': before, 'inside': inside, 'after': after}))
`)
    expect(result).toEqual({
      before: false,
      inside: { enabled: true, effort: 'max' },
      after: false,
    })
  })

  it('does not inject a chat_completions wire override for other API modes', () => {
    const result = runPython(String.raw`
import importlib.util, json, sys, types
constants = types.ModuleType('hermes_constants')
constants.parse_reasoning_effort = lambda effort: {'enabled': True, 'effort': effort}
sys.modules['hermes_constants'] = constants
spec = importlib.util.spec_from_file_location('bridge_runtime', 'packages/server/src/services/hermes/agent-bridge/python/bridge_runtime.py')
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)
class Agent:
    reasoning_config = None
    request_overrides = {}
agent = Agent()
with runtime.temporary_reasoning_override(agent, 'max', 'codex_responses'):
    inside = dict(agent.request_overrides)
print(json.dumps(inside))
`)
    expect(result).toEqual({})
  })
})
