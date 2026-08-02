import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function runtimeLock() {
  return JSON.parse(readFileSync('docker/steel-runtime-package-lock.json', 'utf8')) as {
    packages: Record<string, { version?: string }>
  }
}

describe('Studio-managed Steel Browser packaging contract', () => {
  it('pins and verifies the Steel source and keeps runtime ports internal', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')
    expect(dockerfile).toContain('5880b48c1af107219ff3d904edbb8f6b76bea9b6')
    expect(dockerfile).toContain('4248ee256c94a5c371806b7c51f00e3639d84992fcf16a60187d69b5f02d14ed')
    expect(dockerfile).toContain('npm run build -w api')
    expect(dockerfile).toContain('steel-browser-egress.patch')
    expect(dockerfile).toContain('patch -p1')
    expect(dockerfile).toContain('chromium')
    expect(dockerfile).toContain('COPY docker/entrypoint.sh /usr/local/bin/hermes-studio-entrypoint')
    expect(dockerfile).toContain('EXPOSE 6060')
    expect(dockerfile).not.toMatch(/EXPOSE[^\n]*(3000|9223)/)
    expect(dockerfile).toMatch(/ARG BASE_IMAGE=nousresearch\/hermes-agent@sha256:[a-f0-9]{64}/)
    expect(dockerfile).toMatch(/FROM node:22\.13\.0-slim@sha256:[a-f0-9]{64} AS steel-build/)
    expect(dockerfile).toContain('NODE_X64_SHA256=44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89')
    expect(dockerfile).toContain('NODE_ARM64_SHA256=73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed')
    expect(dockerfile).toContain('sha256sum -c -')
  })

  it('supervises loopback-only Steel readiness and Studio shutdown together', () => {
    const entrypoint = readFileSync('docker/entrypoint.sh', 'utf8')
    expect(entrypoint).toContain('HOST=127.0.0.1 PORT=3000')
    expect(entrypoint).not.toContain('export PORT=3000')
    expect(entrypoint).toContain('export PORT="${HERMES_STUDIO_PORT:-6060}"')
    expect(entrypoint).toContain('HERMES_STEEL_BROWSER_URL=http://127.0.0.1:3000')
    expect(entrypoint).toContain('http://127.0.0.1:3000/v1/health')
    expect(entrypoint).toContain('trap shutdown TERM INT EXIT')
    expect(entrypoint).toContain('monitor_child')
    expect(entrypoint).toContain('shutdown_deadline')
    expect(entrypoint).toContain('kill -KILL')
    expect(entrypoint).toContain('kill -TERM "$studio_pid"')
    expect(entrypoint).toContain('kill -TERM "$steel_pid"')
    expect(entrypoint).toContain('/opt/steel/api/build/index.js')
    expect(entrypoint).toContain('dist/server/index.js')
  })

  it('ships an audit-clean API-only Steel runtime closure', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')
    const manifest = JSON.parse(readFileSync('docker/steel-runtime-package.json', 'utf8')) as {
      dependencies: Record<string, string>
    }
    const lock = runtimeLock()
    const forbidden = [
      'duckdb', 'duckdb-async', 'node-gyp', 'tar', '@fastify/static', 'vite', 'postcss',
    ]

    expect(dockerfile).toContain('FROM node:22.13.0-slim@sha256:')
    expect(dockerfile).toContain('AS steel-runtime')
    expect(dockerfile).toContain('steel-runtime-package-lock.json')
    expect(dockerfile).not.toContain('COPY --from=steel-build /src/steel /opt/steel')
    expect(dockerfile).toContain('COPY --from=steel-build /src/steel/api/build /opt/steel/api/build')
    expect(manifest.dependencies).not.toHaveProperty('duckdb-async')
    expect(manifest.dependencies).not.toHaveProperty('@fastify/static')
    for (const dependency of forbidden) {
      expect(lock.packages).not.toHaveProperty(`node_modules/${dependency}`)
    }
    expect(lock.packages['node_modules/axios']?.version).toBe('1.19.0')
    expect(lock.packages['node_modules/undici']?.version).toBe('7.29.0')
    expect(lock.packages['node_modules/ws']?.version).toBe('8.21.1')
    const sbom = JSON.parse(readFileSync('docs/security/steel-runtime.cdx.json', 'utf8')) as {
      bomFormat: string
      specVersion: string
      metadata?: { component?: { name?: string } }
      components?: unknown[]
    }
    expect(sbom).toMatchObject({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      metadata: { component: { name: 'hermes-studio-embedded-steel-runtime' } },
    })
    expect(sbom.components?.length).toBeGreaterThan(300)
  })

  it('patches Steel to use bounded in-memory logs and omit its standalone UI', () => {
    const patch = readFileSync('docker/steel-browser-egress.patch', 'utf8')
    expect(patch).toContain('Using bounded in-memory log storage')
    expect(patch).toContain('import type { LogQuery }')
    expect(patch).toContain('uiPlugin')
    expect(patch).toContain('DuckDBStorage')
  })

  it('keeps late page-close races from crashing the embedded Steel process', () => {
    const patch = readFileSync('docker/steel-browser-egress.patch', 'utf8')
    expect(patch).toContain('await installMouseHelper(page')
    expect(patch).toContain('[CDPService] Skipping closed target setup')
    expect(patch).toContain('if (page.isClosed()) {')
    expect(patch).toContain('return;')
  })

  it('guards Chromium implicit proxy bypasses before page requests leave the browser', () => {
    const patch = readFileSync('docker/steel-browser-egress.patch', 'utf8')
    expect(patch).toContain('isLocalNetworkRequest')
    expect(patch).toContain('::ffff:')
    expect(patch).toContain('Blocked local-network request before proxy bypass')
    expect(patch).toContain('await request.abort("blockedbyclient")')
  })

  it('ships the upstream Apache-2.0 attribution', () => {
    const notice = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')
    expect(notice).toContain('Steel Browser')
    expect(notice).toContain('Apache License 2.0')
    expect(notice).toContain('5880b48c1af107219ff3d904edbb8f6b76bea9b6')
  })

  it('removes Steel internal host bypasses so every page request reaches the Studio egress policy', () => {
    const patch = readFileSync('docker/steel-browser-egress.patch', 'utf8')
    expect(patch).toContain('internalBypassTests')
    expect(patch).toContain('const internalBypassTests = new Set<string>();')
    expect(patch).toContain('PROXY_INTERNAL_BYPASS')
    expect(patch).toContain('const internalBypassTests = new Set(["0.0.0.0", process.env.HOST]);')
    expect(patch).toContain('--proxy-bypass-list=<-loopback>')
  })
})
