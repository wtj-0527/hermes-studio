import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Browser authority mutation wiring', () => {
  it('revokes a user browser authority before managed-user update and delete mutations', () => {
    const source = readFileSync('packages/server/src/controllers/auth.ts', 'utf8')
    expect(source).toMatch(/withUserAuthorityRevoked\(user\.id,\s*async \(\) =>\s*updateUser\(/s)
    expect(source).toMatch(/withUserAuthorityRevoked\(user\.id,\s*async \(\) =>\s*deleteUser\(user\.id\)/s)
  })

  it('registers logout and revokes the current user browser authority before completing it', () => {
    const routes = readFileSync('packages/server/src/routes/auth.ts', 'utf8')
    const controller = readFileSync('packages/server/src/controllers/auth.ts', 'utf8')
    expect(routes).toMatch(/post\('\/api\/auth\/logout', ctrl\.logout\)/)
    expect(controller).toMatch(/export async function logout[\s\S]*?withUserAuthorityRevoked\(userId/s)
  })

  it('revokes a profile browser authority around profile delete and rename mutations', () => {
    const source = readFileSync('packages/server/src/controllers/hermes/profiles.ts', 'utf8')
    expect(source).toMatch(/withProfileAuthorityRevoked\(name,\s*async \(\) =>/s)
    expect(source).toMatch(/withProfileAuthorityRevoked\(ctx\.params\.name,\s*async \(\) =>/s)
    expect(source).toMatch(/withProfileAuthorityRevoked\(ctx\.params\.name,[\s\S]*?hermesCli\.renameProfile\(ctx\.params\.name, new_name\)/s)
  })
})
