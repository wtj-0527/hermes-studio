import { describe, expect, it } from 'vitest'
import { isAllowedBrowserViewOrigin } from '../../packages/server/src/services/browser/browser-view-websocket'

describe('Browser live-view WebSocket origin boundary', () => {
  it('accepts only the exact same origin and rejects opaque sandbox origins', () => {
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://studio.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(true)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'null', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: {} } as any)).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'https://evil.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
    expect(isAllowedBrowserViewOrigin({ headers: { origin: 'http://studio.example', host: 'studio.example' } } as any, 'https://studio.example')).toBe(false)
  })
})