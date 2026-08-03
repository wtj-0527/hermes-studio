import { createServer, type Server } from 'http'
import { existsSync } from 'node:fs'
import { chromium as realChromium } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpBrowserRuntimeAdapter, isHighRiskBrowserActivation, publicBrowserUrl, redactBrowserText } from '../../packages/server/src/services/browser/http-browser-runtime'
import { ManagedBrowserService } from '../../packages/server/src/services/browser/managed-browser-service'

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
})

describe('HttpBrowserRuntimeAdapter', () => {
  it('matches Electron secret-redaction and fails closed for high-risk activations', () => {
    expect(publicBrowserUrl('https://example.test/callback?access_token=correct-horse#token=secret')).not.toContain('correct-horse')
    expect(publicBrowserUrl('https://example.test/callback?access_token=correct-horse#token=secret')).not.toContain('secret')
    expect(publicBrowserUrl('https://user:password@example.test/path')).toBe('https://example.test/path')
    expect(publicBrowserUrl('https://example.test/cb?client_secret=correct-horse&sessionToken=session-horse')).not.toContain('correct-horse')
    expect(publicBrowserUrl('https://example.test/cb?client_secret=correct-horse&sessionToken=session-horse')).not.toContain('session-horse')
    expect(publicBrowserUrl('https://example.test/cb#clientSecret=correct-horse')).not.toContain('correct-horse')
    expect(redactBrowserText('{"client_secret":"correct-horse","sessionToken":"session-horse"}')).not.toContain('correct-horse')
    expect(redactBrowserText('{"client_secret":"correct-horse","sessionToken":"session-horse"}')).not.toContain('session-horse')
    expect(redactBrowserText('Authorization: Bearer test-token')).toBe('Authorization: Bearer [redacted]')
    expect(isHighRiskBrowserActivation('button', 'Pay now')).toBe(true)
    expect(isHighRiskBrowserActivation('button', 'Read more')).toBe(false)
  })

  it('structurally excludes inert, zero-size, and fully offscreen controls from snapshots', async () => {
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 720)
    const visibleRect = { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }
    const element = (label: string, options: { inert?: boolean; rect?: typeof visibleRect; rectCount?: number } = {}) => ({
      tagName: 'BUTTON', type: '', value: '', innerText: label, textContent: label,
      closest: vi.fn((selector: string) => options.inert && selector.includes('[inert]') ? {} : null),
      getAttribute: vi.fn(() => null), setAttribute: vi.fn(),
      getClientRects: vi.fn(() => Array.from({ length: options.rectCount ?? 1 }, () => options.rect || visibleRect)),
      getBoundingClientRect: vi.fn(() => options.rect || visibleRect),
    })
    const elements = [
      element('Visible control'),
      element('opaque-inert-nonce', { inert: true }),
      element('opaque-zero-size-nonce', { rectCount: 0 }),
      element('opaque-offscreen-nonce', { rect: { left: -99999, top: 10, right: -99899, bottom: 40, width: 100, height: 30 } }),
    ]
    const page = {
      isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'),
      locator: vi.fn((selector: string) => selector === 'a,button,input,textarea,select,[role],[tabindex]'
        ? { evaluateAll: vi.fn(async (callback: (items: any[]) => unknown) => callback(elements)) }
        : { evaluate: vi.fn() }),
      on: vi.fn(),
    }
    const cdp = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn(async () => cdp), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'visibility-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any, fetchImpl: fetchImpl as any,
    })

    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const snapshot = await session.snapshot('page-1') as any
    expect(snapshot.nodes).toEqual([expect.objectContaining({ name: 'Visible control' })])
    expect(JSON.stringify(snapshot)).not.toMatch(/opaque-(?:inert|zero-size|offscreen)-nonce/)
    await session.release()
  })

  it('structurally excludes hidden descendants from text reads', async () => {
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 720)
    const visibleRect = { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }
    const hiddenChild = {
      nodeType: 1, tagName: 'SPAN', childNodes: [{ nodeType: 3, textContent: 'opaque-hidden-nonce' }],
      closest: vi.fn(() => ({})), getClientRects: vi.fn(() => [visibleRect]), getBoundingClientRect: vi.fn(() => visibleRect),
    }
    const visible = {
      nodeType: 1, tagName: 'BUTTON', type: '', value: '', innerText: 'Visible control opaque-hidden-nonce', textContent: 'Visible control opaque-hidden-nonce',
      childNodes: [{ nodeType: 3, textContent: 'Visible control' }, hiddenChild],
      closest: vi.fn(() => null), getAttribute: vi.fn(() => null), setAttribute: vi.fn(),
      getClientRects: vi.fn(() => [visibleRect]), getBoundingClientRect: vi.fn(() => visibleRect),
    }
    const page = {
      isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), on: vi.fn(),
      locator: vi.fn((selector: string) => selector === 'a,button,input,textarea,select,[role],[tabindex]'
        ? { evaluateAll: vi.fn(async (callback: (items: any[]) => unknown) => callback([visible])) }
        : { evaluate: vi.fn(async (callback: (element: any, mode: string) => unknown, mode: string) => callback(visible, mode)) }),
    }
    const cdp = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn(async () => cdp), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'hidden-descendant-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any, fetchImpl: fetchImpl as any,
    })

    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const snapshot = await session.snapshot('page-1') as any
    const result = await session.readText('page-1', { snapshot_id: snapshot.snapshotId, ref: '@e1', mode: 'textContent' }) as any
    expect(result.text).toBe('Visible control')
    expect(JSON.stringify(result)).not.toContain('opaque-hidden-nonce')
    await session.release()
  })

  const chromiumAvailable = existsSync(realChromium.executablePath())
  ;(chromiumAvailable ? it : it.skip)('projects descendant visibility with real Chromium semantics', async () => {
    const browser = await realChromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await page.setContent('<button id="target" style="position:absolute;left:20px;top:20px;width:240px;height:80px">Visible<span aria-hidden="true">ARIA_NONCE</span><span inert>INERT_NONCE</span><span style="position:absolute;left:-99999px">OFFSCREEN_NONCE</span><span style="display:none">DISPLAY_NONCE</span></button><div style="position:absolute;left:20px;top:150px;width:40px;height:20px;overflow:hidden"><button aria-label="UNKNOWN_CLIPPED_ARIA_NONCE" style="position:absolute;left:100px;top:0;width:80px;height:20px">CLIPPED_BUTTON_NONCE</button></div><div id="text-parent" role="region" style="position:absolute;left:20px;top:220px;width:240px;height:80px">VISIBLE_TEXT<span aria-hidden="true">TEXT_ARIA_NONCE</span><span inert>TEXT_INERT_NONCE</span><span style="position:absolute;left:-99999px">TEXT_OFFSCREEN_NONCE</span><span style="clip-path:inset(100%)">TEXT_CLIPPED_NONCE</span></div>')
      const cdp = await page.context().newCDPSession(page)
      const { targetInfo } = await cdp.send('Target.getTargetInfo')
      await cdp.detach()
      const context = page.context()
      const connectedBrowser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
      const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
        ? new Response(JSON.stringify({ id: 'real-visibility-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
        : new Response('{}', { status: 200 }))
      const adapter = new HttpBrowserRuntimeAdapter({
        baseUrl: 'http://127.0.0.1:3000',
        chromium: { connectOverCDP: vi.fn(async () => connectedBrowser) } as any, fetchImpl: fetchImpl as any,
      })
      const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
      const snapshot = await session.snapshot(targetInfo.targetId) as any
      const target = snapshot.nodes.find((node: any) => node.name.includes('Visible'))
      const textParent = snapshot.nodes.find((node: any) => node.name.includes('VISIBLE_TEXT'))
      const result = await session.readText(targetInfo.targetId, { snapshot_id: snapshot.snapshotId, ref: target.ref, mode: 'textContent' }) as any
      const textResult = await session.readText(targetInfo.targetId, { snapshot_id: snapshot.snapshotId, ref: textParent.ref, mode: 'textContent' }) as any
      expect(result.text).toBe('Visible')
      expect(textResult.text).toBe('VISIBLE_TEXT')
      expect(JSON.stringify({ snapshot, result, textResult })).not.toMatch(/(?:ARIA|INERT|OFFSCREEN|DISPLAY|CLIPPED)_NONCE/)
      await session.release()
    } finally {
      await browser.close()
    }
  })

  it('rejects text reads when a snapshot ref becomes structurally hidden', async () => {
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 720)
    const visibleRect = { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }
    let hidden = false
    const element = {
      tagName: 'BUTTON', type: '', value: '', innerText: 'Visible control', textContent: 'Visible control',
      closest: vi.fn(() => hidden ? {} : null), getAttribute: vi.fn(() => null), setAttribute: vi.fn(),
      getClientRects: vi.fn(() => hidden ? [] : [visibleRect]), getBoundingClientRect: vi.fn(() => visibleRect),
    }
    const page = {
      isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), on: vi.fn(),
      locator: vi.fn((selector: string) => selector === 'a,button,input,textarea,select,[role],[tabindex]'
        ? { evaluateAll: vi.fn(async (callback: (items: any[]) => unknown) => callback([element])) }
        : { evaluate: vi.fn(async (callback: (item: any, mode: string) => unknown, mode: string) => callback(element, mode)) }),
    }
    const cdp = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn(async () => cdp), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'stale-visibility-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any, fetchImpl: fetchImpl as any,
    })

    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const snapshot = await session.snapshot('page-1') as any
    hidden = true
    await expect(session.readText('page-1', { snapshot_id: snapshot.snapshotId, ref: '@e1' })).rejects.toThrow('no longer visible')
    await session.release()
  })

  it('rejects browser URLs containing credentials instead of silently stripping them', async () => {
    const page = { isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => ''), goto: vi.fn() }
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn() })),
      on: vi.fn(),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn() }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'credential-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({ baseUrl: 'http://127.0.0.1:3000', chromium: { connectOverCDP: vi.fn(async () => browser) } as any, fetchImpl: fetchImpl as any })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    await expect(session.createPage('https://user:password@example.test')).rejects.toThrow('credentials')
    expect(context.newPage).not.toHaveBeenCalled()
    expect(page.goto).not.toHaveBeenCalled()
    await session.release()
  })

  it('normalizes a bare domain before navigating', async () => {
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => 'https://baidu.com/'),
      title: vi.fn(async () => 'Baidu'),
      goto: vi.fn(async () => null),
      on: vi.fn(),
    }
    const context = {
      pages: vi.fn(() => [page]),
      newCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn() })),
      on: vi.fn(),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn() }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'bare-domain-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({ baseUrl: 'http://127.0.0.1:3000', chromium: { connectOverCDP: vi.fn(async () => browser) } as any, fetchImpl: fetchImpl as any })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })

    await session.navigate('page-1', 'baidu.com')

    expect(page.goto).toHaveBeenCalledWith('https://baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await session.release()
  })

  it('redacts protected snapshots, screenshot metadata, and bounded console entries while rejecting high-risk clicks', async () => {
    const listeners = new Map<string, (...args: any[]) => void>()
    const elements = [
      {
        tagName: 'INPUT', type: 'password', value: 'correct-horse', innerText: '',
        getAttribute: (name: string) => name === 'aria-label' ? 'Account password correct-horse' : null,
        closest: vi.fn(() => null), getClientRects: vi.fn(() => [{}]),
        getBoundingClientRect: vi.fn(() => ({ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 })),
        setAttribute: vi.fn(), textContent: '',
      },
      {
        tagName: 'BUTTON', type: '', value: '', innerText: 'Pay now',
        getAttribute: () => null, closest: vi.fn(() => null), getClientRects: vi.fn(() => [{}]),
        getBoundingClientRect: vi.fn(() => ({ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 })),
        setAttribute: vi.fn(), textContent: 'Pay now',
      },
      {
        tagName: 'INPUT', type: 'hidden', value: 'csrf-super-secret-value', innerText: '',
        getAttribute: () => null, closest: vi.fn(() => null), getClientRects: vi.fn(() => [{}]),
        getBoundingClientRect: vi.fn(() => ({ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 })),
        setAttribute: vi.fn(), textContent: '',
      },
    ]
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => 'https://example.test/checkout?access_token=correct-horse#token=secret'),
      title: vi.fn(async () => 'Authorization: Bearer correct-horse'),
      screenshot: vi.fn(async () => Buffer.from([1, 2, 3])),
      viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => { listeners.set(event, listener) }),
      once: vi.fn(),
      locator: vi.fn((selector: string) => selector === 'a,button,input,textarea,select,[role],[tabindex]'
        ? { evaluateAll: vi.fn(async (callback: (items: any[]) => unknown) => callback(elements)) }
        : { evaluate: vi.fn(async (callback: (element: any, mode: string) => unknown, mode: string) => callback(elements[0], mode)) }),
    }
    const context = {
      pages: vi.fn(() => [page]),
      newCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn() })),
      on: vi.fn(),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn() }
    const interactionExecutor = { execute: vi.fn() }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'security-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any, fetchImpl: fetchImpl as any, interactionExecutor,
    } as any)
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const snapshot = await session.snapshot('page-1') as any
    expect(snapshot.nodes[0].name).toBe('')
    expect(JSON.stringify(snapshot)).not.toContain('correct-horse')
    expect(JSON.stringify(snapshot)).not.toContain('token=secret')
    expect(JSON.stringify(snapshot)).not.toContain('csrf-super-secret-value')
    await expect(session.readText('page-1', { snapshot_id: snapshot.snapshotId, ref: '@e1' })).resolves.toMatchObject({ text: '' })
    await expect(session.interact('page-1', { action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e2' })).rejects.toThrow('High-risk browser activation')
    await expect(session.interact('page-1', { action: 'press', key: 'Enter' })).rejects.toThrow('High-risk browser key activation')
    await expect(session.interact('page-1', { action: 'press', key: 'Control+Enter' })).rejects.toThrow('High-risk browser key activation')
    expect(interactionExecutor.execute).not.toHaveBeenCalled()

    for (let index = 0; index < 205; index += 1) {
      listeners.get('console')?.({
        location: () => ({ url: 'https://example.test/app.js?api_key=correct-horse', lineNumber: index }),
        type: () => 'log', text: () => `access_token=correct-horse message-${index}`,
      })
    }
    listeners.get('pageerror')?.(new Error('Authorization: Bearer correct-horse'))
    const consoleEntries = await session.consoleEntries('page-1') as any[]
    expect(consoleEntries).toHaveLength(200)
    expect(JSON.stringify(consoleEntries)).not.toContain('correct-horse')
    expect(consoleEntries.at(-1)?.message).toContain('[redacted]')
    await session.clearConsole('page-1')
    await expect(session.consoleEntries('page-1')).resolves.toEqual([])

    const screenshot = await session.screenshot('page-1', false) as any
    expect(JSON.stringify({ url: screenshot.url, title: screenshot.title })).not.toContain('correct-horse')
    await session.release()
  })

  it('contains a late page instrumentation failure without an unhandled rejection', async () => {
    let pageListener: ((page: any) => void) | undefined
    const initialPage = {}
    const context = {
      pages: vi.fn(() => [initialPage]),
      newCDPSession: vi.fn(async (page: any) => {
        if (page !== initialPage) throw new Error('forced late page instrumentation failure')
        return {
          send: vi.fn(async () => ({ targetInfo: { targetId: 'initial-page' } })),
          detach: vi.fn(async () => undefined),
        }
      }),
      on: vi.fn((event: string, listener: (page: any) => void) => {
        if (event === 'page') pageListener = listener
      }),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/sessions') return new Response(JSON.stringify({ id: 'race-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      if (path === '/v1/sessions/race-session/release') return new Response(JSON.stringify({ success: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: fetchImpl as any,
    })
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
      expect(pageListener).toBeTypeOf('function')
      pageListener?.({ isClosed: vi.fn(() => true) })
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      await session.release()
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await adapter.shutdown()
    }
  })

  it('reports an upstream release failure and retries the same release safely', async () => {
    const page = {}
    const context = {
      pages: vi.fn(() => [page]),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })),
        detach: vi.fn(async () => undefined),
      })),
      on: vi.fn(),
    }
    const releaseOrder: string[] = []
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => { releaseOrder.push('disconnect') }) }
    let releaseAttempts = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/sessions') return new Response(JSON.stringify({ id: 'release-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      if (path === '/v1/sessions/release-session/release') {
        releaseOrder.push('release')
        releaseAttempts += 1
        if (releaseAttempts === 1) throw new Error('forced upstream release failure')
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: fetchImpl as any,
    })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })

    await expect(session.release()).rejects.toThrow('forced upstream release failure')
    await expect(session.release()).resolves.toBeUndefined()
    expect(releaseAttempts).toBe(2)
    expect(browser.close).toHaveBeenCalledOnce()
    expect(releaseOrder).toEqual(['release', 'release', 'disconnect'])
    await adapter.shutdown()
  })

  it('keeps the service owner fence across a real adapter release failure', async () => {
    let closed = false
    const page = {
      isClosed: vi.fn(() => closed),
      close: vi.fn(async () => { closed = true }),
      url: vi.fn(() => 'about:blank'),
      title: vi.fn(async () => 'Blank'),
      goto: vi.fn(async () => null),
    }
    const context = {
      pages: vi.fn(() => closed ? [] : [page]),
      newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })),
        detach: vi.fn(async () => undefined),
      })),
      on: vi.fn(),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    let starts = 0
    let releases = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/sessions') {
        starts += 1
        return new Response(JSON.stringify({ id: `session-${starts}`, websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      }
      if (path === '/v1/sessions/session-1/release') {
        releases += 1
        if (releases === 1) throw new Error('forced upstream release failure')
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (path === '/v1/sessions/session-2/release') return new Response(JSON.stringify({ success: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: fetchImpl as any,
    })
    const service = new ManagedBrowserService({ runtime: adapter, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }
    const tab = await service.createTab(first, 'about:blank')

    await expect(service.closeTab(first, tab.id)).rejects.toThrow('forced upstream release failure')
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'about:blank')).rejects.toThrow('already assigned')
    await expect(service.state(first)).resolves.toMatchObject({ tabs: [] })
    expect(releases).toBe(2)

    closed = false
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'about:blank')).resolves.toBeDefined()
    expect(starts).toBe(2)
    await service.shutdown()
  })

  it('keeps the owner fence when failed-start rollback is unconfirmed, then lets the same owner recover it', async () => {
    let starts = 0
    let releaseAttempts = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/sessions') {
        starts += 1
        return new Response(JSON.stringify({ id: `orphan-${starts}`, websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      }
      if (path === '/v1/sessions/orphan-1/release') {
        releaseAttempts += 1
        if (releaseAttempts === 1) throw new Error('forced rollback release failure')
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (path === '/v1/sessions/orphan-2/release') return new Response(JSON.stringify({ success: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => { throw new Error('CDP init failed') }) } as any,
      fetchImpl: fetchImpl as any,
    })
    const service = new ManagedBrowserService({ runtime: adapter, env: { HERMES_BROWSER_RUNTIME_URL: 'http://127.0.0.1:3000' } })
    const first = { userId: 7, profile: 'shared' }

    await expect(service.createTab(first, 'about:blank')).rejects.toThrow('rollback release is unconfirmed')
    await expect(service.createTab({ userId: 8, profile: 'shared' }, 'about:blank')).rejects.toThrow('already assigned')
    expect(starts).toBe(1)

    await expect(service.createTab(first, 'about:blank')).rejects.toThrow('Managed Browser runtime connection failed')
    expect(releaseAttempts).toBe(2)
    expect(starts).toBe(2)
  })

  it.each([
    {
      name: 'CDP connect failure',
      chromium: () => ({ connectOverCDP: vi.fn(async () => { throw new Error('connect failed') }) }),
      expectedBrowserClose: 0,
    },
    {
      name: 'missing browser context',
      chromium: (browser: any) => ({ connectOverCDP: vi.fn(async () => browser) }),
      contexts: [],
      expectedBrowserClose: 1,
    },
    {
      name: 'session initialize failure',
      chromium: (browser: any) => ({ connectOverCDP: vi.fn(async () => browser) }),
      pages: [{}],
      failTracking: true,
      expectedBrowserClose: 1,
    },
  ])('rolls back the exact runtime session after $name', async testCase => {
    const requests: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push(`${init?.method || 'GET'} ${url.pathname}`)
      if (url.pathname === '/v1/sessions') {
        return new Response(JSON.stringify({ id: 'orphan-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.pathname === '/v1/sessions/orphan-session/release') {
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    const browser = {
      contexts: vi.fn(() => testCase.contexts ?? [{
        pages: vi.fn(() => testCase.pages ?? []),
        newCDPSession: vi.fn(async () => {
          if (testCase.failTracking) throw new Error('track failed')
          return { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
        }),
        on: vi.fn(),
      }]),
      close: vi.fn(async () => undefined),
    }
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: testCase.chromium(browser) as any,
      fetchImpl: fetchImpl as any,
    })

    await expect(adapter.startSession({ ownerKey: '7:work', profile: 'work' })).rejects.toThrow()
    expect(requests).toEqual(['POST /v1/sessions', 'POST /v1/sessions/orphan-session/release'])
    expect(browser.close).toHaveBeenCalledTimes(testCase.expectedBrowserClose)
  })

  it('terminates an isolated in-flight interaction before cancellation returns', async () => {
    const page = {
      url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), isClosed: vi.fn(() => false),
      locator: vi.fn((selector: string) => selector === 'a,button,input,textarea,select,[role],[tabindex]'
        ? {
            evaluateAll: vi.fn()
              .mockResolvedValueOnce([{ ref: '@e1', role: 'button', name: 'Submit', selector: '[data-hermes-browser-ref="1"]' }])
              .mockResolvedValueOnce(undefined),
          }
        : { click: vi.fn(async () => undefined), fill: vi.fn(async () => undefined) }),
    }
    const cdp = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn(async () => cdp), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    let rejectInteraction!: (error: Error) => void
    const cancel = vi.fn(async () => rejectInteraction(new Error('interaction executor terminated')))
    const interactionExecutor = {
      execute: vi.fn(() => ({
        result: new Promise<void>((_resolve, reject) => { rejectInteraction = reject }),
        cancel,
      })),
    }
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/sessions') return new Response(JSON.stringify({ id: 'cancel-session', websocketUrl: 'ws://127.0.0.1:3000/cdp' }), { status: 200 })
      if (path === '/v1/sessions/cancel-session/release') return new Response('{}', { status: 200 })
      return new Response('{}', { status: 404 })
    })
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: fetchImpl as any,
      interactionExecutor,
    } as any)
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const snapshot = await session.snapshot('page-1') as { snapshotId: string }
    const interaction = session.interact('page-1', { action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1' })

    await vi.waitFor(() => expect(interactionExecutor.execute).toHaveBeenCalledOnce())
    await session.cancelAgentOperation('page-1')
    await expect(interaction).rejects.toThrow('terminated')
    expect(cancel).toHaveBeenCalledOnce()
    await session.release()
  })

  it('rejects mixed or public runtime DNS answers before starting egress, reading credentials, or sending HTTP', async () => {
    const fetchImpl = vi.fn()
    const egressProxy = { start: vi.fn(), close: vi.fn() }
    const apiTokenProvider = vi.fn()
    const resolveHost = vi.fn(async () => [
      { address: '172.20.0.9', family: 4 },
      { address: '203.0.113.44', family: 4 },
    ])
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://runtime.internal:3000',
      fetchImpl: fetchImpl as any,
      egressProxy,
      apiTokenProvider,
      resolveHost,
    })

    await expect(adapter.startSession({ ownerKey: '7:work', profile: 'work' })).rejects.toThrow('private')
    expect(resolveHost).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(egressProxy.start).not.toHaveBeenCalled()
    expect(apiTokenProvider).not.toHaveBeenCalled()
  })

  it.each([
    ['IPv4 link-local', [{ address: '169.254.169.254', family: 4 }]],
    ['CGNAT', [{ address: '100.64.0.7', family: 4 }]],
    ['IPv6 link-local mixed with private IPv4', [
      { address: '172.20.0.9', family: 4 },
      { address: 'fe80::1', family: 6 },
    ]],
  ])('rejects %s runtime DNS answers before any credential-bearing side effect', async (_label, answers) => {
    const fetchImpl = vi.fn()
    const egressProxy = { start: vi.fn(), close: vi.fn() }
    const apiTokenProvider = vi.fn()
    const resolveHost = vi.fn(async () => answers)
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://runtime.internal:3000',
      fetchImpl: fetchImpl as any,
      egressProxy,
      apiTokenProvider,
      resolveHost,
    })

    await expect(adapter.startSession({ ownerKey: '7:work', profile: 'work' })).rejects.toThrow('private')
    expect(resolveHost).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(egressProxy.start).not.toHaveBeenCalled()
    expect(apiTokenProvider).not.toHaveBeenCalled()
  })

  it('pins one private IPv4 for HTTP, CDP, live view, and release without a second DNS lookup', async () => {
    const page = {
      url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), isClosed: vi.fn(() => false),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => []) })),
      on: vi.fn(),
    }
    const cdp = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn(async () => cdp), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const chromium = { connectOverCDP: vi.fn(async () => browser) }
    const interactionExecutor = { execute: vi.fn(() => ({ result: Promise.resolve(), cancel: vi.fn(async () => undefined) })) }
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.hostname).toBe('172.20.0.9')
      expect(new Headers(init?.headers).get('Host')).toBe('browser-runtime:3000')
      return url.pathname === '/v1/sessions'
        ? new Response(JSON.stringify({ id: 'dns-session', websocketUrl: 'ws://0.0.0.0:3000/cdp?session=dns-session' }), { status: 200 })
        : new Response('{}', { status: 200 })
    })
    const resolveHost = vi.fn(async (hostname: string) => hostname === 'browser-runtime'
      ? [{ address: '172.20.0.9', family: 4 }]
      : [])
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://browser-runtime:3000',
      chromium: chromium as any,
      fetchImpl: fetchImpl as any,
      interactionExecutor,
      resolveHost,
    })

    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    expect(resolveHost).toHaveBeenCalledOnce()
    expect(resolveHost).toHaveBeenCalledWith('browser-runtime')
    expect(chromium.connectOverCDP).toHaveBeenCalledWith(
      'ws://172.20.0.9:3000/cdp?session=dns-session',
      expect.any(Object),
    )
    await session.interact('page-1', { action: 'press', key: 'ArrowDown' })
    expect(interactionExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'ws://172.20.0.9:3000/cdp?session=dns-session',
      pageId: 'page-1',
    }))
    await session.release()
  })

  it('streams the tracked page through CDP and dispatches takeover input without an external live-view URL', async () => {
    const page = {
      isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), on: vi.fn(),
    }
    const trackingSession = {
      send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })),
      detach: vi.fn(async () => undefined),
    }
    let screencastFrame: ((event: any) => void) | undefined
    const viewSession = {
      send: vi.fn(async () => ({})),
      on: vi.fn((event: string, listener: (payload: any) => void) => {
        if (event === 'Page.screencastFrame') screencastFrame = listener
      }),
      off: vi.fn(),
      detach: vi.fn(async () => undefined),
    }
    const context = {
      pages: vi.fn(() => [page]),
      newCDPSession: vi.fn()
        .mockResolvedValueOnce(trackingSession)
        .mockResolvedValueOnce(viewSession),
      on: vi.fn(),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const fetchImpl = vi.fn(async (input: string | URL) => new URL(String(input)).pathname === '/v1/sessions'
      ? new Response(JSON.stringify({ id: 'view-session', websocketUrl: 'ws://127.0.0.1:3000/' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: fetchImpl as any,
    })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const frames: any[] = []
    const view = await session.openLiveView?.('page-1', frame => frames.push(frame))

    expect(view).toBeDefined()
    expect(viewSession.send).toHaveBeenNthCalledWith(1, 'Page.enable')
    expect(viewSession.send).toHaveBeenNthCalledWith(2, 'Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 })
    screencastFrame?.({ data: 'jpeg-base64', sessionId: 42, metadata: { deviceWidth: 1280, deviceHeight: 720 } })
    await vi.waitFor(() => expect(viewSession.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 42 }))
    expect(frames).toEqual([{ data: 'jpeg-base64', metadata: { deviceWidth: 1280, deviceHeight: 720 } }])

    await view!.dispatch({ type: 'mouseEvent', event: { type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1 } })
    await view!.dispatch({ type: 'keyEvent', event: { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' } })
    await view!.dispatch({ type: 'keyEvent', event: { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, text: '' } })
    expect(viewSession.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 12, y: 34, button: 'left' }))
    expect(viewSession.send).toHaveBeenCalledWith('Input.insertText', { text: 'a' })
    expect(viewSession.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'a', code: 'KeyA' }))

    await view!.close()
    expect(viewSession.send).toHaveBeenCalledWith('Page.stopScreencast')
    expect(viewSession.off).toHaveBeenCalledWith('Page.screencastFrame', screencastFrame)
    expect(viewSession.detach).toHaveBeenCalledOnce()
    await session.release()
  })

  it('acks a valid screencast frame even when the downstream frame sink throws', async () => {
    const page = { isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), on: vi.fn() }
    const trackingSession = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    let screencastFrame: ((event: any) => void) | undefined
    const viewSession = {
      send: vi.fn(async () => ({})),
      on: vi.fn((event: string, listener: (payload: any) => void) => { if (event === 'Page.screencastFrame') screencastFrame = listener }),
      off: vi.fn(), detach: vi.fn(async () => undefined),
    }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn().mockResolvedValueOnce(trackingSession).mockResolvedValueOnce(viewSession), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000', chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: 'ack-session', websocketUrl: 'ws://127.0.0.1:3000/' }), { status: 200 })) as any,
    })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const view = await session.openLiveView?.('page-1', () => { throw new Error('closed viewer') })
    expect(() => screencastFrame?.({ data: 'jpeg-base64', sessionId: 77, metadata: { deviceWidth: 800, deviceHeight: 600 } })).not.toThrow()
    await vi.waitFor(() => expect(viewSession.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 77 }))
    await view?.close()
    await session.release()
  })

  it('acks but drops an oversized screencast frame at the Runtime trust boundary', async () => {
    const page = { isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), on: vi.fn() }
    const trackingSession = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    let screencastFrame: ((event: any) => void) | undefined
    const viewSession = {
      send: vi.fn(async () => ({})),
      on: vi.fn((event: string, listener: (payload: any) => void) => { if (event === 'Page.screencastFrame') screencastFrame = listener }),
      off: vi.fn(), detach: vi.fn(async () => undefined),
    }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn().mockResolvedValueOnce(trackingSession).mockResolvedValueOnce(viewSession), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000', chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: 'oversized-frame-session', websocketUrl: 'ws://127.0.0.1:3000/' }), { status: 200 })) as any,
    })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const frames: unknown[] = []
    const view = await session.openLiveView?.('page-1', frame => frames.push(frame))

    screencastFrame?.({ data: 'A'.repeat(12 * 1024 * 1024), sessionId: 88 })
    await vi.waitFor(() => expect(viewSession.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 88 }))
    expect(frames).toEqual([])
    await view?.close()
    await session.release()
  })

  it('rejects malformed or oversized viewer input instead of coercing or truncating it', async () => {
    const page = { isClosed: vi.fn(() => false), url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), on: vi.fn() }
    const trackingSession = { send: vi.fn(async () => ({ targetInfo: { targetId: 'page-1' } })), detach: vi.fn(async () => undefined) }
    const viewSession = { send: vi.fn(async () => ({})), on: vi.fn(), off: vi.fn(), detach: vi.fn(async () => undefined) }
    const context = { pages: vi.fn(() => [page]), newCDPSession: vi.fn().mockResolvedValueOnce(trackingSession).mockResolvedValueOnce(viewSession), on: vi.fn() }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000', chromium: { connectOverCDP: vi.fn(async () => browser) } as any,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: 'input-session', websocketUrl: 'ws://127.0.0.1:3000/' }), { status: 200 })) as any,
    })
    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    const view = await session.openLiveView?.('page-1', () => undefined)
    await expect(view!.dispatch({ type: 'mouseEvent', event: { type: 'mouseMoved', x: Number.NaN, y: 1 } })).rejects.toThrow('coordinates')
    await expect(view!.dispatch({ type: 'mouseEvent', event: { type: 'mouseWheel', x: 1, y: 1, deltaY: Number.POSITIVE_INFINITY } })).rejects.toThrow('delta')
    await expect(view!.dispatch({ type: 'insertText', text: 'x'.repeat(10_001) })).rejects.toThrow('too large')
    await expect(view!.dispatch({ type: 'Runtime.evaluate', expression: '1+1' })).rejects.toThrow('Unsupported')
    expect(viewSession.send).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
    expect(viewSession.send).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
    await view?.close()
    await session.release()
  })

  it('does not expose runtime diagnostics that echo the authenticated egress proxy', async () => {
    const marker = 'runtime-proxy-password-marker'
    const egressProxy = { start: vi.fn(async () => `http://runtime-user:${marker}@studio.internal:43123`), close: vi.fn(async () => undefined) }
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      egressProxy,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ message: `cannot use http://runtime-user:${marker}@studio.internal:43123` }), { status: 400 })) as any,
    })
    let error: unknown
    try {
      await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toBe('Managed Browser session failed with HTTP 400')
    expect(String((error as Error).message)).not.toContain(marker)
  })

  it('does not expose a Runtime CDP ticket when the connector fails', async () => {
    const marker = 'opaque-cdp-ticket-SECRET-MARKER'
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'sensitive-session', websocketUrl: `ws://127.0.0.1:3000/cdp?ticket=${marker}` }), { status: 200 })
      }
      if (url.endsWith('/v1/sessions/sensitive-session/release') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: fetchImpl as any,
      chromium: {
        connectOverCDP: vi.fn(async (endpoint: string) => {
          throw new Error(`connect failed at ${endpoint}`)
        }),
      } as any,
    })

    let error: unknown
    try {
      await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toBe('Managed Browser runtime connection failed')
    expect(String((error as Error).message)).not.toContain(marker)
  })

  it('creates and releases one pinned runtime session without exposing upstream URLs', async () => {
    const requests: Array<{ url: string; method: string; authorization: string; body: unknown }> = []
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bodyText = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: request.url || '', method: request.method || '', authorization: String(request.headers.authorization || ''), body: bodyText ? JSON.parse(bodyText) : null })
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'POST' && request.url === '/v1/sessions') {
        response.end(JSON.stringify({
          id: 'runtime-session-1',
          status: 'live',
          websocketUrl: `ws://0.0.0.0:${(server!.address() as any).port}/devtools/browser/runtime-session-1?ticket=cdp`,
        }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/runtime-session-1/release') {
        response.end(JSON.stringify({ success: true }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server not listening')

    const page = {
      url: vi.fn(() => 'about:blank'), title: vi.fn(async () => 'Blank'), isClosed: vi.fn(() => false),
      goto: vi.fn(async () => null), close: vi.fn(async () => undefined), bringToFront: vi.fn(async () => undefined),
      goBack: vi.fn(async () => null), goForward: vi.fn(async () => null), reload: vi.fn(async () => null),
      screenshot: vi.fn(async () => Buffer.from([0])), viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
      locator: vi.fn((selector: string) => selector === 'a,button,input,textarea,select,[role],[tabindex]'
        ? {
            evaluateAll: vi.fn()
              .mockResolvedValueOnce([{ ref: '@e1', role: 'button', name: 'First', selector: '[data-hermes-browser-ref="1"]' }])
              .mockResolvedValueOnce(undefined)
              .mockResolvedValueOnce([{ ref: '@e1', role: 'button', name: 'Second', selector: '[data-hermes-browser-ref="1"]' }])
              .mockResolvedValueOnce(undefined),
          }
        : { evaluate: vi.fn(async () => 'Example text'), click: vi.fn(), fill: vi.fn() }),
      keyboard: { press: vi.fn(), type: vi.fn() }, mouse: { wheel: vi.fn() },
      on: vi.fn(), removeAllListeners: vi.fn(),
    }
    const cdpSend = vi.fn(async (method: string) => method === 'Page.getNavigationHistory'
      ? { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] }
      : { targetInfo: { targetId: 'page-1' } })
    const context = {
      pages: vi.fn(() => [page]), newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({
        send: cdpSend,
        detach: vi.fn(async () => undefined),
      })),
    }
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) }
    const chromium = { connectOverCDP: vi.fn(async () => browser) }
    const egressProxy = { start: vi.fn(async () => 'http://runtime-user:runtime-token@studio.internal:43123'), close: vi.fn(async () => undefined) }
    const adapter = new HttpBrowserRuntimeAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      chromium: chromium as any,
      egressProxy,
      apiTokenProvider: async () => 'runtime-service-token-that-is-at-least-32-characters',
    })

    const session = await adapter.startSession({ ownerKey: '7:work', profile: 'work' })
    expect(session.id).toBe('runtime-session-1')
    expect(chromium.connectOverCDP).toHaveBeenCalledWith(
      `ws://127.0.0.1:${address.port}/devtools/browser/runtime-session-1?ticket=cdp`,
      expect.objectContaining({ headers: { Authorization: 'Bearer runtime-service-token-that-is-at-least-32-characters' } }),
    )
    expect(requests[0]).toMatchObject({
      url: '/v1/sessions',
      method: 'POST',
      authorization: 'Bearer runtime-service-token-that-is-at-least-32-characters',
      body: {
        sessionId: expect.any(String),
        proxyUrl: 'http://runtime-user:runtime-token@studio.internal:43123',
      },
    })
    expect(requests[0].body).not.toHaveProperty('ownerKey')
    expect(requests[0].body).not.toHaveProperty('profile')
    expect(requests[0].body).not.toHaveProperty('egressProxyUrl')
    await expect(session.listPages()).resolves.toEqual([expect.objectContaining({ canGoBack: true, canGoForward: true })])
    const firstSnapshot = await session.snapshot('page-1') as { snapshotId: string }
    const secondSnapshot = await session.snapshot('page-1') as { snapshotId: string }
    await expect(session.readText('page-1', { snapshot_id: firstSnapshot.snapshotId, ref: '@e1' })).rejects.toThrow('stale')
    await expect(session.readText('page-1', { snapshot_id: secondSnapshot.snapshotId, ref: '@e1' })).resolves.toMatchObject({ snapshotId: secondSnapshot.snapshotId })
    await expect(session.interact('page-1', { action: 'click', snapshot_id: firstSnapshot.snapshotId, ref: '@e1' })).rejects.toThrow('stale')
    await session.cancelAgentOperation('page-1')

    await session.release()
    expect(browser.close).toHaveBeenCalledOnce()
    expect(requests[1]).toMatchObject({ url: '/v1/sessions/runtime-session-1/release', method: 'POST', authorization: 'Bearer runtime-service-token-that-is-at-least-32-characters' })
    await adapter.shutdown()
    expect(egressProxy.close).toHaveBeenCalledOnce()
  })
})
