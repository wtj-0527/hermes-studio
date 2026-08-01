import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('browser production bundle contract', () => {
  it('keeps playwright-core as a production runtime dependency outside the server bundle', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/build-server.mjs'), 'utf8')
    expect(source).toMatch(/external:\s*\[[^\]]*['"]playwright-core['"]/s)
  })
})