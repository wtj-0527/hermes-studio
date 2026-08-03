import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('browser production bundle contract', () => {
  it('keeps playwright-core as an installed production runtime dependency outside the server bundle', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/build-server.mjs'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(source).toMatch(/external:\s*\[[^\]]*['"]playwright-core['"]/s)
    expect(packageJson.dependencies?.['playwright-core']).toBe('1.60.0')
    expect(packageJson.devDependencies?.['playwright-core']).toBeUndefined()
  })
})