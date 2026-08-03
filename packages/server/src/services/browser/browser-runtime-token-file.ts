import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'path'

const MAX_BROWSER_RUNTIME_TOKEN_BYTES = 64 * 1024

export function resolveBrowserRuntimeTokenFile(
  env: Record<string, string | undefined> = process.env,
  _appHome?: string,
): string | null {
  const configured = env.HERMES_BROWSER_RUNTIME_TOKEN_FILE?.trim()
  if (!configured) return null
  return isAbsolute(configured) ? configured : resolve(configured)
}

export async function readBrowserRuntimeToken(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Unsafe Browser Runtime token file permissions')
  if (info.size > MAX_BROWSER_RUNTIME_TOKEN_BYTES) throw new Error('Browser Runtime token file is too large')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Unsafe Browser Runtime token file permissions')
  const token = (await readFile(path, 'utf8')).trim()
  if (Buffer.byteLength(token, 'utf8') > MAX_BROWSER_RUNTIME_TOKEN_BYTES) throw new Error('Browser Runtime token is too large')
  if (token.length < 32) throw new Error('Browser Runtime token is invalid')
  return token
}
