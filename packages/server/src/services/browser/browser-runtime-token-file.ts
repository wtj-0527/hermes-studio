import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

export function resolveBrowserRuntimeTokenFile(
  env: Record<string, string | undefined> = process.env,
  _appHome?: string,
): string {
  const configured = env.HERMES_BROWSER_RUNTIME_TOKEN_FILE?.trim()
  if (configured) return isAbsolute(configured) ? configured : resolve(configured)
  const hermesHome = env.HERMES_HOME?.trim()
  return join(hermesHome ? resolve(hermesHome) : join(homedir(), '.hermes'), 'runtime', 'browser-runtime-token')
}

export async function readBrowserRuntimeToken(path: string): Promise<string> {
  if (process.platform !== 'win32') {
    const info = await stat(path)
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Unsafe Browser Runtime token file permissions')
  }
  const token = (await readFile(path, 'utf8')).trim()
  if (token.length < 32) throw new Error('Browser Runtime token is invalid')
  return token
}
