import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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
  })
})
