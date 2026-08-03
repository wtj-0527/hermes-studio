import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readBrowserRuntimeToken, resolveBrowserRuntimeTokenFile } from '../../packages/server/src/services/browser/browser-runtime-token-file'

describe('provider-neutral Browser Runtime configuration', () => {
  it('resolves the runtime token from the generic explicit override', () => {
    expect(resolveBrowserRuntimeTokenFile({
      HERMES_HOME: '/home/agent/.hermes',
      HERMES_BROWSER_RUNTIME_TOKEN_FILE: '/run/secrets/browser-runtime-token',
    }, '/home/agent/.hermes-web-ui')).toBe('/run/secrets/browser-runtime-token')
  })

  it('uses the shared Hermes home when no token path is configured', () => {
    expect(resolveBrowserRuntimeTokenFile({ HERMES_HOME: '/home/agent/.hermes' }, '/home/agent/.hermes-web-ui')).toBe(
      '/home/agent/.hermes/runtime/browser-runtime-token',
    )
  })

  it('does not accept vendor-specific runtime configuration aliases', () => {
    expect(resolveBrowserRuntimeTokenFile({ HERMES_HOME: '/home/agent/.hermes' }, '/app/home')).toBe(
      '/home/agent/.hermes/runtime/browser-runtime-token',
    )
  })

  it('reads a private runtime token and rejects group/world-readable files on Unix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-runtime-token-'))
    const tokenFile = join(directory, 'token')
    const token = 'runtime-token-that-is-at-least-thirty-two-characters'
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
    await expect(readBrowserRuntimeToken(tokenFile)).resolves.toBe(token)
    if (process.platform !== 'win32') {
      await chmod(tokenFile, 0o644)
      await expect(readBrowserRuntimeToken(tokenFile)).rejects.toThrow('permissions')
    }
  })
})
